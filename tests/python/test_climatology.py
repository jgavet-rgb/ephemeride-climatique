"""Tests du calcul de climatologie (climatology_core) et de son enveloppe CLI (build_climatology)."""

import contextlib
import datetime as dt
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
FIXTURES = ROOT / "tests" / "fixtures"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import build_climatology  # noqa: E402
import climatology_core as core  # noqa: E402
import common  # noqa: E402

LOCATION = {"slug": "test", "label": "Test", "lat": 1.0, "lon": 2.0, "timezone": "UTC",
            "country_code": "XX", "elevation": 10, "berkeley_region": "test", "extra": "dropped"}
SOURCE = {"grid_lat": 1.0, "grid_lon": 2.0, "grid_elevation": 10.0, "fetched_at": "2026-01-01T00:00:00Z",
          "start": "1990-01-01", "end": "2021-12-31"}


def date_range(start: str, end: str):
    day = dt.date.fromisoformat(start)
    last = dt.date.fromisoformat(end)
    while day <= last:
        yield day.isoformat()
        day += dt.timedelta(days=1)


def is_leap(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


class KeysAndRoundingTests(unittest.TestCase):
    def test_keys(self):
        self.assertEqual(len(common.KEYS), 366)
        self.assertEqual(common.KEYS[0], "01-01")
        self.assertEqual(common.KEYS[59], "02-29")
        self.assertEqual(common.KEYS[365], "12-31")
        self.assertEqual(common.key_index("02-29"), 59)
        self.assertEqual(common.key_index("12-31"), 365)
        with self.assertRaises(ValueError):
            common.key_index("13-01")

    def test_round2(self):
        self.assertEqual(common.round2(1.005), 1.0)  # 1.005 * 100 is slightly below 100.5 in IEEE 754
        self.assertEqual(common.round2(2.675), 2.68)
        self.assertEqual(common.round2(-0.125), -0.12)
        self.assertEqual(common.round2(12.0), 12.0)

    def test_to_tenths_half_away_from_zero(self):
        self.assertEqual(common.to_tenths(0.05), 1)
        self.assertEqual(common.to_tenths(-0.05), -1)
        self.assertEqual(common.to_tenths(21.8), 218)
        self.assertEqual(common.to_tenths(-9.7), -97)
        self.assertEqual(common.to_tenths(0.0), 0)
        self.assertEqual(common.to_tenths(-0.04), 0)
        self.assertIsNone(common.to_tenths(None))
        self.assertIsNone(common.to_tenths(float("nan")))


class ExpectedFixtureTests(unittest.TestCase):
    """(a) egalite stricte avec la fixture partagee."""

    def test_matches_expected_fixture(self):
        series = json.loads((FIXTURES / "synthetic_series.json").read_text(encoding="utf-8"))
        expected = json.loads((FIXTURES / "synthetic_climatology_expected.json").read_text(encoding="utf-8"))
        result = core.build_climatology(series["time"], series["temperature_2m_mean"],
                                        expected["location"], expected["source"])
        self.assertEqual(result, expected)
        # The serialized form must round-trip to the very same document.
        self.assertEqual(json.loads(common.dump_json(result)), expected)

    def test_fixture_properties(self):
        series = json.loads((FIXTURES / "synthetic_series.json").read_text(encoding="utf-8"))
        self.assertEqual(series["time"][0], "1989-01-01")
        self.assertEqual(series["time"][-1], "2024-03-15")
        self.assertEqual(sum(1 for v in series["temperature_2m_mean"] if v is None), 7)
        null_dates = {t for t, v in zip(series["time"], series["temperature_2m_mean"]) if v is None}
        self.assertIn("1992-02-29", null_dates)
        self.assertIn("2005-07-14", null_dates)


class ConstantSeriesTests(unittest.TestCase):
    """(b) cas verifiable a la main : serie constante 12.0 de 1990 a 2021."""

    @classmethod
    def setUpClass(cls):
        times = list(date_range("1990-01-01", "2021-12-31"))
        cls.result = core.build_climatology(times, [12.0] * len(times), LOCATION, SOURCE)

    def test_structure(self):
        result = self.result
        self.assertEqual(result["schema_version"], 1)
        self.assertEqual(result["normal_period"], [1991, 2020])
        self.assertEqual(result["window_days"], 7)
        self.assertEqual(result["keys"], list(common.KEYS))
        self.assertEqual(result["location"], {"slug": "test", "label": "Test", "lat": 1.0, "lon": 2.0,
                                              "timezone": "UTC", "country_code": "XX", "elevation": 10,
                                              "berkeley_region": "test"})
        self.assertEqual(list(result["source"]), list(core.SOURCE_KEYS))
        self.assertEqual(result["source"]["provider"], "Open-Meteo")
        self.assertEqual(result["source"]["model"], "era5")
        self.assertEqual(result["source"]["variable"], "temperature_2m_mean")
        self.assertEqual(result["source"]["start"], "1990-01-01")
        self.assertEqual(sorted(result["daily"]), [str(y) for y in range(1990, 2022)])

    def test_normals(self):
        self.assertEqual(self.result["normal_mean"], [12.0] * 366)
        self.assertEqual(self.result["normal_std"], [0.0] * 366)

    def test_annual(self):
        annual = self.result["annual"]
        self.assertEqual([entry["year"] for entry in annual], list(range(1990, 2022)))
        for entry in annual:
            self.assertEqual(entry["mean"], 12.0)
            self.assertEqual(entry["anomaly"], 0.0)
            self.assertFalse(entry["partial"])
            self.assertEqual(entry["days"], 366 if is_leap(entry["year"]) else 365)

    def test_records(self):
        records = self.result["records"]
        for index in range(366):
            expected_year = 1992 if index == 59 else 1990  # 1990 has no 29 February
            self.assertEqual(records["max"][index], [12.0, expected_year])
            self.assertEqual(records["min"][index], [12.0, expected_year])

    def test_daily_values(self):
        self.assertEqual(self.result["daily"]["1990"][0], 120)
        self.assertEqual(self.result["daily"]["2021"][365], 120)


class LeapDayTests(unittest.TestCase):
    """(c) l'index 59 (02-29) est null les annees non bissextiles."""

    def test_leap_day_index(self):
        times = list(date_range("1999-01-01", "2004-12-31"))
        result = core.build_climatology(times, [5.5] * len(times), LOCATION, SOURCE)
        for year in (1999, 2001, 2002, 2003):
            self.assertIsNone(result["daily"][str(year)][59], year)
        for year in (2000, 2004):
            self.assertEqual(result["daily"][str(year)][59], 55, year)
        self.assertEqual(result["annual"][0]["days"], 365)
        self.assertEqual(result["annual"][1]["days"], 366)


class PartialYearTests(unittest.TestCase):
    """(d) une serie qui s'arrete en cours d'annee donne partial = true."""

    def test_partial_last_year(self):
        times = list(date_range("2019-01-01", "2021-05-10"))
        result = core.build_climatology(times, [10.0] * len(times), LOCATION, SOURCE)
        by_year = {entry["year"]: entry for entry in result["annual"]}
        self.assertFalse(by_year[2019]["partial"])
        self.assertFalse(by_year[2020]["partial"])
        self.assertTrue(by_year[2021]["partial"])
        self.assertEqual(by_year[2021]["days"], 130)
        self.assertEqual(result["daily"]["2021"][common.key_index("05-10")], 100)
        self.assertIsNone(result["daily"]["2021"][common.key_index("05-11")])  # beyond the series

    def test_partial_threshold(self):
        # 359 days -> partial, 360 days -> not partial.
        times = list(date_range("2021-01-01", "2021-12-25"))  # 359 days
        result = core.build_climatology(times, [1.0] * len(times), LOCATION, SOURCE)
        self.assertEqual(result["annual"][0]["days"], 359)
        self.assertTrue(result["annual"][0]["partial"])
        times = list(date_range("2021-01-01", "2021-12-26"))  # 360 days
        result = core.build_climatology(times, [1.0] * len(times), LOCATION, SOURCE)
        self.assertFalse(result["annual"][0]["partial"])


class AlgorithmDetailTests(unittest.TestCase):
    def test_window_wraps_around_the_ring(self):
        daily = {2000: core.empty_year()}
        daily[2000][365] = 200  # only 31 December is known
        means, stds = core.compute_normals(daily, (2000, 2000), 7)
        for index in range(0, 7):
            self.assertEqual(means[index], 20.0, index)
            self.assertEqual(stds[index], 0.0, index)
        self.assertIsNone(means[7])
        self.assertEqual(means[358], 20.0)
        self.assertIsNone(means[357])

    def test_population_std_and_null_skipping(self):
        daily = {2000: core.empty_year(), 2001: core.empty_year(), 2002: core.empty_year()}
        daily[2000][100] = 100
        daily[2001][100] = 140
        # 2002 stays null everywhere: skipped, not counted as zero.
        means, stds = core.compute_normals(daily, (1991, 2020), 0)
        self.assertEqual(means[100], 12.0)
        self.assertEqual(stds[100], 2.0)  # population std (divisor n), not 2.83
        self.assertIsNone(means[101])

    def test_empty_normal_period_gives_nulls(self):
        times = list(date_range("1950-01-01", "1950-12-31"))
        result = core.build_climatology(times, [3.0] * len(times), LOCATION, SOURCE)
        self.assertEqual(result["normal_mean"], [None] * 366)
        self.assertEqual(result["normal_std"], [None] * 366)
        self.assertEqual(result["annual"][0]["mean"], 3.0)
        self.assertIsNone(result["annual"][0]["anomaly"])

    def test_records_first_year_rule(self):
        daily = {1995: core.empty_year(), 1996: core.empty_year(), 1997: core.empty_year()}
        daily[1995][10] = 150
        daily[1996][10] = 150
        daily[1997][10] = -30
        records = core.compute_records(daily)
        self.assertEqual(records["max"][10], [15.0, 1995])
        self.assertEqual(records["min"][10], [-3.0, 1997])
        self.assertEqual(records["max"][11], [None, None])
        self.assertEqual(records["min"][11], [None, None])

    def test_annual_anomaly_excludes_days_without_normal(self):
        daily = {2000: core.empty_year()}
        daily[2000][0] = 100
        daily[2000][1] = 200
        annual = core.compute_annual(daily, [9.0] + [None] * 365)
        self.assertEqual(annual[0]["mean"], 15.0)
        self.assertEqual(annual[0]["anomaly"], 1.0)  # only index 0 has a normal
        self.assertEqual(annual[0]["days"], 2)
        self.assertTrue(annual[0]["partial"])

    def test_year_with_only_nulls(self):
        result = core.build_climatology(["2000-01-01", "2000-01-02"], [None, None], LOCATION, SOURCE)
        self.assertEqual(result["annual"], [{"year": 2000, "mean": None, "anomaly": None, "days": 0, "partial": True}])

    def test_merge_series_equals_full_build(self):
        series = json.loads((FIXTURES / "synthetic_series.json").read_text(encoding="utf-8"))
        times, values = series["time"], series["temperature_2m_mean"]
        cut = times.index("2010-06-15")
        daily = core.series_to_daily(times[:cut], values[:cut])
        core.merge_series(daily, times[cut:], values[cut:])
        self.assertEqual(daily, core.series_to_daily(times, values))
        restored = core.daily_from_json({str(year): row for year, row in daily.items()})
        self.assertEqual(restored, daily)

    def test_length_mismatch_raises(self):
        with self.assertRaises(ValueError):
            core.series_to_daily(["2000-01-01"], [1.0, 2.0])


class BuildClimatologyCliTests(unittest.TestCase):
    """Enveloppe CLI en mode hors ligne (--input), incremental et simulation."""

    @classmethod
    def setUpClass(cls):
        cls.series = json.loads((FIXTURES / "synthetic_series.json").read_text(encoding="utf-8"))
        cls.expected = json.loads((FIXTURES / "synthetic_climatology_expected.json").read_text(encoding="utf-8"))

    @staticmethod
    def response(times, values):
        return {"latitude": 45.25, "longitude": 5.0, "elevation": 214.0, "timezone": "Europe/Paris",
                "daily_units": {"time": "iso8601", "temperature_2m_mean": "°C"},
                "daily": {"time": times, "temperature_2m_mean": values}}

    def run_cli(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = build_climatology.main(argv)
        return code, out.getvalue(), err.getvalue()

    def write_locations(self, folder: Path) -> Path:
        path = folder / "locations.json"
        path.write_text(json.dumps({"schema_version": 1, "locations": [self.expected["location"]]}), encoding="utf-8")
        return path

    def test_url_is_exact(self):
        url = build_climatology.build_url(45.1885, 5.7245, "1940-01-01", "2026-09-11")
        self.assertEqual(url, "https://archive-api.open-meteo.com/v1/archive?latitude=45.1885&longitude=5.7245"
                              "&start_date=1940-01-01&end_date=2026-09-11&daily=temperature_2m_mean"
                              "&timezone=auto&models=era5")

    def test_offline_full_then_incremental(self):
        times, values = self.series["time"], self.series["temperature_2m_mean"]
        cut = times.index("2024-01-01")
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            locations = self.write_locations(folder)
            (folder / "part1.json").write_text(json.dumps(self.response(times[:cut], values[:cut])), encoding="utf-8")
            (folder / "part2.json").write_text(json.dumps(self.response(times[cut:], values[cut:])), encoding="utf-8")
            out_dir = folder / "climatology"
            code, out, _ = self.run_cli(["--locations", str(locations), "--slug", "synthetique",
                                         "--input", str(folder / "part1.json"), "--out-dir", str(out_dir)])
            self.assertEqual(code, 0, out)
            self.assertIn("synthetique : 12783 jours, 1989-01-01 -> 2023-12-31, fichier ecrit", out)
            code, out, _ = self.run_cli(["--locations", str(locations), "--slug", "synthetique",
                                         "--input", str(folder / "part2.json"), "--out-dir", str(out_dir)])
            self.assertEqual(code, 0, out)
            self.assertIn("12858 jours, 1989-01-01 -> 2024-03-15", out)
            result = json.loads((out_dir / "synthetique.json").read_text(encoding="utf-8"))
            for section in ("keys", "normal_mean", "normal_std", "records", "annual", "daily", "location"):
                self.assertEqual(result[section], self.expected[section], section)
            self.assertEqual(result["source"]["grid_lat"], 45.25)
            self.assertEqual(result["source"]["grid_elevation"], 214.0)
            self.assertEqual(result["source"]["start"], "1989-01-01")
            self.assertEqual(result["source"]["end"], "2024-03-15")
            self.assertTrue(result["source"]["fetched_at"].endswith("Z"))
            raw = (out_dir / "synthetique.json").read_bytes()
            self.assertNotIn(b": ", raw[:200])  # compact separators
            self.assertTrue(raw.endswith(b"\n"))
            # Already up to date: nothing fetched, nothing rewritten.
            before = (out_dir / "synthetique.json").stat().st_mtime_ns
            code, out, _ = self.run_cli(["--locations", str(locations), "--slug", "synthetique",
                                         "--out-dir", str(out_dir), "--end-date", "2024-03-10"])
            self.assertEqual(code, 0)
            self.assertIn("deja a jour", out)
            self.assertEqual((out_dir / "synthetique.json").stat().st_mtime_ns, before)
            # Dry run does not write.
            code, out, _ = self.run_cli(["--locations", str(locations), "--slug", "synthetique", "--full",
                                         "--input", str(folder / "part1.json"), "--out-dir", str(folder / "dry"),
                                         "--dry-run"])
            self.assertEqual(code, 0)
            self.assertIn("simulation", out)
            self.assertFalse((folder / "dry").exists())

    def test_errors_are_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            locations = self.write_locations(folder)
            code, _, err = self.run_cli(["--locations", str(folder / "missing.json")])
            self.assertEqual(code, 1)
            self.assertIn("introuvable", err)
            code, _, err = self.run_cli(["--input", str(folder / "x.json")])
            self.assertEqual(code, 2)
            code, _, err = self.run_cli(["--locations", str(locations), "--slug", "inconnu", "--input", "x"])
            self.assertEqual(code, 1)
            self.assertIn("lieu inconnu", err)
            (folder / "bad.json").write_text(json.dumps({"error": True, "reason": "Sample failure"}), encoding="utf-8")
            code, _, err = self.run_cli(["--locations", str(locations), "--slug", "synthetique",
                                         "--input", str(folder / "bad.json"), "--out-dir", str(folder / "out")])
            self.assertEqual(code, 1)
            self.assertIn("Sample failure", err)
            self.assertFalse((folder / "out").exists())

    def test_extract_series_accepts_suffixed_variable(self):
        response = {"daily": {"time": ["2000-01-01"], "temperature_2m_mean_era5": [1.0]}}
        self.assertEqual(build_climatology.extract_series(response), (["2000-01-01"], [1.0]))
        with self.assertRaises(build_climatology.BuildError):
            build_climatology.extract_series({"daily": {"time": []}})


if __name__ == "__main__":
    unittest.main()
