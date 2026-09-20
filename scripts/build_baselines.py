"""Construit data/baselines.json a partir des series Berkeley Earth (DATA_FORMATS.md, section 2).

Usage :
    python3 scripts/build_baselines.py [--locations data/locations.json] [--out data/baselines.json]
    python3 scripts/build_baselines.py --input-dir dossier/  (mode hors ligne)

Pour chaque region ``berkeley_region`` des lieux, la chaine de repli est : region ->
``berkeley_fallback`` (continent) -> serie mondiale terres. Le repli utilise est consigne
dans ``fallback_from`` et ``note``. Le calcul est dans ``baselines_core.py``.
"""

from __future__ import annotations

import argparse
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional

import common
import baselines_core as core

SCHEMA_VERSION = 1
REGION_URL = "https://berkeley-earth-temperature.s3.us-west-1.amazonaws.com/Regional/TAVG/{region}-TAVG-Trend.txt"
GLOBAL_URL = "https://berkeley-earth-temperature.s3.us-west-1.amazonaws.com/Global/Complete_TAVG_complete.txt"
GLOBAL_FILENAME = "Complete_TAVG_complete.txt"
GLOBAL_NAME = "global"
ATTRIBUTION = "Berkeley Earth (berkeleyearth.org)"
LICENCE = "CC BY-NC 4.0"
ANOMALY_BASE = "1951-1980"
METHOD = ("delta_c = moyenne des anomalies annuelles 1991-2020 - moyenne des anomalies annuelles "
          "1850-1900 ; anomalie annuelle = moyenne des 12 anomalies mensuelles (>= 10 mois valides) ; "
          "chaque fenetre exige >= 25 annees valides")
DEFAULT_LOCATIONS = "data/locations.json"
DEFAULT_OUT = "data/baselines.json"


class BaselineError(RuntimeError):
    """Echec bloquant (fichier des lieux illisible, ecriture impossible)."""


def slugify(text: str) -> str:
    """Forme ``minuscules-tirets`` sans accents, pour comparer un nom de pays a un slug de region."""
    normalized = unicodedata.normalize("NFKD", text)
    ascii_text = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")


def region_label(region: str, locations: List[Dict[str, Any]]) -> str:
    """Libelle d'une region : nom du pays d'un lieu s'il correspond au slug, sinon le slug mis en forme."""
    for location in locations:
        country = location.get("country")
        if isinstance(country, str) and country and slugify(country) == region:
            return country
    return region.replace("-", " ").title()


def region_url(name: str) -> str:
    return GLOBAL_URL if name == GLOBAL_NAME else REGION_URL.format(region=name)


def fetch_series_text(name: str, input_dir: Optional[Path]) -> str:
    """Texte d'une serie (fichier local en mode hors ligne, sinon HTTP) ; leve en cas d'echec."""
    if input_dir is not None:
        filename = GLOBAL_FILENAME if name == GLOBAL_NAME else f"{name}-TAVG-Trend.txt"
        path = input_dir / filename
        if not path.is_file():
            raise FileNotFoundError(f"fichier local introuvable : {path}")
        return path.read_text(encoding="utf-8", errors="replace")
    return common.http_get_text(region_url(name))


def compute_region(region: str, fallbacks: List[str], input_dir: Optional[Path]) -> Dict[str, Any]:
    """Applique la chaine de repli et retourne l'entree ``regions[<region>]`` (sans le libelle)."""
    chain = [region]
    for fallback in fallbacks:
        if fallback and fallback not in chain and fallback != GLOBAL_NAME:
            chain.append(fallback)
    chain.append(GLOBAL_NAME)

    notes: List[str] = []
    last_counts = (0, 0)
    for name in chain:
        try:
            text = fetch_series_text(name, input_dir)
        except (OSError, common.HttpError) as exc:
            notes.append(f"{name} : lecture impossible ({exc})")
            common.warn(f"region {region} : source {name} indisponible ({exc})")
            continue
        parsed = core.parse_berkeley(text)
        annual = core.annual_means(parsed["monthly"])
        delta, n_pre, n_ref = core.compute_delta(annual, core.PRE_WINDOW, core.REF_WINDOW)
        last_counts = (n_pre, n_ref)
        if delta is None:
            notes.append(f"{name} : pas assez d'annees valides (n_pre={n_pre}, n_ref={n_ref}, minimum {core.MIN_VALID_YEARS})")
            common.warn(f"region {region} : source {name} insuffisante (n_pre={n_pre}, n_ref={n_ref})")
            continue
        used_fallback = name != region
        note = None
        if used_fallback:
            note = f"serie regionale '{region}' indisponible ou insuffisante ; repli sur '{name}' (" + " ; ".join(notes) + ")"
        return {
            "delta_c": delta,
            "pre_window": list(core.PRE_WINDOW),
            "ref_window": list(core.REF_WINDOW),
            "n_pre": n_pre,
            "n_ref": n_ref,
            "anomaly_base": ANOMALY_BASE,
            "source_url": region_url(name),
            "attribution": ATTRIBUTION,
            "licence": LICENCE,
            "analysis_date": parsed["header"]["analysis_date"],
            "fetched_at": common.now_utc_iso(),
            "fallback_from": region if used_fallback else None,
            "note": note,
        }

    return {
        "delta_c": None,
        "pre_window": list(core.PRE_WINDOW),
        "ref_window": list(core.REF_WINDOW),
        "n_pre": last_counts[0],
        "n_ref": last_counts[1],
        "anomaly_base": ANOMALY_BASE,
        "source_url": region_url(region),
        "attribution": ATTRIBUTION,
        "licence": LICENCE,
        "analysis_date": None,
        "fetched_at": common.now_utc_iso(),
        "fallback_from": None,
        "note": "aucune source de la chaine de repli n'a fourni assez d'annees valides : " + " ; ".join(notes),
    }


def load_locations(path: Path) -> List[Dict[str, Any]]:
    if not path.is_file():
        raise BaselineError(f"fichier des lieux introuvable : {path}")
    try:
        data = common.load_json(path)
    except ValueError as exc:
        raise BaselineError(f"JSON invalide dans {path} : {exc}") from None
    locations = data.get("locations") if isinstance(data, dict) else None
    if not isinstance(locations, list) or not locations:
        raise BaselineError(f"{path} : liste 'locations' vide ou absente")
    return locations


def load_existing(path: Path) -> Dict[str, Any]:
    """Regions deja presentes dans le fichier de sortie (vide si absent ou illisible)."""
    if not path.is_file():
        return {}
    try:
        data = common.load_json(path)
        regions = data.get("regions", {})
        return regions if isinstance(regions, dict) else {}
    except (ValueError, AttributeError) as exc:
        common.warn(f"fichier existant {path} illisible ({exc}), il sera remplace")
        return {}


def build_parser() -> argparse.ArgumentParser:
    parser = common.make_parser("Construit data/baselines.json (rechauffement regional delta_c d'apres Berkeley Earth).")
    parser.add_argument("--locations", default=DEFAULT_LOCATIONS,
                        help="fichier des lieux (defaut : %(default)s)")
    parser.add_argument("--out", default=DEFAULT_OUT, help="fichier de sortie (defaut : %(default)s)")
    parser.add_argument("--input-dir", metavar="DOSSIER",
                        help="mode hors ligne : dossier contenant <region>-TAVG-Trend.txt et Complete_TAVG_complete.txt")
    parser.add_argument("--force", action="store_true",
                        help="recalculer aussi les regions du fichier existant dont les lieux ont disparu (sinon conservees telles quelles)")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    out_path = Path(args.out)
    input_dir = Path(args.input_dir) if args.input_dir else None
    if input_dir is not None and not input_dir.is_dir():
        common.error(f"dossier --input-dir introuvable : {input_dir}")
        return 1
    try:
        locations = load_locations(Path(args.locations))
    except BaselineError as exc:
        common.error(str(exc))
        return 1

    # Ordered map region -> list of fallbacks declared by its locations.
    regions: Dict[str, List[str]] = {}
    by_region: Dict[str, List[Dict[str, Any]]] = {}
    for location in locations:
        region = location.get("berkeley_region")
        if not isinstance(region, str) or not region:
            common.warn(f"lieu {location.get('slug', '?')} sans 'berkeley_region', ignore")
            continue
        fallbacks = regions.setdefault(region, [])
        by_region.setdefault(region, []).append(location)
        fallback = location.get("berkeley_fallback")
        if isinstance(fallback, str) and fallback and fallback not in fallbacks:
            fallbacks.append(fallback)

    existing = load_existing(out_path)
    result_regions: Dict[str, Any] = {}
    kept_orphans: Dict[str, Any] = {}
    for region, entry in existing.items():
        if region in regions:
            continue
        if args.force:
            regions[region] = []  # orphan region recomputed through the global fallback only
        else:
            kept_orphans[region] = entry
            common.info(f"region {region} conservee du fichier existant (aucun lieu ne la reference)")

    unavailable = 0
    for region, fallbacks in regions.items():
        entry = compute_region(region, fallbacks, input_dir)
        label = region_label(region, by_region.get(region, []))
        if region in existing and isinstance(existing[region], dict) and existing[region].get("label") and region not in by_region:
            label = existing[region]["label"]
        result_regions[region] = {"label": label, **entry}
        if entry["delta_c"] is None:
            unavailable += 1
            print(f"{region} : delta_c indisponible ({entry['note']})", flush=True)
        else:
            origin = f", repli depuis {entry['fallback_from']}" if entry["fallback_from"] else ""
            print(f"{region} : delta_c {entry['delta_c']} (n_pre {entry['n_pre']}, n_ref {entry['n_ref']}{origin})", flush=True)

    result_regions.update(kept_orphans)
    result = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": common.now_utc_iso(),
        "method": METHOD,
        "regions": result_regions,
    }
    try:
        common.write_json(out_path, result, compact=False)
    except OSError as exc:
        common.error(f"ecriture de {out_path} impossible : {exc}")
        return 1
    print(f"fichier ecrit {out_path} : {len(result_regions)} region(s), {len(kept_orphans)} conservee(s), "
          f"{unavailable} indisponible(s)", flush=True)
    if unavailable:
        common.error(f"{unavailable} region(s) sans delta_c")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
