"""Analyse des fichiers Berkeley Earth ``*-TAVG-Trend.txt`` et calcul de ``delta_c`` (DATA_FORMATS.md, section 2).

Fonctions pures, sans entree-sortie :

- ``parse_berkeley(text)`` : en-tete (date d'analyse, temperature absolue de reference) et
  liste des triplets ``(annee, mois, anomalie ou None)``.
- ``annual_means(monthly)`` : anomalie annuelle = moyenne des mois valides si au moins
  10 mois valides, sinon ``None``.
- ``compute_delta(annual, pre_window, ref_window)`` : difference des moyennes de fenetre,
  chaque fenetre exigeant au moins 25 annees valides ; retourne ``(delta ou None, n_pre, n_ref)``.
"""

from __future__ import annotations

import math
import re
from typing import Dict, List, Optional, Sequence, Tuple

from common import round2

MIN_VALID_MONTHS = 10
MIN_VALID_YEARS = 25
PRE_WINDOW = (1850, 1900)
REF_WINDOW = (1991, 2020)

_RUN_ON_RE = re.compile(r"run on\s*(.+?)\s*$", re.IGNORECASE)
_ABS_TEMP_RE = re.compile(r"absolute temperature \(C\)\s*:\s*([-+]?\d+(?:\.\d+)?)", re.IGNORECASE)

MonthlyRow = Tuple[int, int, Optional[float]]


def _parse_anomaly(token: str) -> Optional[float]:
    """Nombre flottant ou None pour ``NaN`` / valeur illisible."""
    try:
        value = float(token)
    except ValueError:
        return None
    if math.isnan(value) or math.isinf(value):
        return None
    return value


def parse_berkeley(text: str) -> dict:
    """Analyse un fichier Berkeley Earth (lignes ``%`` = commentaires, puis annee, mois, anomalie, ...)."""
    header = {"analysis_date": None, "base_abs_temp": None}
    monthly: List[MonthlyRow] = []
    seen = set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("%"):
            content = line.lstrip("%").strip()
            if header["analysis_date"] is None:
                match = _RUN_ON_RE.search(content)
                if match:
                    header["analysis_date"] = match.group(1).strip()
            if header["base_abs_temp"] is None:
                match = _ABS_TEMP_RE.search(content)
                if match:
                    header["base_abs_temp"] = float(match.group(1))
            continue
        parts = line.split()
        if len(parts) < 3:
            continue
        try:
            year = int(parts[0])
            month = int(parts[1])
        except ValueError:
            continue
        if not 1 <= month <= 12:
            continue
        key = (year, month)
        if key in seen:
            continue  # a second table in the same file (same layout) is ignored
        seen.add(key)
        monthly.append((year, month, _parse_anomaly(parts[2])))
    return {"header": header, "monthly": monthly}


def annual_means(monthly: Sequence[MonthlyRow], min_months: int = MIN_VALID_MONTHS) -> Dict[int, Optional[float]]:
    """Anomalie annuelle par annee : moyenne des mois valides (>= ``min_months``), sinon None."""
    by_year: Dict[int, List[Optional[float]]] = {}
    for year, _month, anomaly in monthly:
        by_year.setdefault(year, []).append(anomaly)
    result: Dict[int, Optional[float]] = {}
    for year in sorted(by_year):
        valid = [value for value in by_year[year] if value is not None]
        if len(valid) >= min_months:
            result[year] = sum(valid) / len(valid)
        else:
            result[year] = None
    return result


def window_mean(annual: Dict[int, Optional[float]], window: Tuple[int, int],
                min_years: int = MIN_VALID_YEARS) -> Tuple[Optional[float], int]:
    """Moyenne des anomalies annuelles valides d'une fenetre inclusive et nombre d'annees valides."""
    values = [annual[year] for year in range(window[0], window[1] + 1) if annual.get(year) is not None]
    count = len(values)
    if count < min_years:
        return None, count
    return sum(values) / count, count


def compute_delta(annual: Dict[int, Optional[float]], pre_window: Tuple[int, int] = PRE_WINDOW,
                  ref_window: Tuple[int, int] = REF_WINDOW,
                  min_years: int = MIN_VALID_YEARS) -> Tuple[Optional[float], int, int]:
    """``delta_c = round2(moyenne(ref) - moyenne(pre))`` ou None si une fenetre manque d'annees valides."""
    pre_mean, n_pre = window_mean(annual, pre_window, min_years)
    ref_mean, n_ref = window_mean(annual, ref_window, min_years)
    if pre_mean is None or ref_mean is None:
        return None, n_pre, n_ref
    return round2(ref_mean - pre_mean), n_pre, n_ref
