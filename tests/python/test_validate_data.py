"""Tests de validate_data : saints, calendrier republicain, lieux, baselines et climatologies."""

import contextlib
import copy
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
FIXTURES = ROOT / "tests" / "fixtures"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import common  # noqa: E402
import validate_data  # noqa: E402


def valid_saints():
    return {"_source": "test", "_licence": "test", "_note": "test",
            "days": {key: {"saint": f"Saint {key}", "names": [f"Nom{index}"] if index % 3 else []}
                     for index, key in enumerate(common.KEYS)}}


def valid_republican():
    return {"_source": "test", "_licence": "test",
            "months": [f"Mois {i}" for i in range(12)],
            "days": [f"Jour {i}" for i in range(360)],
            "complementary": [f"Complementaire {i}" for i in range(6)],
            "decade_days": [f"Decade {i}" for i in range(10)]}


def valid_locations():
    return {"schema_version": 1, "locations": [
        {"slug": "synthetique", "label": "Lieu synthetique", "lat": 45.0, "lon": 5.0, "timezone": "Europe/Paris",
         "country_code": "FR", "elevation": 100, "berkeley_region": "france", "berkeley_fallback": "europe"},
        {"slug": "autre-lieu-2", "label": "Autre", "lat": -10.5, "lon": 120.25, "timezone": "UTC",
         "country_code": "XX", "berkeley_region": "france"},
    ]}


def valid_baselines():
    return {"schema_version": 1, "generated_at": "2026-09-17T06:35:00Z", "method": "methode de test", "regions": {
        "france": {"label": "France", "delta_c": 1.8, "pre_window": [1850, 1900], "ref_window": [1991, 2020],
                   "n_pre": 50, "n_ref": 30, "anomaly_base": "1951-1980", "source_url": "https://example.org/f.txt",
                   "attribution": "Berkeley Earth (berkeleyearth.org)", "licence": "CC BY-NC 4.0",
                   "analysis_date": "01-Jan-2026 00:00:00", "fetched_at": "2026-09-17T06:35:00Z",
                   "fallback_from": None, "note": None}}}


class ValidateDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.climatology = json.loads((FIXTURES / "synthetic_climatology_expected.json").read_text(encoding="utf-8"))

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name) / "data"
        (self.data / "climatology").mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, value):
        path = self.data / name
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def write_all(self, with_optional=True):
        self.write("saints.json", valid_saints())
        self.write("republican.json", valid_republican())
        self.write("locations.json", valid_locations())
        if with_optional:
            self.write("baselines.json", valid_baselines())
            self.write("climatology/synthetique.json", self.climatology)

    def run_cli(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = validate_data.main(["--data-dir", str(self.data)])
        return code, out.getvalue()

    def report(self):
        return validate_data.validate_data_dir(self.data)

    def test_valid_tree(self):
        self.write_all()
        code, out = self.run_cli()
        self.assertEqual(code, 0, out)
        self.assertIn("OK, 0 erreur(s), 0 avertissement(s)", out)
        self.assertIn("saints.json : 366 jours, OK", out)
        self.assertIn(f"climatology{os.sep}synthetique.json : 36 annee(s), OK", out)

    def test_missing_optional_is_info_and_missing_required_is_error(self):
        self.write_all(with_optional=False)
        (self.data / "climatology").rmdir()
        report = self.report()
        self.assertEqual(report.errors, [])
        self.assertTrue(any("baselines.json : absent (facultatif)" in line for line in report.infos))
        self.assertTrue(any("climatology : dossier absent (facultatif)" in line for line in report.infos))
        (self.data / "saints.json").unlink()
        (self.data / "republican.json").unlink()
        (self.data / "locations.json").unlink()
        code, out = self.run_cli()
        self.assertEqual(code, 1)
        for name in ("saints.json", "republican.json", "locations.json"):
            self.assertIn(f"{name} : fichier obligatoire introuvable", out)
        self.assertIn("ECHEC, 3 erreur(s)", out)

    def test_empty_data_dir_does_not_crash(self):
        (self.data / "climatology").rmdir()
        self.data.rmdir()
        code, out = self.run_cli()
        self.assertEqual(code, 1)
        self.assertIn("3 erreur(s)", out)

    def test_invalid_json_file(self):
        self.write_all()
        (self.data / "saints.json").write_text("{broken", encoding="utf-8")
        report = self.report()
        self.assertTrue(any("saints.json : JSON invalide" in line for line in report.errors))

    def test_saints_errors(self):
        self.write_all()
        saints = valid_saints()
        del saints["days"]["02-29"]
        saints["days"]["13-01"] = {"saint": "x", "names": []}
        saints["days"]["01-01"] = {"saint": "  ", "names": []}
        saints["days"]["01-02"] = {"saint": "Ok", "names": "Nom"}
        saints["days"]["01-03"] = {"saint": "Ok", "names": ["", "Nom"]}
        self.write("saints.json", saints)
        report = self.report()
        joined = "\n".join(report.errors)
        self.assertIn("manquante(s) : 02-29", joined)
        self.assertIn("inattendue(s) : 13-01", joined)
        self.assertIn("'saint' vide ou absent pour 1 jour(s) : 01-01", joined)
        self.assertIn("'names' doit etre une liste de prenoms non vides pour 2 jour(s) : 01-02, 01-03", joined)

    def test_republican_errors(self):
        self.write_all()
        republican = valid_republican()
        republican["days"] = republican["days"][:359]
        republican["months"][3] = ""
        del republican["decade_days"]
        self.write("republican.json", republican)
        report = self.report()
        joined = "\n".join(report.errors)
        self.assertIn("'days' doit compter 360 elements (359 trouves)", joined)
        self.assertIn("'months' doit ne contenir que des chaines non vides", joined)
        self.assertIn("liste 'decade_days' absente", joined)

    def test_locations_errors(self):
        self.write_all()
        locations = valid_locations()
        locations["schema_version"] = 2
        locations["locations"].append({"slug": "Bad Slug", "label": "x", "lat": 95, "lon": 0, "timezone": "UTC",
                                       "country_code": "XX", "berkeley_region": "r"})
        locations["locations"].append({"slug": "synthetique", "label": "double", "lat": 0, "lon": 0})
        self.write("locations.json", locations)
        report = self.report()
        joined = "\n".join(report.errors)
        self.assertIn("schema_version 1 attendu", joined)
        self.assertIn("slug invalide 'Bad Slug'", joined)
        self.assertIn("'lat' doit etre un nombre entre -90 et 90", joined)
        self.assertIn("slug en double 'synthetique'", joined)
        self.assertIn("cle(s) manquante(s) : timezone, country_code, berkeley_region", joined)
        self.write("locations.json", {"schema_version": 1, "locations": []})
        report = self.report()
        self.assertTrue(any("liste 'locations' non vide attendue" in line for line in report.errors))

    def test_baselines_errors_and_warnings(self):
        self.write_all()
        baselines = valid_baselines()
        baselines["regions"]["france"]["delta_c"] = "1.8"
        baselines["regions"]["france"]["pre_window"] = [1850]
        baselines["regions"]["france"]["n_pre"] = -1
        del baselines["regions"]["france"]["note"]
        baselines["regions"]["europe"] = {"label": "Europe", "delta_c": None, "pre_window": [1850, 1900],
                                          "ref_window": [1991, 2020], "n_pre": 0, "n_ref": 30, "anomaly_base": "1951-1980",
                                          "source_url": "http://example.org", "attribution": "a", "licence": "l",
                                          "analysis_date": None, "fetched_at": "2026-01-01T00:00:00Z",
                                          "fallback_from": None, "note": None}
        self.write("baselines.json", baselines)
        report = self.report()
        joined = "\n".join(report.errors)
        self.assertIn("region 'france' : cle(s) manquante(s) : note", joined)
        self.assertIn("delta_c doit etre un nombre ou null", joined)
        self.assertIn("'pre_window' doit etre [annee_debut, annee_fin]", joined)
        self.assertIn("'n_pre' doit etre un entier positif ou nul", joined)
        self.assertIn("region 'europe' : delta_c null exige une 'note' explicative", joined)
        self.assertTrue(any("source_url ne commence pas par https://" in line for line in report.warnings))

    def test_baselines_missing_region_for_location_is_warning(self):
        self.write_all()
        baselines = valid_baselines()
        baselines["regions"]["germany"] = baselines["regions"].pop("france")
        self.write("baselines.json", baselines)
        report = self.report()
        self.assertEqual(report.errors, [])
        self.assertTrue(any("region 'france' du lieu 'synthetique' absente" in line for line in report.warnings))

    def test_climatology_errors(self):
        self.write_all()
        broken = copy.deepcopy(self.climatology)
        broken["normal_mean"] = broken["normal_mean"][:365]
        broken["daily"]["1995"] = broken["daily"]["1995"][:100]
        broken["daily"]["2000"][3] = 12.5
        broken["annual"] = list(reversed(broken["annual"]))
        broken["records"]["max"][0] = [1.0]
        broken["keys"][59] = "02-30"
        self.write("climatology/synthetique.json", broken)
        report = self.report()
        joined = "\n".join(report.errors)
        self.assertIn("'normal_mean' doit compter 366 valeurs", joined)
        self.assertIn("daily[1995] doit compter 366 valeurs", joined)
        self.assertIn("daily[2000] ne doit contenir que des entiers (dixiemes) ou null", joined)
        self.assertIn("'annual' doit etre trie par annee croissante", joined)
        self.assertIn("records.max doit contenir des paires [valeur, annee]", joined)
        self.assertIn("'keys' doit etre la liste des 366 cles MM-JJ", joined)

    def test_climatology_slug_mismatch_and_missing_keys(self):
        self.write_all()
        self.write("climatology/autre.json", self.climatology)
        report = self.report()
        self.assertEqual(report.errors, [])
        self.assertTrue(any("autre.json : location.slug different du nom de fichier" in line for line in report.warnings))
        self.write("climatology/vide.json", {"schema_version": 1})
        report = self.report()
        self.assertTrue(any("vide.json : cle(s) manquante(s)" in line for line in report.errors))

    def test_empty_climatology_dir_is_info(self):
        self.write_all(with_optional=False)
        report = self.report()
        self.assertEqual(report.errors, [])
        self.assertTrue(any("aucun fichier de climatologie (facultatif)" in line for line in report.infos))


if __name__ == "__main__":
    unittest.main()
