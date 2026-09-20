"""Produit les fixtures partagees de climatologie (DATA_FORMATS.md, section 1.3).

Usage :
    python3 tests/fixtures/make_synthetic.py

Ecrit ``synthetic_series.json`` (serie journaliere deterministe 1989-01-01 -> 2024-03-15 :
sinusoide annuelle d'amplitude 9 autour de 11.5 degres, tendance +0.03 degre par an, bruit
pseudo-aleatoire dans [-2.5, 2.5] issu d'un generateur congruentiel a graine fixe, et
exactement 7 valeurs ``null``) puis ``synthetic_climatology_expected.json`` (sortie complete
de ``climatology_core.build_climatology`` sur cette serie). Les suites Python et JavaScript
verifient toutes deux l'egalite stricte avec cette sortie.
"""

from __future__ import annotations

import datetime as dt
import math
import sys
from pathlib import Path

FIXTURES_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = FIXTURES_DIR.parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import climatology_core  # noqa: E402  (import after sys.path setup)
from common import round2, write_json  # noqa: E402

SERIES_PATH = FIXTURES_DIR / "synthetic_series.json"
EXPECTED_PATH = FIXTURES_DIR / "synthetic_climatology_expected.json"

START = dt.date(1989, 1, 1)
END = dt.date(2024, 3, 15)
MEAN = 11.5
AMPLITUDE = 9.0
TREND_PER_YEAR = 0.03
NOISE_HALF_RANGE = 2.5
PHASE_DAYS = 115  # the sinusoid peaks in late July
SEED = 19890101
NULL_DATES = ("1989-01-01", "1990-06-15", "1992-02-29", "2005-07-14", "2013-12-31",
              "2023-11-30", "2024-03-15")

LOCATION = {
    "slug": "synthetique",
    "label": "Lieu synthetique",
    "lat": 45.0,
    "lon": 5.0,
    "timezone": "Europe/Paris",
    "country_code": "FR",
    "elevation": 100,
    "berkeley_region": "france",
}
SOURCE = {
    "provider": "Synthetique",
    "endpoint": "fixture://tests/fixtures/synthetic_series.json",
    "model": "synthetique",
    "dataset": "Serie synthetique de test",
    "grid_lat": 45.0,
    "grid_lon": 5.0,
    "grid_elevation": 100.0,
    "fetched_at": "2026-01-01T00:00:00Z",
    "start": START.isoformat(),
    "end": END.isoformat(),
    "variable": "temperature_2m_mean",
}


class Lcg:
    """Generateur congruentiel lineaire 32 bits (constantes de Numerical Recipes), deterministe."""

    def __init__(self, seed: int):
        self.state = seed & 0xFFFFFFFF

    def next_unit(self) -> float:
        self.state = (1664525 * self.state + 1013904223) & 0xFFFFFFFF
        return self.state / 4294967296.0


def make_series() -> dict:
    generator = Lcg(SEED)
    times = []
    values = []
    day = START
    index = 0
    while day <= END:
        iso = day.isoformat()
        day_of_year = day.timetuple().tm_yday
        seasonal = AMPLITUDE * math.sin(2 * math.pi * (day_of_year - PHASE_DAYS) / 365.25)
        trend = TREND_PER_YEAR * index / 365.25
        noise = (2 * generator.next_unit() - 1) * NOISE_HALF_RANGE
        value = round2(MEAN + seasonal + trend + noise)
        times.append(iso)
        values.append(None if iso in NULL_DATES else value)
        day += dt.timedelta(days=1)
        index += 1
    assert sum(1 for v in values if v is None) == len(NULL_DATES)
    return {"time": times, "temperature_2m_mean": values}


def main() -> int:
    series = make_series()
    write_json(SERIES_PATH, series, compact=True)
    expected = climatology_core.build_climatology(series["time"], series["temperature_2m_mean"],
                                                  LOCATION, SOURCE)
    write_json(EXPECTED_PATH, expected, compact=True)
    print(f"{SERIES_PATH.name} : {len(series['time'])} jours ecrits")
    print(f"{EXPECTED_PATH.name} : {len(expected['annual'])} annees ecrites")
    return 0


if __name__ == "__main__":
    sys.exit(main())
