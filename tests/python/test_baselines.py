"""Tests de l'analyse Berkeley Earth (baselines_core) et de build_baselines en mode hors ligne."""

import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
FIXTURES = ROOT / "tests" / "fixtures"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import baselines_core as core  # noqa: E402
import build_baselines  # noqa: E402

SAMPLE = FIXTURES / "berkeley_sample-TAVG-Trend.txt"
SHORT = FIXTURES / "berkeley_short-TAVG-Trend.txt"


class ParseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.parsed = core.parse_berkeley(SAMPLE.read_text(encoding="utf-8"))

    def test_header(self):
        self.assertEqual(self.parsed["header"]["analysis_date"], "01-Jan-2026 00:00:00")
        self.assertEqual(self.parsed["header"]["base_abs_temp"], 12.96)

    def test_monthly_rows(self):
        monthly = self.parsed["monthly"]
        self.assertEqual(len(monthly), (2024 - 1845 + 1) * 12)
        self.assertEqual(monthly[0][:2], (1845, 1))
        self.assertEqual(monthly[-1][:2], (2024, 12))
        by_key = {(year, month): anomaly for year, month, anomaly in monthly}
        self.assertEqual(by_key[(1850, 1)], -0.5)
        self.assertIsNone(by_key[(1860, 9)])  # NaN -> None
        self.assertEqual(by_key[(1860, 8)], -0.5)
        self.assertIsNone(by_key[(1875, 6)])
        self.assertEqual(by_key[(2000, 3)], 1.3)

    def test_single_percent_header_and_duplicate_table(self):
        text = ("% Estimated Jan 1951-Dec 1980 absolute temperature (C): 8.50 +/- 0.20\n"
                "% This analysis was run on 06-Jan-2021 14:12:36\n"
                "%\n"
                "  1900     1    0.100  0.100\n"
                "  1900     2      NaN    NaN\n"
                "  1900    13    9.999  0.100\n"
                "  garbage line\n"
                "% second table with the same layout\n"
                "  1900     1    5.000  0.100\n")
        parsed = core.parse_berkeley(text)
        self.assertEqual(parsed["header"]["analysis_date"], "06-Jan-2021 14:12:36")
        self.assertEqual(parsed["header"]["base_abs_temp"], 8.5)
        self.assertEqual(parsed["monthly"], [(1900, 1, 0.1), (1900, 2, None)])

    def test_empty_text(self):
        parsed = core.parse_berkeley("")
        self.assertEqual(parsed["monthly"], [])
        self.assertIsNone(parsed["header"]["analysis_date"])


class AnnualAndDeltaTests(unittest.TestCase):
    def test_annual_means_sample(self):
        parsed = core.parse_berkeley(SAMPLE.read_text(encoding="utf-8"))
        annual = core.annual_means(parsed["monthly"])
        self.assertIsNone(annual[1860])  # only 8 valid months
        self.assertEqual(annual[1875], -0.5)  # 11 valid months
        self.assertEqual(annual[1850], -0.5)
        self.assertAlmostEqual(annual[2000], 1.3)
        self.assertIsNotNone(annual[1845])

    def test_min_months_boundary(self):
        rows = [(1900, month, 1.0) for month in range(1, 11)] + [(1900, 11, None), (1900, 12, None)]
        self.assertEqual(core.annual_means(rows), {1900: 1.0})
        rows = [(1900, month, 1.0) for month in range(1, 10)] + [(1900, m, None) for m in (10, 11, 12)]
        self.assertEqual(core.annual_means(rows), {1900: None})

    def test_compute_delta_sample(self):
        parsed = core.parse_berkeley(SAMPLE.read_text(encoding="utf-8"))
        annual = core.annual_means(parsed["monthly"])
        self.assertEqual(core.compute_delta(annual, core.PRE_WINDOW, core.REF_WINDOW), (1.8, 50, 30))

    def test_compute_delta_short_series(self):
        parsed = core.parse_berkeley(SHORT.read_text(encoding="utf-8"))
        annual = core.annual_means(parsed["monthly"])
        self.assertEqual(core.compute_delta(annual, core.PRE_WINDOW, core.REF_WINDOW), (None, 0, 30))

    def test_min_years_boundary_and_rounding(self):
        annual = {year: -0.25 for year in range(1850, 1874)}  # 24 valid years
        annual.update({year: 1.0 for year in range(1991, 2021)})
        self.assertEqual(core.compute_delta(annual, (1850, 1900), (1991, 2020)), (None, 24, 30))
        annual[1874] = -0.25  # 25 valid years
        self.assertEqual(core.compute_delta(annual, (1850, 1900), (1991, 2020)), (1.25, 25, 30))
        annual[1874] = None  # None entries are not counted
        self.assertEqual(core.compute_delta(annual, (1850, 1900), (1991, 2020)), (None, 24, 30))
        self.assertEqual(core.compute_delta(annual, (1850, 1900), (1991, 2020), min_years=10)[0], 1.25)


class BuildBaselinesCliTests(unittest.TestCase):
    """Chaine de repli region -> continent -> monde, en mode --input-dir."""

    def run_cli(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = build_baselines.main(argv)
        return code, out.getvalue(), err.getvalue()

    @staticmethod
    def write_locations(folder: Path, locations) -> Path:
        path = folder / "locations.json"
        path.write_text(json.dumps({"schema_version": 1, "locations": locations}), encoding="utf-8")
        return path

    @staticmethod
    def location(slug, region, fallback=None, country=None):
        entry = {"slug": slug, "label": slug.title(), "lat": 0.0, "lon": 0.0, "timezone": "UTC",
                 "country_code": "XX", "berkeley_region": region}
        if fallback:
            entry["berkeley_fallback"] = fallback
        if country:
            entry["country"] = country
        return entry

    def test_direct_fallback_and_global(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            berkeley = folder / "berkeley"
            berkeley.mkdir()
            shutil.copy(SAMPLE, berkeley / "france-TAVG-Trend.txt")
            shutil.copy(SAMPLE, berkeley / "europe-TAVG-Trend.txt")
            shutil.copy(SAMPLE, berkeley / "Complete_TAVG_complete.txt")
            shutil.copy(SHORT, berkeley / "shortland-TAVG-Trend.txt")
            locations = self.write_locations(folder, [
                self.location("grenoble", "france", "europe", country="France"),
                self.location("lyon", "france", "europe", country="France"),
                self.location("elsewhere", "missing-region", "europe"),
                self.location("faraway", "shortland", "nowhere"),
            ])
            out_path = folder / "baselines.json"
            code, out, err = self.run_cli(["--locations", str(locations), "--out", str(out_path),
                                           "--input-dir", str(berkeley)])
            self.assertEqual(code, 0, err)
            data = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertEqual(data["schema_version"], 1)
            self.assertIn("1991-2020", data["method"])
            self.assertEqual(list(data["regions"]), ["france", "missing-region", "shortland"])

            france = data["regions"]["france"]
            self.assertEqual(france["label"], "France")
            self.assertEqual(france["delta_c"], 1.8)
            self.assertEqual((france["n_pre"], france["n_ref"]), (50, 30))
            self.assertEqual(france["pre_window"], [1850, 1900])
            self.assertEqual(france["ref_window"], [1991, 2020])
            self.assertEqual(france["anomaly_base"], "1951-1980")
            self.assertEqual(france["source_url"], build_baselines.REGION_URL.format(region="france"))
            self.assertEqual(france["analysis_date"], "01-Jan-2026 00:00:00")
            self.assertEqual(france["licence"], "CC BY-NC 4.0")
            self.assertIsNone(france["fallback_from"])
            self.assertIsNone(france["note"])

            fallback = data["regions"]["missing-region"]
            self.assertEqual(fallback["delta_c"], 1.8)
            self.assertEqual(fallback["fallback_from"], "missing-region")
            self.assertEqual(fallback["source_url"], build_baselines.REGION_URL.format(region="europe"))
            self.assertIn("repli sur 'europe'", fallback["note"])

            # shortland parses but lacks pre-industrial years, nowhere is missing: global series used.
            world = data["regions"]["shortland"]
            self.assertEqual(world["delta_c"], 1.8)
            self.assertEqual(world["fallback_from"], "shortland")
            self.assertEqual(world["source_url"], build_baselines.GLOBAL_URL)
            self.assertIn("france : delta_c 1.8", out)

    def test_everything_fails_gives_null_and_exit_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            berkeley = folder / "berkeley"
            berkeley.mkdir()
            shutil.copy(SHORT, berkeley / "Complete_TAVG_complete.txt")
            locations = self.write_locations(folder, [self.location("x", "unknown-region", "unknown-continent")])
            out_path = folder / "baselines.json"
            code, out, err = self.run_cli(["--locations", str(locations), "--out", str(out_path),
                                           "--input-dir", str(berkeley)])
            self.assertEqual(code, 1)
            data = json.loads(out_path.read_text(encoding="utf-8"))
            region = data["regions"]["unknown-region"]
            self.assertIsNone(region["delta_c"])
            self.assertIsNone(region["analysis_date"])
            self.assertIsNone(region["fallback_from"])
            self.assertIn("aucune source", region["note"])
            self.assertIn("unknown-continent", region["note"])
            self.assertEqual((region["n_pre"], region["n_ref"]), (0, 30))
            self.assertIn("indisponible", out)

    def test_orphan_regions_kept_unless_force(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            berkeley = folder / "berkeley"
            berkeley.mkdir()
            shutil.copy(SAMPLE, berkeley / "france-TAVG-Trend.txt")
            shutil.copy(SAMPLE, berkeley / "Complete_TAVG_complete.txt")
            out_path = folder / "baselines.json"
            locations = self.write_locations(folder, [self.location("a", "france"), self.location("b", "old-region")])
            code, _, _ = self.run_cli(["--locations", str(locations), "--out", str(out_path), "--input-dir", str(berkeley)])
            self.assertEqual(code, 0)
            first = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertEqual(first["regions"]["old-region"]["fallback_from"], "old-region")

            # The location using old-region disappears: the entry is kept verbatim by default.
            locations = self.write_locations(folder, [self.location("a", "france")])
            code, _, err = self.run_cli(["--locations", str(locations), "--out", str(out_path), "--input-dir", str(berkeley)])
            self.assertEqual(code, 0)
            second = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertEqual(list(second["regions"]), ["france", "old-region"])
            self.assertEqual(second["regions"]["old-region"], first["regions"]["old-region"])
            self.assertIn("conservee", err)

            # With --force the orphan is recomputed (here through the global series again).
            code, _, _ = self.run_cli(["--locations", str(locations), "--out", str(out_path),
                                       "--input-dir", str(berkeley), "--force"])
            self.assertEqual(code, 0)
            third = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertEqual(list(third["regions"]), ["france", "old-region"])
            self.assertNotEqual(third["regions"]["old-region"]["fetched_at"], "")

    def test_missing_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            code, _, err = self.run_cli(["--locations", str(folder / "none.json"), "--out", str(folder / "b.json")])
            self.assertEqual(code, 1)
            self.assertIn("introuvable", err)
            locations = self.write_locations(folder, [self.location("a", "france")])
            code, _, err = self.run_cli(["--locations", str(locations), "--out", str(folder / "b.json"),
                                         "--input-dir", str(folder / "nodir")])
            self.assertEqual(code, 1)

    def test_region_label(self):
        self.assertEqual(build_baselines.region_label("france", [{"country": "France"}]), "France")
        self.assertEqual(build_baselines.region_label("united-states", [{"country": "Etats-Unis"}]), "United States")
        self.assertEqual(build_baselines.slugify("Côte d'Ivoire"), "cote-d-ivoire")


if __name__ == "__main__":
    unittest.main()
