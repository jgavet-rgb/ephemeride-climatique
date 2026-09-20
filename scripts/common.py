"""Fonctions communes aux scripts Python du projet (cles calendaires, arrondis, HTTP, JSONL).

Toutes les conventions viennent de DATA_FORMATS.md : 366 cles ``MM-JJ`` dans l'ordre
d'une annee bissextile (``02-29`` a l'index 59), arrondi ``round2`` et conversion en
dixiemes de degre ``to_tenths``.
"""

from __future__ import annotations

import argparse
import datetime as dt
import http.client
import json
import math
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterator

# Repository root: scripts/ lives directly under it.
REPO_ROOT = Path(__file__).resolve().parent.parent

USER_AGENT = "ephemeride-climatique/0.1 (+https://github.com/)"
HTTP_TIMEOUT = 60
HTTP_RETRIES = 1
HTTP_RETRY_DELAY = 2.0


def _build_keys() -> tuple:
    """Construit les 366 cles MM-JJ dans l'ordre du calendrier d'une annee bissextile."""
    keys = []
    day = dt.date(2000, 1, 1)
    while day.year == 2000:
        keys.append(day.strftime("%m-%d"))
        day += dt.timedelta(days=1)
    return tuple(keys)


KEYS = _build_keys()
KEY_INDEX = {key: index for index, key in enumerate(KEYS)}
LEAP_DAY_INDEX = KEY_INDEX["02-29"]  # 59


def key_index(mm_dd: str) -> int:
    """Retourne l'index (0..365) d'une cle MM-JJ ; ValueError si la cle est inconnue."""
    try:
        return KEY_INDEX[mm_dd]
    except KeyError:
        raise ValueError(f"cle calendaire invalide : {mm_dd!r}") from None


def round2(value: float) -> float:
    """Arrondi commun a deux decimales : floor(x * 100 + 0.5) / 100 (identique en JS)."""
    return math.floor(value * 100 + 0.5) / 100


def to_tenths(value: Any):
    """Convertit une temperature en dixiemes de degre entiers (demi vers l'exterieur), None si absente."""
    if value is None:
        return None
    number = float(value)
    if math.isnan(number):
        return None
    if number >= 0:
        return math.floor(number * 10 + 0.5)
    return -math.floor(-number * 10 + 0.5)


def iso_today_utc() -> str:
    """Date du jour en UTC, format AAAA-MM-JJ."""
    return dt.datetime.now(dt.timezone.utc).date().isoformat()


def now_utc_iso() -> str:
    """Horodatage UTC courant, format AAAA-MM-JJThh:mm:ssZ."""
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso_date(text: str) -> dt.date:
    """Analyse strictement une date AAAA-MM-JJ ; ValueError sinon."""
    if not isinstance(text, str) or len(text) != 10 or text[4] != "-" or text[7] != "-":
        raise ValueError(f"date invalide : {text!r}")
    return dt.date.fromisoformat(text)


# --------------------------------------------------------------------------- CLI

def make_parser(description: str) -> argparse.ArgumentParser:
    """Analyseur d'arguments avec une aide en francais (option -h/--help et titres de sections)."""
    parser = argparse.ArgumentParser(description=description, add_help=False)
    parser.add_argument("-h", "--help", action="help", help="afficher cette aide et quitter")
    parser._positionals.title = "arguments"  # argparse only exposes these titles as private attributes
    parser._optionals.title = "options"
    return parser


# --------------------------------------------------------------------------- logging

def _tolerate_console_encoding() -> None:
    """Remplace les caracteres non encodables au lieu de planter (consoles Windows en cp1252)."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(errors="replace")
            except (ValueError, AttributeError):
                pass


_tolerate_console_encoding()


def log(message: str) -> None:
    """Ecrit un message sur la sortie d'erreur (journal), sans polluer la sortie standard."""
    print(message, file=sys.stderr, flush=True)


def info(message: str) -> None:
    log(f"info : {message}")


def warn(message: str) -> None:
    log(f"attention : {message}")


def error(message: str) -> None:
    log(f"erreur : {message}")


# --------------------------------------------------------------------------- JSON files

def load_json(path) -> Any:
    """Charge un fichier JSON en UTF-8 (BOM tolere)."""
    with open(path, "r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def dump_json(value: Any, compact: bool = True) -> str:
    """Serialise en JSON (compact par defaut), UTF-8 non echappe, saut de ligne final."""
    if compact:
        text = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    else:
        text = json.dumps(value, indent=2, ensure_ascii=False)
    return text + "\n"


def write_json(path, value: Any, compact: bool = True) -> None:
    """Ecrit un fichier JSON (dossiers parents crees, fins de ligne LF)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(dump_json(value, compact=compact))


# --------------------------------------------------------------------------- JSONL

class JsonlError(ValueError):
    """Ligne JSONL invalide (le numero de ligne est conserve)."""

    def __init__(self, path, lineno: int, message: str):
        self.path = str(path)
        self.lineno = lineno
        self.message = message
        super().__init__(f"{self.path} ligne {lineno} : {message}")


def iter_jsonl_lines(path) -> Iterator[tuple]:
    """Itere sur les lignes utiles d'un fichier JSONL : (numero, texte), sans les vides ni les '#'."""
    with open(path, "r", encoding="utf-8-sig") as handle:
        for lineno, raw in enumerate(handle, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            yield lineno, line


def read_jsonl(path) -> list:
    """Lit un fichier JSONL et retourne la liste des objets (JsonlError a la premiere ligne invalide)."""
    entries = []
    for lineno, line in iter_jsonl_lines(path):
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise JsonlError(path, lineno, str(exc)) from None
    return entries


# --------------------------------------------------------------------------- HTTP

class HttpError(RuntimeError):
    """Echec d'une requete HTTP apres les nouvelles tentatives."""


def http_get_text(url: str, timeout: float = HTTP_TIMEOUT, retries: int = HTTP_RETRIES,
                  accept: str = "*/*") -> str:
    """GET HTTP renvoyant le corps decode ; delai 60 s, une nouvelle tentative par defaut."""
    last_error = None
    for attempt in range(retries + 1):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                charset = response.headers.get_content_charset() or "utf-8"
                return response.read().decode(charset, errors="replace")
        except urllib.error.HTTPError as exc:
            try:
                detail = exc.read().decode("utf-8", errors="replace").strip()[:300]
            except Exception:  # the body is optional diagnostic data only
                detail = ""
            last_error = HttpError(f"HTTP {exc.code} pour {url}" + (f" : {detail}" if detail else ""))
            if 400 <= exc.code < 500 and exc.code != 429:
                break  # a client error will not improve with a retry
        except (OSError, http.client.HTTPException, ValueError) as exc:
            last_error = HttpError(f"echec reseau pour {url} : {exc}")
        if attempt < retries:
            warn(f"{last_error} ; nouvelle tentative dans {HTTP_RETRY_DELAY:g} s")
            time.sleep(HTTP_RETRY_DELAY)
    assert last_error is not None
    raise last_error


def http_get_json(url: str, timeout: float = HTTP_TIMEOUT, retries: int = HTTP_RETRIES) -> Any:
    """GET HTTP dont le corps est decode en JSON (HttpError si le corps n'est pas du JSON)."""
    text = http_get_text(url, timeout=timeout, retries=retries, accept="application/json")
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise HttpError(f"reponse non JSON pour {url} : {exc}") from None
