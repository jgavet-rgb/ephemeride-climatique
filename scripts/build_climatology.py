"""Construit data/climatology/<slug>.json pour chaque lieu de data/locations.json (DATA_FORMATS.md, section 1).

Usage :
    python3 scripts/build_climatology.py [--slug grenoble] [--full] [--dry-run]
    python3 scripts/build_climatology.py --slug grenoble --input reponse_open_meteo.json

La requete HTTP est celle de DATA_FORMATS.md (archive Open-Meteo, modele ERA5). En mode
incremental (par defaut), seules les dates posterieures a ``source.end`` du fichier existant
sont demandees, puis normales, annuel et records sont recalcules sur la serie fusionnee.
Le calcul lui-meme est dans ``climatology_core.py``.
"""

from __future__ import annotations

import argparse
import datetime as dt
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

import common
import climatology_core as core

ENDPOINT = "https://archive-api.open-meteo.com/v1/archive"
VARIABLE = "temperature_2m_mean"
DEFAULT_START_DATE = "1940-01-01"
END_DATE_LAG_DAYS = 6
DEFAULT_LOCATIONS = "data/locations.json"
DEFAULT_OUT_DIR = "data/climatology"


class BuildError(RuntimeError):
    """Echec de construction pour un lieu (message deja en francais)."""


def build_url(lat: Any, lon: Any, start_date: str, end_date: str) -> str:
    """URL exacte de la requete d'archive (ordre des parametres impose par DATA_FORMATS.md)."""
    return (f"{ENDPOINT}?latitude={lat}&longitude={lon}&start_date={start_date}&end_date={end_date}"
            f"&daily={VARIABLE}&timezone=auto&models=era5")


def extract_series(response: Dict[str, Any]) -> Tuple[List[str], List[Any]]:
    """Extrait ``daily.time`` et ``daily.temperature_2m_mean`` d'une reponse Open-Meteo."""
    if not isinstance(response, dict):
        raise BuildError("reponse inattendue : objet JSON attendu")
    if response.get("error"):
        raise BuildError(f"erreur renvoyee par l'API : {response.get('reason', 'raison inconnue')}")
    daily = response.get("daily")
    if not isinstance(daily, dict):
        raise BuildError("reponse sans bloc 'daily'")
    times = daily.get("time")
    values = daily.get(VARIABLE)
    if values is None:
        # With several models Open-Meteo suffixes the variable name (temperature_2m_mean_era5).
        for key, candidate in daily.items():
            if key.startswith(VARIABLE):
                values = candidate
                break
    if not isinstance(times, list) or not isinstance(values, list):
        raise BuildError(f"reponse sans tableaux 'daily.time' / 'daily.{VARIABLE}'")
    if len(times) != len(values):
        raise BuildError(f"tableaux de longueurs differentes ({len(times)} dates, {len(values)} valeurs)")
    if not times:
        raise BuildError("reponse sans aucune date")
    return times, values


def load_locations(path: Path) -> List[Dict[str, Any]]:
    """Charge la liste des lieux ; BuildError si le fichier manque ou est malforme."""
    if not path.is_file():
        raise BuildError(f"fichier des lieux introuvable : {path}")
    try:
        data = common.load_json(path)
    except ValueError as exc:
        raise BuildError(f"JSON invalide dans {path} : {exc}") from None
    locations = data.get("locations") if isinstance(data, dict) else None
    if not isinstance(locations, list) or not locations:
        raise BuildError(f"{path} : liste 'locations' vide ou absente")
    return locations


def parse_date_arg(text: str, name: str) -> dt.date:
    try:
        return common.parse_iso_date(text)
    except ValueError:
        raise BuildError(f"option {name} : date AAAA-MM-JJ attendue, recu {text!r}") from None


def process_location(location: Dict[str, Any], args: argparse.Namespace, end_date: dt.date) -> str:
    """Construit (ou met a jour) le fichier d'un lieu et retourne la ligne de resume."""
    slug = location.get("slug")
    if not slug:
        raise BuildError("lieu sans 'slug'")
    out_path = Path(args.out_dir) / f"{slug}.json"

    existing = None
    if args.incremental and out_path.is_file():
        try:
            existing = common.load_json(out_path)
            if existing.get("schema_version") != core.SCHEMA_VERSION:
                raise ValueError("schema_version different")
            existing_daily = core.daily_from_json(existing["daily"])
            old_start = str(existing["source"]["start"])
            old_end = str(existing["source"]["end"])
            common.parse_iso_date(old_start)
            common.parse_iso_date(old_end)
        except (KeyError, TypeError, ValueError) as exc:
            common.warn(f"{slug} : fichier existant inutilisable ({exc}), reconstruction complete")
            existing = None

    if existing is not None:
        request_start = common.parse_iso_date(old_end) + dt.timedelta(days=1)
        if request_start > end_date and not args.input:
            return f"{slug} : deja a jour ({old_start} -> {old_end}), rien a faire"
    else:
        request_start = parse_date_arg(args.start_date, "--start-date")
    if request_start > end_date:
        raise BuildError(f"date de debut {request_start} posterieure a la date de fin {end_date}")

    if args.input:
        try:
            response = common.load_json(args.input)
        except (OSError, ValueError) as exc:
            raise BuildError(f"lecture de {args.input} impossible : {exc}") from None
    else:
        url = build_url(location.get("lat"), location.get("lon"), request_start.isoformat(),
                        end_date.isoformat())
        common.info(f"{slug} : requete {url}")
        try:
            response = common.http_get_json(url)
        except common.HttpError as exc:
            raise BuildError(str(exc)) from None

    times, values = extract_series(response)
    fetched_start = str(times[0])[:10]
    fetched_end = str(times[-1])[:10]

    if existing is not None:
        daily = core.merge_series(existing_daily, times, values)
        start = min(old_start, fetched_start)
        end = max(old_end, fetched_end)
    else:
        daily = core.series_to_daily(times, values)
        start = fetched_start
        end = fetched_end

    source = {
        "grid_lat": response.get("latitude"),
        "grid_lon": response.get("longitude"),
        "grid_elevation": response.get("elevation"),
        "fetched_at": common.now_utc_iso(),
        "start": start,
        "end": end,
        "variable": VARIABLE,
    }
    result = core.compute_climatology(daily, location, source)
    day_count = (common.parse_iso_date(end) - common.parse_iso_date(start)).days + 1

    if args.dry_run:
        return f"{slug} : {day_count} jours, {start} -> {end}, simulation (fichier {out_path} non ecrit)"
    common.write_json(out_path, result, compact=True)
    suffix = f" (+{len(times)} jours ajoutes)" if existing is not None else ""
    return f"{slug} : {day_count} jours, {start} -> {end}, fichier ecrit {out_path}{suffix}"


def build_parser() -> argparse.ArgumentParser:
    parser = common.make_parser("Construit les fichiers data/climatology/<slug>.json (normales, anomalies, records).")
    parser.add_argument("--locations", default=DEFAULT_LOCATIONS,
                        help="fichier des lieux (defaut : %(default)s)")
    parser.add_argument("--slug", help="ne traiter que ce lieu")
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR,
                        help="dossier de sortie (defaut : %(default)s)")
    parser.add_argument("--input", metavar="REPONSE.json",
                        help="mode hors ligne : reponse Open-Meteo enregistree (exige --slug)")
    parser.add_argument("--start-date", default=DEFAULT_START_DATE,
                        help="premiere date demandee lors d'une construction complete (defaut : %(default)s)")
    parser.add_argument("--end-date", help="derniere date demandee (defaut : aujourd'hui UTC moins 6 jours)")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--incremental", dest="incremental", action="store_true", default=True,
                       help="ne demander que les dates posterieures au fichier existant (defaut)")
    group.add_argument("--full", dest="incremental", action="store_false",
                       help="ignorer le fichier existant et tout reconstruire")
    parser.add_argument("--dry-run", action="store_true", help="calculer sans ecrire les fichiers")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.input and not args.slug:
        common.error("--input exige --slug (un seul lieu par reponse enregistree)")
        return 2
    try:
        if args.end_date:
            end_date = parse_date_arg(args.end_date, "--end-date")
        else:
            end_date = common.parse_iso_date(common.iso_today_utc()) - dt.timedelta(days=END_DATE_LAG_DAYS)
        locations = load_locations(Path(args.locations))
    except BuildError as exc:
        common.error(str(exc))
        return 1

    if args.slug:
        locations = [loc for loc in locations if loc.get("slug") == args.slug]
        if not locations:
            common.error(f"lieu inconnu : {args.slug}")
            return 1

    failures = 0
    for location in locations:
        try:
            print(process_location(location, args, end_date), flush=True)
        except BuildError as exc:
            failures += 1
            common.error(f"{location.get('slug', '?')} : {exc}")
        except (OSError, ValueError) as exc:
            failures += 1
            common.error(f"{location.get('slug', '?')} : {exc}")
    if failures:
        common.error(f"{failures} lieu(x) en echec")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
