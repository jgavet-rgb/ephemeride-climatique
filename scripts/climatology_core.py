"""Calcul pur de la climatologie d'un lieu (DATA_FORMATS.md, section 1).

Ce module ne fait aucune entree-sortie : il transforme une serie journaliere
(dates ISO + temperatures moyennes en degres C) en la structure
``data/climatology/<slug>.json``. Il est importe par ``build_climatology.py`` et par les
tests ; la suite JavaScript doit produire exactement les memes valeurs.

Conventions numeriques suivies a la lettre (a reproduire dans l'implementation JS) :

- ``daily[year][idx]`` = dixiemes de degre entiers, arrondi demi vers l'exterieur
  (``floor(v * 10 + 0.5)`` pour v >= 0, ``-floor(-v * 10 + 0.5)`` pour v < 0), ``null`` si absent.
- Normale a l'index ``i`` : echantillon ``V`` parcouru dans l'ordre annees croissantes de la
  periode de reference, puis ``k`` de -7 a +7 avec ``j = (i + k) mod 366`` (modulo positif :
  en JS ``((i + k) % 366 + 366) % 366``) ; chaque valeur vaut ``daily[y][j] / 10`` ; la somme
  est une simple accumulation en virgule flottante dans cet ordre ; la moyenne vaut
  ``somme / n`` ; l'ecart-type population est calcule en deux passes
  ``sqrt(somme((v - moyenne) * (v - moyenne)) / n)``. Les deux resultats passent par ``round2``.
- ``annual`` : moyenne des ``daily[y][idx] / 10`` non nuls dans l'ordre des index, anomalie =
  moyenne des ``daily[y][idx] / 10 - normal_mean[idx]`` (index dont la normale est ``null``
  exclus) ; ``round2`` sur les deux ; ``days`` = jours non nuls ; ``partial = days < 360``.
- ``records`` : premiere annee (ordre croissant) atteignant le maximum, idem minimum,
  comparaison stricte ; ``[null, null]`` si aucune valeur.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

from common import KEYS, key_index, round2, to_tenths

SCHEMA_VERSION = 1
DEFAULT_NORMAL_PERIOD = (1991, 2020)
DEFAULT_WINDOW_DAYS = 7
PARTIAL_THRESHOLD_DAYS = 360
DAYS_PER_RING = 366

LOCATION_KEYS = ("slug", "label", "lat", "lon", "timezone", "country_code", "elevation",
                 "berkeley_region")
SOURCE_KEYS = ("provider", "endpoint", "model", "dataset", "grid_lat", "grid_lon",
               "grid_elevation", "fetched_at", "start", "end", "variable")
SOURCE_DEFAULTS = {
    "provider": "Open-Meteo",
    "endpoint": "https://archive-api.open-meteo.com/v1/archive",
    "model": "era5",
    "dataset": "ERA5 (ECMWF, Copernicus Climate Change Service)",
    "variable": "temperature_2m_mean",
}

Daily = Dict[int, List[Optional[int]]]


def empty_year() -> List[Optional[int]]:
    """Tableau de 366 entrees ``None`` pour une annee."""
    return [None] * DAYS_PER_RING


def merge_series(daily: Daily, times: Sequence[str], values: Sequence[Any]) -> Daily:
    """Insere une serie (dates ISO, valeurs en degres C ou None) dans ``daily`` (en place)."""
    if len(times) != len(values):
        raise ValueError(f"series de longueurs differentes : {len(times)} dates, {len(values)} valeurs")
    for time_value, value in zip(times, values):
        if not isinstance(time_value, str) or len(time_value) < 10:
            raise ValueError(f"date invalide dans la serie : {time_value!r}")
        year = int(time_value[0:4])
        index = key_index(time_value[5:10])
        row = daily.get(year)
        if row is None:
            row = daily[year] = empty_year()
        row[index] = to_tenths(value)
    return daily


def series_to_daily(times: Sequence[str], values: Sequence[Any]) -> Daily:
    """Convertit une serie journaliere en dictionnaire ``annee -> 366 dixiemes ou None``."""
    return merge_series({}, times, values)


def daily_from_json(obj: Dict[str, Any]) -> Daily:
    """Relit la section ``daily`` d'un fichier de climatologie (cles texte -> entiers)."""
    daily: Daily = {}
    for year_text, row in obj.items():
        if not isinstance(row, list) or len(row) != DAYS_PER_RING:
            raise ValueError(f"annee {year_text} : tableau de {DAYS_PER_RING} entrees attendu")
        daily[int(year_text)] = [None if v is None else int(v) for v in row]
    return daily


def compute_normals(daily: Daily, normal_period: Tuple[int, int] = DEFAULT_NORMAL_PERIOD,
                    window_days: int = DEFAULT_WINDOW_DAYS) -> Tuple[list, list]:
    """Normales (moyenne, ecart-type population) par index, fenetre glissante sur l'anneau de 366 jours."""
    years = [year for year in sorted(daily) if normal_period[0] <= year <= normal_period[1]]
    means: List[Optional[float]] = []
    stds: List[Optional[float]] = []
    offsets = range(-window_days, window_days + 1)
    for index in range(DAYS_PER_RING):
        sample: List[float] = []
        for year in years:
            row = daily[year]
            for offset in offsets:
                value = row[(index + offset) % DAYS_PER_RING]
                if value is not None:
                    sample.append(value / 10)
        if not sample:
            means.append(None)
            stds.append(None)
            continue
        count = len(sample)
        total = 0.0
        for value in sample:
            total += value
        mean = total / count
        squares = 0.0
        for value in sample:
            delta = value - mean
            squares += delta * delta
        means.append(round2(mean))
        stds.append(round2(math.sqrt(squares / count)))
    return means, stds


def compute_annual(daily: Daily, normal_mean: Sequence[Optional[float]]) -> List[dict]:
    """Moyenne, anomalie, nombre de jours et indicateur ``partial`` par annee (annees croissantes)."""
    entries = []
    for year in sorted(daily):
        row = daily[year]
        total = 0.0
        count = 0
        anomaly_total = 0.0
        anomaly_count = 0
        for index, value in enumerate(row):
            if value is None:
                continue
            celsius = value / 10
            total += celsius
            count += 1
            normal = normal_mean[index]
            if normal is not None:
                anomaly_total += celsius - normal
                anomaly_count += 1
        entries.append({
            "year": year,
            "mean": round2(total / count) if count else None,
            "anomaly": round2(anomaly_total / anomaly_count) if anomaly_count else None,
            "days": count,
            "partial": count < PARTIAL_THRESHOLD_DAYS,
        })
    return entries


def compute_records(daily: Daily) -> Dict[str, list]:
    """Records par index : ``[valeur en degres C, premiere annee]`` pour le maximum et le minimum."""
    years = sorted(daily)
    maxima = []
    minima = []
    for index in range(DAYS_PER_RING):
        best_max = None
        year_max = None
        best_min = None
        year_min = None
        for year in years:
            value = daily[year][index]
            if value is None:
                continue
            if best_max is None or value > best_max:
                best_max = value
                year_max = year
            if best_min is None or value < best_min:
                best_min = value
                year_min = year
        maxima.append([None if best_max is None else best_max / 10, year_max])
        minima.append([None if best_min is None else best_min / 10, year_min])
    return {"max": maxima, "min": minima}


def make_location(location: Dict[str, Any]) -> Dict[str, Any]:
    """Copie du lieu limitee aux cles publiees dans le fichier (cles absentes -> null)."""
    return {key: location.get(key) for key in LOCATION_KEYS}


def make_source(source: Dict[str, Any]) -> Dict[str, Any]:
    """Section ``source`` dans l'ordre canonique, valeurs par defaut Open-Meteo/ERA5 completees."""
    return {key: source.get(key, SOURCE_DEFAULTS.get(key)) for key in SOURCE_KEYS}


def compute_climatology(daily: Daily, location: Dict[str, Any], source: Dict[str, Any],
                        normal_period: Tuple[int, int] = DEFAULT_NORMAL_PERIOD,
                        window_days: int = DEFAULT_WINDOW_DAYS) -> Dict[str, Any]:
    """Structure complete du fichier de climatologie a partir des dixiemes journaliers."""
    normal_mean, normal_std = compute_normals(daily, normal_period, window_days)
    return {
        "schema_version": SCHEMA_VERSION,
        "location": make_location(location),
        "source": make_source(source),
        "normal_period": [int(normal_period[0]), int(normal_period[1])],
        "window_days": int(window_days),
        "keys": list(KEYS),
        "normal_mean": normal_mean,
        "normal_std": normal_std,
        "records": compute_records(daily),
        "annual": compute_annual(daily, normal_mean),
        "daily": {str(year): list(daily[year]) for year in sorted(daily)},
    }


def build_climatology(times: Sequence[str], values: Sequence[Any], location: Dict[str, Any],
                      source: Dict[str, Any], normal_period: Tuple[int, int] = DEFAULT_NORMAL_PERIOD,
                      window_days: int = DEFAULT_WINDOW_DAYS) -> Dict[str, Any]:
    """Point d'entree pur : serie journaliere -> structure ``data/climatology/<slug>.json``."""
    daily = series_to_daily(times, values)
    return compute_climatology(daily, location, source, normal_period, window_days)
