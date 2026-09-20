"""Valide les fichiers de reference de data/ (saints, calendrier republicain, lieux, baselines, climatologies).

Usage :
    python3 scripts/validate_data.py [--data-dir data]

``saints.json``, ``republican.json`` et ``locations.json`` sont obligatoires (erreur s'ils
manquent) ; ``baselines.json`` et ``climatology/*.json`` sont facultatifs (information s'ils
manquent). Code de sortie 0 (OK, avertissements possibles) ou 1 (erreurs).
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import common

DEFAULT_DATA_DIR = "data"
SLUG_RE = re.compile(r"^[a-z0-9-]+$")
LOCATION_REQUIRED = ("slug", "label", "lat", "lon", "timezone", "country_code", "berkeley_region")
REGION_REQUIRED = ("label", "delta_c", "pre_window", "ref_window", "n_pre", "n_ref", "anomaly_base",
                   "source_url", "attribution", "licence", "analysis_date", "fetched_at",
                   "fallback_from", "note")
ANNUAL_REQUIRED = ("year", "mean", "anomaly", "days", "partial")
CLIMATOLOGY_REQUIRED = ("schema_version", "location", "source", "normal_period", "window_days", "keys",
                        "normal_mean", "normal_std", "records", "annual", "daily")
SOURCE_REQUIRED = ("provider", "endpoint", "model", "dataset", "grid_lat", "grid_lon", "grid_elevation",
                   "fetched_at", "start", "end", "variable")


class Report:
    """Accumule erreurs, avertissements et informations ; affichage en francais."""

    def __init__(self):
        self.errors: List[str] = []
        self.warnings: List[str] = []
        self.infos: List[str] = []

    def error(self, message: str) -> None:
        self.errors.append(f"ERREUR : {message}")

    def warning(self, message: str) -> None:
        self.warnings.append(f"AVERTISSEMENT : {message}")

    def info(self, message: str) -> None:
        self.infos.append(f"INFO : {message}")

    def lines(self) -> List[str]:
        return self.infos + self.warnings + self.errors


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def non_empty_strings(values: Any) -> bool:
    return isinstance(values, list) and all(isinstance(v, str) and v.strip() for v in values)


def load_required(path: Path, report: Report) -> Optional[Any]:
    """Charge un fichier obligatoire ; erreur s'il manque ou n'est pas du JSON."""
    if not path.is_file():
        report.error(f"{path} : fichier obligatoire introuvable")
        return None
    return load_or_error(path, report)


def load_or_error(path: Path, report: Report) -> Optional[Any]:
    try:
        return common.load_json(path)
    except ValueError as exc:
        report.error(f"{path} : JSON invalide ({exc})")
    except OSError as exc:
        report.error(f"{path} : lecture impossible ({exc})")
    return None


# --------------------------------------------------------------------------- individual files

def check_saints(path: Path, report: Report) -> None:
    data = load_required(path, report)
    if data is None:
        return
    days = data.get("days") if isinstance(data, dict) else None
    if not isinstance(days, dict):
        report.error(f"{path} : objet 'days' attendu")
        return
    expected = set(common.KEYS)
    actual = set(days)
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    if missing:
        report.error(f"{path} : {len(missing)} cle(s) MM-JJ manquante(s) : {', '.join(missing[:20])}")
    if extra:
        report.error(f"{path} : cle(s) inattendue(s) : {', '.join(extra[:20])}")
    bad_saint = [key for key in common.KEYS if key in days and not (isinstance(days[key], dict)
                 and isinstance(days[key].get("saint"), str) and days[key]["saint"].strip())]
    if bad_saint:
        report.error(f"{path} : 'saint' vide ou absent pour {len(bad_saint)} jour(s) : {', '.join(bad_saint[:20])}")
    bad_names = [key for key in common.KEYS if key in days and isinstance(days[key], dict)
                 and not non_empty_strings(days[key].get("names"))]
    if bad_names:
        report.error(f"{path} : 'names' doit etre une liste de prenoms non vides pour {len(bad_names)} jour(s) : {', '.join(bad_names[:20])}")
    if not any(str(path) in line for line in report.errors):
        report.info(f"{path} : {len(days)} jours, OK")


def check_republican(path: Path, report: Report) -> None:
    data = load_required(path, report)
    if data is None:
        return
    if not isinstance(data, dict):
        report.error(f"{path} : objet JSON attendu")
        return
    for key, count in (("months", 12), ("days", 360), ("complementary", 6), ("decade_days", 10)):
        values = data.get(key)
        if not isinstance(values, list):
            report.error(f"{path} : liste '{key}' absente")
        elif len(values) != count:
            report.error(f"{path} : '{key}' doit compter {count} elements ({len(values)} trouves)")
        elif not non_empty_strings(values):
            report.error(f"{path} : '{key}' doit ne contenir que des chaines non vides")
    if not any(str(path) in line for line in report.errors):
        report.info(f"{path} : OK")


def check_locations(path: Path, report: Report) -> Optional[List[Dict[str, Any]]]:
    data = load_required(path, report)
    if data is None:
        return None
    if not isinstance(data, dict):
        report.error(f"{path} : objet JSON attendu")
        return None
    if data.get("schema_version") != 1:
        report.error(f"{path} : schema_version 1 attendu")
    locations = data.get("locations")
    if not isinstance(locations, list) or not locations:
        report.error(f"{path} : liste 'locations' non vide attendue")
        return None
    seen = set()
    for position, location in enumerate(locations):
        label = f"{path} lieu #{position + 1}"
        if not isinstance(location, dict):
            report.error(f"{label} : objet attendu")
            continue
        missing = [key for key in LOCATION_REQUIRED if key not in location]
        if missing:
            report.error(f"{label} : cle(s) manquante(s) : {', '.join(missing)}")
        slug = location.get("slug")
        if not isinstance(slug, str) or not SLUG_RE.match(slug):
            report.error(f"{label} : slug invalide {slug!r} (minuscules, chiffres, tirets)")
        elif slug in seen:
            report.error(f"{label} : slug en double '{slug}'")
        else:
            seen.add(slug)
        for key, low, high in (("lat", -90, 90), ("lon", -180, 180)):
            value = location.get(key)
            if key in location and (not is_number(value) or not low <= value <= high):
                report.error(f"{label} : '{key}' doit etre un nombre entre {low} et {high}")
        for key in ("label", "timezone", "country_code", "berkeley_region"):
            if key in location and (not isinstance(location[key], str) or not location[key].strip()):
                report.error(f"{label} : '{key}' doit etre une chaine non vide")
    if not any(str(path) in line for line in report.errors):
        report.info(f"{path} : {len(locations)} lieu(x), OK")
    return [loc for loc in locations if isinstance(loc, dict)]


def check_baselines(path: Path, report: Report, locations: Optional[List[Dict[str, Any]]]) -> None:
    if not path.is_file():
        report.info(f"{path} : absent (facultatif)")
        return
    data = load_or_error(path, report)
    if data is None:
        return
    if not isinstance(data, dict):
        report.error(f"{path} : objet JSON attendu")
        return
    if data.get("schema_version") != 1:
        report.error(f"{path} : schema_version 1 attendu")
    for key in ("generated_at", "method"):
        if not isinstance(data.get(key), str) or not data[key]:
            report.error(f"{path} : '{key}' doit etre une chaine non vide")
    regions = data.get("regions")
    if not isinstance(regions, dict):
        report.error(f"{path} : objet 'regions' attendu")
        return
    for name, region in regions.items():
        label = f"{path} region '{name}'"
        if not isinstance(region, dict):
            report.error(f"{label} : objet attendu")
            continue
        missing = [key for key in REGION_REQUIRED if key not in region]
        if missing:
            report.error(f"{label} : cle(s) manquante(s) : {', '.join(missing)}")
        delta = region.get("delta_c")
        if delta is not None and not is_number(delta):
            report.error(f"{label} : delta_c doit etre un nombre ou null")
        if delta is None and not isinstance(region.get("note"), str):
            report.error(f"{label} : delta_c null exige une 'note' explicative")
        for key in ("pre_window", "ref_window"):
            window = region.get(key)
            if not (isinstance(window, list) and len(window) == 2 and all(is_int(v) for v in window) and window[0] <= window[1]):
                report.error(f"{label} : '{key}' doit etre [annee_debut, annee_fin]")
        for key in ("n_pre", "n_ref"):
            if not is_int(region.get(key)) or region.get(key) < 0:
                report.error(f"{label} : '{key}' doit etre un entier positif ou nul")
        for key in ("label", "anomaly_base", "source_url", "attribution", "licence", "fetched_at"):
            if not isinstance(region.get(key), str) or not region[key]:
                report.error(f"{label} : '{key}' doit etre une chaine non vide")
        for key in ("analysis_date", "fallback_from", "note"):
            if key in region and region[key] is not None and not isinstance(region[key], str):
                report.error(f"{label} : '{key}' doit etre une chaine ou null")
        if isinstance(region.get("source_url"), str) and not region["source_url"].startswith("https://"):
            report.warning(f"{label} : source_url ne commence pas par https://")
    if locations:
        for location in locations:
            region = location.get("berkeley_region")
            if isinstance(region, str) and region not in regions:
                report.warning(f"{path} : region '{region}' du lieu '{location.get('slug')}' absente (relancer build_baselines.py)")
    if not any(str(path) in line for line in report.errors):
        report.info(f"{path} : {len(regions)} region(s), OK")


def check_climatology_file(path: Path, report: Report) -> None:
    data = load_or_error(path, report)
    if data is None:
        return
    if not isinstance(data, dict):
        report.error(f"{path} : objet JSON attendu")
        return
    missing = [key for key in CLIMATOLOGY_REQUIRED if key not in data]
    if missing:
        report.error(f"{path} : cle(s) manquante(s) : {', '.join(missing)}")
        return
    if data["schema_version"] != 1:
        report.error(f"{path} : schema_version 1 attendu")
    location = data["location"]
    if not isinstance(location, dict) or location.get("slug") != path.stem:
        report.warning(f"{path} : location.slug different du nom de fichier")
    source = data["source"]
    if not isinstance(source, dict):
        report.error(f"{path} : objet 'source' attendu")
    else:
        missing_source = [key for key in SOURCE_REQUIRED if key not in source]
        if missing_source:
            report.error(f"{path} : source : cle(s) manquante(s) : {', '.join(missing_source)}")
    period = data["normal_period"]
    if not (isinstance(period, list) and len(period) == 2 and all(is_int(v) for v in period)):
        report.error(f"{path} : normal_period [debut, fin] attendu")
    if not is_int(data["window_days"]) or data["window_days"] < 0:
        report.error(f"{path} : window_days entier positif attendu")
    if data["keys"] != list(common.KEYS):
        report.error(f"{path} : 'keys' doit etre la liste des 366 cles MM-JJ")
    for key in ("normal_mean", "normal_std"):
        values = data[key]
        if not isinstance(values, list) or len(values) != 366:
            report.error(f"{path} : '{key}' doit compter 366 valeurs")
        elif not all(v is None or is_number(v) for v in values):
            report.error(f"{path} : '{key}' ne doit contenir que des nombres ou null")
    records = data["records"]
    if not isinstance(records, dict):
        report.error(f"{path} : objet 'records' attendu")
    else:
        for key in ("max", "min"):
            values = records.get(key)
            if not isinstance(values, list) or len(values) != 366:
                report.error(f"{path} : records.{key} doit compter 366 entrees")
            elif not all(isinstance(v, list) and len(v) == 2 and (v[0] is None or is_number(v[0]))
                         and (v[1] is None or is_int(v[1])) for v in values):
                report.error(f"{path} : records.{key} doit contenir des paires [valeur, annee]")
    annual = data["annual"]
    if not isinstance(annual, list):
        report.error(f"{path} : liste 'annual' attendue")
    else:
        years = []
        for entry in annual:
            if not isinstance(entry, dict) or any(key not in entry for key in ANNUAL_REQUIRED):
                report.error(f"{path} : entree 'annual' incomplete : {entry!r}"[:200])
                continue
            if not is_int(entry["year"]) or not is_int(entry["days"]) or not isinstance(entry["partial"], bool):
                report.error(f"{path} : annual {entry.get('year')} : types invalides")
            if entry["partial"] != (entry["days"] < 360):
                report.error(f"{path} : annual {entry.get('year')} : 'partial' incoherent avec 'days'")
            years.append(entry["year"])
        if years != sorted(years) or len(set(years)) != len(years):
            report.error(f"{path} : 'annual' doit etre trie par annee croissante sans doublon")
    daily = data["daily"]
    if not isinstance(daily, dict):
        report.error(f"{path} : objet 'daily' attendu")
    else:
        for year, row in daily.items():
            if not (isinstance(year, str) and year.isdigit()):
                report.error(f"{path} : daily : cle d'annee invalide {year!r}")
            if not isinstance(row, list) or len(row) != 366:
                report.error(f"{path} : daily[{year}] doit compter 366 valeurs")
            elif not all(v is None or is_int(v) for v in row):
                report.error(f"{path} : daily[{year}] ne doit contenir que des entiers (dixiemes) ou null")
        if isinstance(annual, list):
            annual_years = {str(e.get("year")) for e in annual if isinstance(e, dict)}
            if annual_years != set(daily):
                report.error(f"{path} : annees de 'annual' et de 'daily' differentes")
    if not any(str(path) in line for line in report.errors):
        report.info(f"{path} : {len(daily) if isinstance(daily, dict) else 0} annee(s), OK")


def check_climatology_dir(folder: Path, report: Report) -> None:
    if not folder.is_dir():
        report.info(f"{folder} : dossier absent (facultatif)")
        return
    files = sorted(folder.glob("*.json"))
    if not files:
        report.info(f"{folder} : aucun fichier de climatologie (facultatif)")
        return
    for path in files:
        check_climatology_file(path, report)


# --------------------------------------------------------------------------- entry point

def validate_data_dir(data_dir: Path) -> Report:
    report = Report()
    check_saints(data_dir / "saints.json", report)
    check_republican(data_dir / "republican.json", report)
    locations = check_locations(data_dir / "locations.json", report)
    check_baselines(data_dir / "baselines.json", report, locations)
    check_climatology_dir(data_dir / "climatology", report)
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = common.make_parser("Valide les fichiers de reference du dossier data/.")
    parser.add_argument("--data-dir", default=DEFAULT_DATA_DIR, help="dossier des donnees (defaut : %(default)s)")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    report = validate_data_dir(Path(args.data_dir))
    for line in report.lines():
        print(line)
    status = "OK" if not report.errors else "ECHEC"
    print(f"{args.data_dir} : {status}, {len(report.errors)} erreur(s), {len(report.warnings)} avertissement(s)")
    return 1 if report.errors else 0


if __name__ == "__main__":
    sys.exit(main())
