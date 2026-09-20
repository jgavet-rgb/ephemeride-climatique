"""Coeur pur de la selection de citations candidates (detection des colonnes, normalisation,
dedoublonnage, score, selection). Aucune entree-sortie : voir ``quotes_candidates.py``.

Le dedoublonnage repose sur des shingles de 3 mots apres normalisation (minuscules, sans
URL, mentions ni ponctuation) et l'indice de Jaccard. Un filtre par prefixe (ordre global des
shingles du plus rare au plus frequent) evite la comparaison de toutes les paires sans
perdre aucune paire au-dessus du seuil.
"""

from __future__ import annotations

import datetime as dt
import html
import math
import re
from collections import Counter
from typing import Any, Dict, FrozenSet, Iterable, List, Optional, Sequence, Tuple

from common import KEYS

SHINGLE_SIZE = 3
DEDUP_THRESHOLD = 0.8
DEFAULT_MIN_LENGTH = 40
DEFAULT_PER_DAY = 5
MAX_TEXT_LENGTH = 1000  # maxLength of ``text`` in the JSON schema
X_RENAME_DATE = "2023-07-24"  # from this date on the medium is ``x``
HANDLES = {"trump": "realDonaldTrump", "musk": "elonmusk"}

# Role -> accepted column names (lower case), in order of preference.
COLUMN_ALIASES: Dict[str, Tuple[str, ...]] = {
    "id": ("id_str", "id", "tweet_id", "status_id"),
    "text": ("full_text", "text", "tweet", "content"),
    "date": ("created_at", "date", "timestamp", "time"),
    "favorites": ("favorites", "favorite_count", "likes", "likecount", "like_count",
                  "favourites", "favourite_count"),
    "retweets": ("retweets", "retweet_count", "retweetcount"),
    "is_retweet": ("isretweet", "is_retweet", "retweeted"),
}
TRUE_VALUES = {"1", "true", "t", "yes", "y", "vrai", "oui"}

URL_RE = re.compile(r"(?:https?://|www\.)\S+", re.IGNORECASE)
MENTION_RE = re.compile(r"@\w+")
HASHTAG_RE = re.compile(r"#\w+")
NON_WORD_RE = re.compile(r"[^\w\s]")
SPACES_RE = re.compile(r"\s+")
DIGITS_RE = re.compile(r"^\d+$")
ISO_PREFIX_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")

Shingles = FrozenSet[tuple]


# --------------------------------------------------------------------------- columns

def detect_columns(fieldnames: Iterable[str]) -> Dict[str, Optional[str]]:
    """Associe chaque role (id, text, date, favorites, retweets, is_retweet) a une colonne ou None."""
    lower: Dict[str, str] = {}
    for name in fieldnames:
        if not isinstance(name, str):
            continue
        key = name.strip().lower()
        lower.setdefault(key, name)
    detected: Dict[str, Optional[str]] = {}
    for role, aliases in COLUMN_ALIASES.items():
        detected[role] = None
        for alias in aliases:
            if alias in lower:
                detected[role] = lower[alias]
                break
    return detected


def flatten_record(record: Dict[str, Any]) -> Dict[str, Any]:
    """Aplatit un niveau d'objets imbriques (``public_metrics.like_count`` -> ``like_count``)."""
    flat: Dict[str, Any] = {}
    for key, value in record.items():
        if isinstance(value, dict):
            for sub_key, sub_value in value.items():
                flat.setdefault(f"{key}.{sub_key}", sub_value)
                if not isinstance(sub_value, (dict, list)):
                    flat.setdefault(str(sub_key), sub_value)
        else:
            flat[str(key)] = value
    return flat


# --------------------------------------------------------------------------- field parsing

def parse_date(value: Any) -> Optional[str]:
    """Date civile AAAA-MM-JJ depuis ISO, ``Fri Dec 06 20:31:11 +0000 2019``, ``AAAA-MM-JJ hh:mm:ss``, epoch..."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return _from_epoch(float(value))
    text = str(value).strip()
    if not text:
        return None
    if DIGITS_RE.match(text):
        return _from_epoch(float(text))
    iso_text = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        return dt.datetime.fromisoformat(iso_text).date().isoformat()
    except ValueError:
        pass
    for fmt in ("%a %b %d %H:%M:%S %z %Y", "%a %b %d %H:%M:%S %Y", "%Y-%m-%d %H:%M",
                "%Y/%m/%d %H:%M:%S", "%Y/%m/%d", "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M",
                "%m/%d/%Y", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y"):
        try:
            return dt.datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    match = ISO_PREFIX_RE.match(text)
    if match:
        try:
            return dt.date(int(match.group(1)), int(match.group(2)), int(match.group(3))).isoformat()
        except ValueError:
            return None
    return None


def _from_epoch(number: float) -> Optional[str]:
    if number > 1e11:  # milliseconds
        number /= 1000.0
    try:
        return dt.datetime.fromtimestamp(number, tz=dt.timezone.utc).date().isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def parse_count(value: Any) -> Optional[int]:
    """Compteur d'engagement (favoris, repartages) ; None si la valeur est absente ou illisible."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip().replace(",", "").replace(" ", "")
    if not text:
        return None
    try:
        return int(float(text))
    except ValueError:
        return None


def parse_flag(value: Any) -> bool:
    """Interprete un drapeau (booleen, 0/1, true/false, yes/no)."""
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() in TRUE_VALUES


def parse_status_id(value: Any) -> Optional[str]:
    """Identifiant numerique du statut sous forme de texte, None si absent ou non numerique."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else None
    text = str(value).strip()
    if text.endswith(".0"):
        text = text[:-2]
    return text if DIGITS_RE.match(text) else None


def extract_row(record: Dict[str, Any], columns: Dict[str, Optional[str]], author: str) -> Dict[str, Any]:
    """Ligne normalisee : author, id, text, date, favorites, retweets, is_retweet, has_engagement."""
    def get(role: str) -> Any:
        column = columns.get(role)
        return record.get(column) if column else None

    raw_text = get("text")
    text = "" if raw_text is None else str(raw_text).strip()
    favorites = parse_count(get("favorites")) if columns.get("favorites") else None
    retweets = parse_count(get("retweets")) if columns.get("retweets") else None
    has_engagement = bool(columns.get("favorites") or columns.get("retweets"))
    return {
        "author": author,
        "id": parse_status_id(get("id")),
        "text": text,
        "date": parse_date(get("date")),
        "favorites": favorites,
        "retweets": retweets,
        "is_retweet": parse_flag(get("is_retweet")) or text.startswith("RT @"),
        "has_engagement": has_engagement,
    }


# --------------------------------------------------------------------------- text filters

def strip_urls(text: str) -> str:
    """Texte sans URL, espaces normalises."""
    return SPACES_RE.sub(" ", URL_RE.sub(" ", text)).strip()


def is_substantive(text: str) -> bool:
    """Faux si le texte ne contient que des URL, des mentions, des mots-dieses ou de la ponctuation."""
    remainder = HASHTAG_RE.sub(" ", MENTION_RE.sub(" ", URL_RE.sub(" ", text)))
    return re.search(r"\w", remainder) is not None


def filter_reason(row: Dict[str, Any], min_length: int = DEFAULT_MIN_LENGTH) -> Optional[str]:
    """Raison d'exclusion d'une ligne (retweet, sans_date, trop_court, sans_contenu, trop_long) ou None."""
    if row["is_retweet"]:
        return "retweet"
    if not row["date"]:
        return "sans_date"
    text = row["text"]
    if not is_substantive(text):
        return "sans_contenu"
    if len(strip_urls(text)) < min_length:
        return "trop_court"
    if len(text) > MAX_TEXT_LENGTH:
        return "trop_long"
    return None


# --------------------------------------------------------------------------- normalization / dedup

def normalize_text(text: str) -> str:
    """Minuscules, entites HTML decodees, sans URL, mentions ni ponctuation, espaces simples."""
    lowered = html.unescape(text).lower()
    lowered = URL_RE.sub(" ", lowered)
    lowered = MENTION_RE.sub(" ", lowered)
    lowered = NON_WORD_RE.sub(" ", lowered).replace("_", " ")
    return SPACES_RE.sub(" ", lowered).strip()


def shingles(normalized: str, size: int = SHINGLE_SIZE) -> Shingles:
    """Ensemble des shingles de ``size`` mots (le texte entier si moins de ``size`` mots)."""
    words = normalized.split()
    if not words:
        return frozenset()
    if len(words) <= size:
        return frozenset([tuple(words)])
    return frozenset(tuple(words[i:i + size]) for i in range(len(words) - size + 1))


def jaccard(left: Shingles, right: Shingles) -> float:
    """Indice de Jaccard ; deux ensembles vides sont consideres identiques."""
    if not left and not right:
        return 1.0
    union = len(left | right)
    return len(left & right) / union if union else 0.0


class ShingleIndex:
    """Index inverse sur le prefixe des shingles (filtre par prefixe, sans faux negatif)."""

    def __init__(self, all_sets: Sequence[Shingles], threshold: float):
        self.threshold = threshold
        frequency: Counter = Counter()
        for shingle_set in all_sets:
            frequency.update(shingle_set)
        ordered = sorted(frequency, key=lambda shingle: (frequency[shingle], shingle))
        self.rank = {shingle: position for position, shingle in enumerate(ordered)}
        self.postings: Dict[tuple, List[int]] = {}
        self.sets: Dict[int, Shingles] = {}

    def prefix(self, shingle_set: Shingles) -> List[tuple]:
        size = len(shingle_set)
        if size == 0:
            return []
        required = math.ceil(self.threshold * size - 1e-9)
        length = max(1, size - required + 1)
        return sorted(shingle_set, key=self.rank.__getitem__)[:length]

    def query(self, shingle_set: Shingles) -> List[Tuple[int, float]]:
        """Paires ``(identifiant indexe, similarite)`` au-dessus du seuil, par identifiant croissant."""
        candidates = set()
        for shingle in self.prefix(shingle_set):
            candidates.update(self.postings.get(shingle, ()))
        matches = []
        for item in sorted(candidates):
            similarity = jaccard(shingle_set, self.sets[item])
            if similarity >= self.threshold:
                matches.append((item, similarity))
        return matches

    def add(self, item: int, shingle_set: Shingles) -> None:
        self.sets[item] = shingle_set
        for shingle in self.prefix(shingle_set):
            self.postings.setdefault(shingle, []).append(item)


def find_near_duplicates(texts: Sequence[str], threshold: float = DEDUP_THRESHOLD,
                         size: int = SHINGLE_SIZE) -> List[Tuple[int, int, float]]:
    """Toutes les paires ``(i, j, similarite)`` avec i < j et Jaccard >= seuil."""
    sets = [shingles(normalize_text(text), size) for text in texts]
    index = ShingleIndex(sets, threshold)
    pairs = []
    for position, shingle_set in enumerate(sets):
        if shingle_set:
            for other, similarity in index.query(shingle_set):
                pairs.append((other, position, similarity))
            index.add(position, shingle_set)
    return pairs


def dedup_indices(texts: Sequence[str], existing_texts: Sequence[str] = (),
                  threshold: float = DEDUP_THRESHOLD, size: int = SHINGLE_SIZE) -> List[int]:
    """Indices des textes conserves : premier venu garde, quasi-doublons (aussi des textes existants) ecartes."""
    existing_sets = [shingles(normalize_text(text), size) for text in existing_texts]
    text_sets = [shingles(normalize_text(text), size) for text in texts]
    index = ShingleIndex(existing_sets + text_sets, threshold)
    for position, shingle_set in enumerate(existing_sets):
        index.add(position, shingle_set)
    kept = []
    offset = len(existing_sets)
    for position, shingle_set in enumerate(text_sets):
        if shingle_set and index.query(shingle_set):
            continue
        kept.append(position)  # a text without any shingle cannot be a duplicate of anything
        if shingle_set:
            index.add(offset + position, shingle_set)
    return kept


# --------------------------------------------------------------------------- scoring / selection

def percentile_90(values: Sequence[float]) -> float:
    """90e centile par rang le plus proche (``ceil(0.9 n)``-ieme valeur triee)."""
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = math.ceil(0.9 * len(ordered))
    return float(ordered[max(0, min(len(ordered) - 1, rank - 1))])


def engagement_metric(row: Dict[str, Any]) -> Optional[float]:
    """``favoris + 2 x repartages`` ou None si la source n'a aucune colonne d'engagement."""
    if not row.get("has_engagement"):
        return None
    return float((row.get("favorites") or 0) + 2 * (row.get("retweets") or 0))


def score_rows(rows: Sequence[Dict[str, Any]]) -> None:
    """Ajoute ``metric`` et ``score`` ; normalisation par le 90e centile de l'auteur et de l'annee."""
    by_author: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        row["metric"] = engagement_metric(row)
        by_author.setdefault(row["author"], []).append(row)
    for author_rows in by_author.values():
        if all(row["metric"] is None for row in author_rows):
            for row in author_rows:
                row["score"] = float(len(row["text"]))
            continue
        by_year: Dict[str, List[Dict[str, Any]]] = {}
        for row in author_rows:
            by_year.setdefault(row["date"][:4], []).append(row)
        for year_rows in by_year.values():
            scale = percentile_90([row["metric"] or 0.0 for row in year_rows])
            if scale <= 0:
                scale = 1.0
            for row in year_rows:
                row["score"] = (row["metric"] or 0.0) / scale


def sort_key(row: Dict[str, Any]) -> tuple:
    """Ordre chronologique stable : date, identifiant (numerique), texte."""
    status = row.get("id")
    return (row["date"], len(status) if status else 0, status or "", row["text"])


def select_per_day(rows: Sequence[Dict[str, Any]], per_day: int = DEFAULT_PER_DAY) -> List[Dict[str, Any]]:
    """Garde les ``per_day`` meilleures lignes par auteur et par cle MM-JJ (score decroissant)."""
    groups: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
    for row in rows:
        groups.setdefault((row["author"], row["date"][5:]), []).append(row)
    selected: List[Dict[str, Any]] = []
    for key in sorted(groups):
        ranked = sorted(groups[key], key=lambda row: (-row["score"],) + sort_key(row))
        selected.extend(ranked[:per_day])
    return selected


def coverage(rows: Sequence[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Par auteur : nombre de cles MM-JJ couvertes et liste des cles manquantes."""
    covered: Dict[str, set] = {}
    for row in rows:
        covered.setdefault(row["author"], set()).add(row["date"][5:])
    report = {}
    for author in sorted(covered):
        missing = [key for key in KEYS if key not in covered[author]]
        report[author] = {"covered": len(covered[author]), "missing": missing}
    return report


def make_entry(row: Dict[str, Any], sequence: int, today: str) -> Dict[str, Any]:
    """Entree JSONL conforme au schema (aucun contexte ni traduction inventes)."""
    author = row["author"]
    date = row["date"]
    handle = HANDLES.get(author, author)
    status = row.get("id")
    tags = ["candidat"]
    if status:
        source_url = f"https://x.com/{handle}/status/{status}"
    else:
        source_url = f"https://x.com/{handle}"
        tags.append("sans-identifiant")
    return {
        "id": f"{author}-{date}-{sequence:03d}",
        "author": author,
        "date": date,
        "text": row["text"],
        "lang": "en",
        "medium": "twitter" if date < X_RENAME_DATE else "x",
        "source_url": source_url,
        "source_type": "archive",
        "verified": False,
        "added": today,
        "tags": tags,
    }


def number_entries(selected: Sequence[Dict[str, Any]], today: str,
                   existing_ids: Iterable[str] = ()) -> List[Dict[str, Any]]:
    """Numerote les entrees par auteur et date (001, 002...) apres les identifiants deja pris."""
    next_sequence: Dict[Tuple[str, str], int] = {}
    for identifier in existing_ids:
        parts = identifier.rsplit("-", 1)
        if len(parts) == 2 and parts[1].isdigit():
            prefix, number = parts
            author, _, date = prefix.partition("-")
            key = (author, date)
            next_sequence[key] = max(next_sequence.get(key, 1), int(number) + 1)
    entries = []
    ordering = lambda row: (row["author"], row["date"], -float(row.get("score", 0.0))) + sort_key(row)
    for row in sorted(selected, key=ordering):
        key = (row["author"], row["date"])
        sequence = next_sequence.get(key, 1)
        next_sequence[key] = sequence + 1
        entries.append(make_entry(row, sequence, today))
    return entries
