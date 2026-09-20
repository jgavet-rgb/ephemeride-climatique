"""Extrait des citations candidates depuis les archives brutes de data-sources/ (DATA_FORMATS.md, section 4).

Usage :
    python3 scripts/quotes_candidates.py [--sources data-sources] [--out data/quotes.candidates.jsonl]
                                         [--existing data/quotes.jsonl] [--per-day 5] [--min-length 40]
                                         [--report-only]

Chaque sous-dossier ``trump/`` et ``musk/`` contient des exports CSV, JSON ou JSONL dont les
colonnes sont detectees heuristiquement. Les retweets, textes trop courts, textes sans contenu
et quasi-doublons sont ecartes ; les ``--per-day`` meilleures publications par auteur et par
jour calendaire MM-JJ sont ecrites, non verifiees, sans contexte ni traduction inventes.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

import common
import candidates_core as core

DEFAULT_SOURCES = "data-sources"
DEFAULT_EXISTING = "data/quotes.jsonl"
DEFAULT_OUT = "data/quotes.candidates.jsonl"
AUTHORS = ("trump", "musk")
EXTENSIONS = {".csv", ".json", ".jsonl", ".ndjson"}
MAX_MISSING_SHOWN = 40

csv.field_size_limit(min(sys.maxsize, 2 ** 31 - 1))


def iter_records(path: Path) -> Iterable[Dict[str, Any]]:
    """Enregistrements bruts d'un fichier CSV, JSON (liste ou objet contenant une liste) ou JSONL."""
    suffix = path.suffix.lower()
    if suffix == ".csv":
        with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as handle:
            for record in csv.DictReader(handle):
                yield {key: value for key, value in record.items() if key is not None}
        return
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    stripped = text.lstrip()
    if suffix == ".json" and stripped.startswith(("[", "{")):
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            data = None
        if data is not None:
            if isinstance(data, dict):
                records = next((value for value in data.values() if isinstance(value, list)), [])
            else:
                records = data
            for record in records:
                if isinstance(record, dict):
                    yield core.flatten_record(record)
            return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict):
            yield core.flatten_record(record)


def read_author_rows(folder: Path, author: str, stats: Dict[str, int]) -> List[Dict[str, Any]]:
    """Lignes normalisees de tous les fichiers d'un auteur (colonnes detectees par fichier)."""
    rows: List[Dict[str, Any]] = []
    files = sorted(path for path in folder.rglob("*") if path.is_file() and path.suffix.lower() in EXTENSIONS)
    for path in files:
        stats["fichiers"] += 1
        records = list(iter_records(path))
        if not records:
            common.warn(f"{author} : {path} ne contient aucun enregistrement")
            continue
        fieldnames: List[str] = []
        for record in records:
            for key in record:
                if key not in fieldnames:
                    fieldnames.append(key)
        columns = core.detect_columns(fieldnames)
        if not columns["text"] or not columns["date"]:
            common.warn(f"{author} : {path} ignore (colonne texte ou date introuvable parmi {fieldnames[:12]})")
            continue
        common.info(f"{author} : {path.name} : {len(records)} lignes, colonnes "
                    + ", ".join(f"{role}={name}" for role, name in columns.items() if name))
        for record in records:
            rows.append(core.extract_row(record, columns, author))
        stats["lignes"] += len(records)
    return rows


def filter_rows(rows: List[Dict[str, Any]], min_length: int, stats: Dict[str, int]) -> List[Dict[str, Any]]:
    kept = []
    for row in rows:
        reason = core.filter_reason(row, min_length)
        if reason:
            stats[reason] += 1
        else:
            kept.append(row)
    return kept


def load_existing(path: Path) -> Tuple[Dict[str, List[str]], List[str]]:
    """Textes existants par auteur et identifiants deja utilises dans data/quotes.jsonl."""
    texts: Dict[str, List[str]] = {}
    ids: List[str] = []
    if not path.is_file():
        common.info(f"pas de fichier existant {path} : dedoublonnage sur les seuls candidats")
        return texts, ids
    for entry in common.read_jsonl(path):
        if not isinstance(entry, dict):
            continue
        author = entry.get("author")
        text = entry.get("text")
        if isinstance(author, str) and isinstance(text, str):
            texts.setdefault(author, []).append(text)
        if isinstance(entry.get("id"), str):
            ids.append(entry["id"])
    return texts, ids


def print_report(entries: List[Dict[str, Any]], stats_by_author: Dict[str, Dict[str, int]]) -> None:
    """Rapport de couverture en francais sur la sortie standard."""
    coverage = core.coverage([{"author": e["author"], "date": e["date"]} for e in entries])
    for author in AUTHORS:
        stats = stats_by_author.get(author, {})
        print(f"{author} : {stats.get('fichiers', 0)} fichier(s), {stats.get('lignes', 0)} lignes lues, "
              f"{stats.get('retweet', 0)} retweets, {stats.get('sans_date', 0)} sans date, "
              f"{stats.get('sans_contenu', 0)} sans contenu, {stats.get('trop_court', 0)} trop courts, "
              f"{stats.get('trop_long', 0)} trop longs, {stats.get('doublons', 0)} quasi-doublons, "
              f"{stats.get('retenus', 0)} retenus, {stats.get('candidats', 0)} candidats")
        report = coverage.get(author)
        if report is None:
            print(f"{author} : 0/{len(common.KEYS)} jours MM-JJ couverts")
            continue
        missing = report["missing"]
        shown = ", ".join(missing[:MAX_MISSING_SHOWN]) + (", ..." if len(missing) > MAX_MISSING_SHOWN else "")
        print(f"{author} : {report['covered']}/{len(common.KEYS)} jours MM-JJ couverts ; manquants ({len(missing)})"
              + (f" : {shown}" if missing else ""))


def build_parser() -> argparse.ArgumentParser:
    parser = common.make_parser("Selectionne des citations candidates depuis les archives brutes de data-sources/.")
    parser.add_argument("--sources", default=DEFAULT_SOURCES,
                        help="dossier des archives, avec sous-dossiers trump/ et musk/ (defaut : %(default)s)")
    parser.add_argument("--existing", default=DEFAULT_EXISTING,
                        help="base de citations existante pour le dedoublonnage (defaut : %(default)s)")
    parser.add_argument("--out", default=DEFAULT_OUT, help="fichier JSONL de sortie (defaut : %(default)s)")
    parser.add_argument("--per-day", type=int, default=core.DEFAULT_PER_DAY,
                        help="candidats conserves par auteur et par jour MM-JJ (defaut : %(default)s)")
    parser.add_argument("--min-length", type=int, default=core.DEFAULT_MIN_LENGTH,
                        help="longueur minimale du texte sans URL (defaut : %(default)s)")
    parser.add_argument("--report-only", action="store_true", help="afficher le rapport sans ecrire la sortie")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    sources = Path(args.sources)
    if not sources.is_dir():
        common.error(f"dossier des archives introuvable : {sources} (deposer les exports dans {sources}/trump et {sources}/musk)")
        return 1
    if args.per_day < 1:
        common.error("--per-day doit valoir au moins 1")
        return 2
    try:
        existing_texts, existing_ids = load_existing(Path(args.existing))
    except common.JsonlError as exc:
        common.error(str(exc))
        return 1

    today = common.iso_today_utc()
    selected: List[Dict[str, Any]] = []
    stats_by_author: Dict[str, Dict[str, int]] = {}
    for author in AUTHORS:
        stats = {key: 0 for key in ("fichiers", "lignes", "retweet", "sans_date", "sans_contenu",
                                    "trop_court", "trop_long", "doublons", "retenus", "candidats")}
        stats_by_author[author] = stats
        folder = sources / author
        if not folder.is_dir():
            common.warn(f"{author} : dossier {folder} absent")
            continue
        rows = read_author_rows(folder, author, stats)
        rows = filter_rows(rows, args.min_length, stats)
        rows.sort(key=core.sort_key)
        kept = core.dedup_indices([row["text"] for row in rows], existing_texts.get(author, ()))
        stats["doublons"] = len(rows) - len(kept)
        rows = [rows[index] for index in kept]
        stats["retenus"] = len(rows)
        core.score_rows(rows)
        chosen = core.select_per_day(rows, args.per_day)
        stats["candidats"] = len(chosen)
        selected.extend(chosen)

    entries = core.number_entries(selected, today, existing_ids)
    print_report(entries, stats_by_author)
    if args.report_only:
        print(f"{len(entries)} candidats (rapport seul, rien d'ecrit)")
        return 0
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(f"# Candidats produits par scripts/quotes_candidates.py le {today} ; "
                     "fichier jamais charge par l'application, a verifier a la main avant copie dans quotes.jsonl\n")
        for entry in entries:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    print(f"{len(entries)} candidats ecrits dans {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
