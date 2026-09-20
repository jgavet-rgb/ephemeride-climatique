"""Valide data/quotes.jsonl (ou un fichier de candidats) contre data/quotes.schema.json et les regles du projet.

Usage :
    python3 scripts/validate_quotes.py [data/quotes.jsonl] [--schema data/quotes.schema.json] [--strict]
    python3 scripts/validate_quotes.py data/quotes.candidates.jsonl --candidates

Verifications : JSON valide ligne par ligne, schema (paquet ``jsonschema`` si present, sinon
validateur integre), identifiants uniques, dates non futures, ``https://`` pour les entrees
verifiees, quasi-doublons par auteur, couverture des 366 jours MM-JJ par les entrees verifiees
(avertissement, erreur avec ``--strict``). Code de sortie 0 (OK, avertissements possibles) ou 1.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import common
import candidates_core

try:
    import jsonschema  # optional dependency (scripts/requirements.txt)
except ImportError:  # pragma: no cover - exercised through monkeypatching in the tests
    jsonschema = None

DEFAULT_PATH = "data/quotes.jsonl"
DEFAULT_SCHEMA = "data/quotes.schema.json"
DUPLICATE_THRESHOLD = 0.9
MAX_MISSING_SHOWN = 40

# Copy of the agreed schema, used only when data/quotes.schema.json is missing (with a warning).
BUILTIN_SCHEMA: Dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": ["id", "author", "date", "text", "lang", "medium", "source_url", "verified", "added"],
    "additionalProperties": False,
    "properties": {
        "id": {"type": "string", "pattern": "^(trump|musk|exemple)-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{3}$"},
        "author": {"type": "string", "enum": ["trump", "musk"]},
        "date": {"type": "string", "format": "date"},
        "text": {"type": "string", "minLength": 10, "maxLength": 1000},
        "lang": {"type": "string", "enum": ["en", "fr"]},
        "text_fr": {"type": "string", "maxLength": 1200},
        "translation": {"type": "string", "enum": ["machine", "human"]},
        "medium": {"type": "string", "enum": ["twitter", "x", "truth_social", "speech", "interview",
                                              "press_conference", "earnings_call", "hearing", "book", "other"]},
        "context": {"type": "string", "maxLength": 200},
        "source_url": {"type": "string", "format": "uri", "pattern": "^https?://"},
        "source_type": {"type": "string", "enum": ["primary", "archive", "press"]},
        "verified": {"type": "boolean"},
        "added": {"type": "string", "format": "date"},
        "tags": {"type": "array", "items": {"type": "string"}, "maxItems": 8},
    },
    "dependentRequired": {"text_fr": ["translation"]},
}

ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# --------------------------------------------------------------------------- built-in schema checker

_TYPE_CHECKS = {
    "string": lambda v: isinstance(v, str),
    "boolean": lambda v: isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "array": lambda v: isinstance(v, list),
    "object": lambda v: isinstance(v, dict),
    "null": lambda v: v is None,
}


def _is_valid_date(value: str) -> bool:
    if not ISO_DATE_RE.match(value):
        return False
    try:
        dt.date.fromisoformat(value)
    except ValueError:
        return False
    return True


def check_schema_builtin(value: Any, schema: Dict[str, Any], path: str = "") -> List[str]:
    """Validateur integre : type, enum, const, pattern, min/maxLength, format date/uri, required,
    properties, additionalProperties, items, min/maxItems, dependentRequired."""
    errors: List[str] = []
    where = path or "(racine)"
    expected = schema.get("type")
    if expected is not None:
        types = expected if isinstance(expected, list) else [expected]
        if not any(_TYPE_CHECKS.get(name, lambda _v: True)(value) for name in types):
            errors.append(f"{where} : type {'/'.join(types)} attendu")
            return errors
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{where} : valeur {json.dumps(value, ensure_ascii=False)} hors de {schema['enum']}")
    if "const" in schema and value != schema["const"]:
        errors.append(f"{where} : valeur {schema['const']!r} attendue")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{where} : au moins {schema['minLength']} caracteres attendus ({len(value)})")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errors.append(f"{where} : au plus {schema['maxLength']} caracteres attendus ({len(value)})")
        if "pattern" in schema and re.search(schema["pattern"], value) is None:
            errors.append(f"{where} : ne respecte pas le motif {schema['pattern']}")
        fmt = schema.get("format")
        if fmt == "date" and not _is_valid_date(value):
            errors.append(f"{where} : date AAAA-MM-JJ attendue")
        elif fmt == "uri" and not re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:\S+$", value):
            errors.append(f"{where} : URI attendue")
    if isinstance(value, dict):
        for name in schema.get("required", []):
            if name not in value:
                errors.append(f"{where} : propriete obligatoire '{name}' absente")
        properties = schema.get("properties", {})
        for name, sub_value in value.items():
            if name in properties:
                errors.extend(check_schema_builtin(sub_value, properties[name], f"{path}/{name}" if path else name))
            elif schema.get("additionalProperties") is False:
                errors.append(f"{where} : propriete inattendue '{name}'")
        for name, dependencies in schema.get("dependentRequired", {}).items():
            if name in value:
                for dependency in dependencies:
                    if dependency not in value:
                        errors.append(f"{where} : '{name}' exige la propriete '{dependency}'")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{where} : au moins {schema['minItems']} elements attendus")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"{where} : au plus {schema['maxItems']} elements attendus ({len(value)})")
        if "items" in schema:
            for position, item in enumerate(value):
                errors.extend(check_schema_builtin(item, schema["items"], f"{path}[{position}]" if path else f"[{position}]"))
    return errors


class SchemaChecker:
    """Applique le schema avec ``jsonschema`` si le paquet est importable, sinon le validateur integre."""

    def __init__(self, schema: Dict[str, Any]):
        self.schema = schema
        self.validator = None
        if jsonschema is not None:
            validator_class = jsonschema.validators.validator_for(schema, default=jsonschema.Draft202012Validator)
            validator_class.check_schema(schema)
            self.validator = validator_class(schema, format_checker=validator_class.FORMAT_CHECKER)

    @property
    def engine(self) -> str:
        return "jsonschema" if self.validator is not None else "validateur integre"

    def errors(self, value: Any) -> List[str]:
        if self.validator is None:
            return check_schema_builtin(value, self.schema)
        found = sorted(self.validator.iter_errors(value), key=lambda err: [str(p) for p in err.path])
        return ["/".join(str(part) for part in err.path) + " : " + err.message if err.path else "(racine) : " + err.message
                for err in found]


# --------------------------------------------------------------------------- validation

class Report:
    """Accumule erreurs, avertissements et informations ; affichage en francais, par numero de ligne."""

    def __init__(self):
        self.errors: List[str] = []
        self.warnings: List[str] = []
        self.infos: List[str] = []
        self._order: Dict[str, tuple] = {}

    def error(self, message: str, lineno: Optional[int] = None) -> None:
        self.errors.append(self._record("ERREUR", message, lineno))

    def warning(self, message: str, lineno: Optional[int] = None) -> None:
        self.warnings.append(self._record("AVERTISSEMENT", message, lineno))

    def info(self, message: str) -> None:
        self.infos.append(self._record("INFO", message, None))

    def lines(self) -> List[str]:
        """Informations, puis avertissements, puis erreurs ; chaque groupe trie par ligne."""
        ordered = []
        for group in (self.infos, self.warnings, self.errors):
            ordered.extend(sorted(group, key=lambda text: self._order.get(text, (0, 0))))
        return ordered

    def _record(self, level: str, message: str, lineno: Optional[int]) -> str:
        text = f"{level} ligne {lineno} : {message}" if lineno is not None else f"{level} : {message}"
        self._order.setdefault(text, (lineno if lineno is not None else 10 ** 9, len(self._order)))
        return text


def load_schema(path: Path, report: Report) -> Optional[Dict[str, Any]]:
    """Charge le schema JSON ; schema integre (avec avertissement) si le fichier manque."""
    if not path.is_file():
        report.warning(f"schema {path} introuvable, utilisation du schema integre")
        return dict(BUILTIN_SCHEMA)
    try:
        schema = common.load_json(path)
    except ValueError as exc:
        report.error(f"schema {path} illisible : {exc}")
        return None
    if not isinstance(schema, dict):
        report.error(f"schema {path} : objet JSON attendu")
        return None
    return schema


def validate_file(path: Path, schema: Dict[str, Any], strict: bool = False, candidates: bool = False,
                  today: Optional[str] = None, report: Optional[Report] = None) -> Report:
    """Toutes les verifications ; retourne le rapport (erreurs, avertissements, informations)."""
    report = report if report is not None else Report()
    today_date = common.parse_iso_date(today or common.iso_today_utc())
    try:
        checker = SchemaChecker(schema)
    except Exception as exc:  # invalid schema document: reported, not raised
        report.error(f"schema invalide : {exc}")
        return report
    report.info(f"validation du schema avec {checker.engine}")

    entries: List[tuple] = []
    try:
        for lineno, line in common.iter_jsonl_lines(path):
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                report.error(f"JSON invalide : {exc}", lineno)
                continue
            entries.append((lineno, value))
    except OSError as exc:
        report.error(f"lecture impossible : {exc}")
        return report

    seen_ids: Dict[str, int] = {}
    texts_by_author: Dict[str, List[tuple]] = {}
    covered: set = set()
    verified_count = 0
    for lineno, entry in entries:
        schema_errors = checker.errors(entry)
        for message in schema_errors:
            report.error(f"schema : {message}", lineno)
        if not isinstance(entry, dict):
            continue
        identifier = entry.get("id")
        if isinstance(identifier, str):
            if identifier in seen_ids:
                report.error(f"identifiant en double '{identifier}' (deja vu ligne {seen_ids[identifier]})", lineno)
            else:
                seen_ids[identifier] = lineno
        author = entry.get("author")
        date_text = entry.get("date")
        if isinstance(identifier, str) and isinstance(author, str):
            prefix = identifier.split("-", 1)[0]
            if prefix not in (author, "exemple"):
                report.warning(f"prefixe de l'identifiant '{prefix}' different de l'auteur '{author}'", lineno)
            if isinstance(date_text, str) and len(identifier) >= 15 and identifier[len(prefix) + 1:len(prefix) + 11] != date_text:
                report.warning(f"date de l'identifiant differente du champ date ({date_text})", lineno)
        for field in ("date", "added"):
            value = entry.get(field)
            if isinstance(value, str) and _is_valid_date(value):
                if dt.date.fromisoformat(value) > today_date:
                    report.error(f"{field} dans le futur ({value} > {today_date.isoformat()})", lineno)
        verified = entry.get("verified")
        url = entry.get("source_url")
        if isinstance(url, str):
            if url.startswith("https://"):
                pass
            elif url.startswith("http://"):
                if verified is True:
                    report.error("source_url doit commencer par https:// pour une entree verifiee", lineno)
                else:
                    report.warning("source_url en http:// (tolere seulement pour verified=false)", lineno)
        if verified is True:
            verified_count += 1
            if isinstance(date_text, str) and _is_valid_date(date_text):
                covered.add(date_text[5:])
        elif not candidates:
            report.warning("entree non verifiee (verified=false), ignoree par l'application", lineno)
        text = entry.get("text")
        if isinstance(author, str) and isinstance(text, str):
            texts_by_author.setdefault(author, []).append((lineno, text))

    for author, items in texts_by_author.items():
        pairs = candidates_core.find_near_duplicates([text for _lineno, text in items], DUPLICATE_THRESHOLD)
        for first, second, similarity in pairs:
            report.error(f"textes quasi identiques (auteur {author}, similarite {similarity:.2f}) "
                         f"lignes {items[first][0]} et {items[second][0]}")

    if not candidates:
        missing = [key for key in common.KEYS if key not in covered]
        shown = ", ".join(missing[:MAX_MISSING_SHOWN]) + (", ..." if len(missing) > MAX_MISSING_SHOWN else "")
        message = (f"couverture des entrees verifiees : {len(covered)}/{len(common.KEYS)} jours MM-JJ"
                   + (f" ; manquants ({len(missing)}) : {shown}" if missing else " ; complete"))
        if missing and strict:
            report.error(message)
        elif missing:
            report.warning(message)
        else:
            report.info(message)
    report.info(f"{len(entries)} entree(s), {verified_count} verifiee(s)")
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = common.make_parser("Valide un fichier de citations JSONL (schema et regles du projet).")
    parser.add_argument("path", nargs="?", default=DEFAULT_PATH, help="fichier JSONL (defaut : %(default)s)")
    parser.add_argument("--schema", default=DEFAULT_SCHEMA, help="schema JSON (defaut : %(default)s)")
    parser.add_argument("--strict", action="store_true", help="couverture incomplete = erreur")
    parser.add_argument("--candidates", action="store_true",
                        help="fichier de candidats : verified=false accepte sans avertissement, pas de couverture")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    path = Path(args.path)
    report = Report()
    if not path.is_file():
        print(f"ERREUR : fichier introuvable : {path}")
        return 1
    schema = load_schema(Path(args.schema), report)
    if schema is None:
        for line in report.lines():
            print(line)
        return 1
    validate_file(path, schema, args.strict, args.candidates, report=report)
    for line in report.lines():
        print(line)
    status = "OK" if not report.errors else "ECHEC"
    print(f"{path} : {status}, {len(report.errors)} erreur(s), {len(report.warnings)} avertissement(s)")
    return 1 if report.errors else 0


if __name__ == "__main__":
    sys.exit(main())
