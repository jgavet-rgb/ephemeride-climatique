"""Tests de validate_quotes : schema (jsonschema et validateur integre), regles, couverture, codes de sortie."""

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
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import validate_quotes  # noqa: E402

EXEMPLE_LINE = json.dumps({
    "id": "exemple-2020-01-01-001", "author": "trump", "date": "2020-01-01",
    "text": "Sample text used as a template entry for the quotes database.", "lang": "en",
    "medium": "other", "source_url": "https://example.org/sample", "verified": False, "added": "2026-01-01",
})


def entry(**overrides):
    base = {"id": "trump-2019-03-04-001", "author": "trump", "date": "2019-03-04",
            "text": "Sample text number one for the validator tests, long enough to pass.", "lang": "en",
            "medium": "twitter", "source_url": "https://x.com/realDonaldTrump/status/1", "verified": True,
            "added": "2026-01-01"}
    base.update(overrides)
    return base


def write_lines(folder: Path, name: str, lines) -> Path:
    path = folder / name
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


class EngineSwitch:
    """Force le validateur integre en remplacant le module jsonschema importe par None."""

    def __init__(self, use_builtin: bool):
        self.use_builtin = use_builtin
        self.saved = None

    def __enter__(self):
        self.saved = validate_quotes.jsonschema
        if self.use_builtin:
            validate_quotes.jsonschema = None
        return self

    def __exit__(self, *exc):
        validate_quotes.jsonschema = self.saved
        return False


def run_cli(argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
        code = validate_quotes.main(argv)
    return code, out.getvalue()


class ValidateQuotesTests(unittest.TestCase):
    engines = (False, True)  # jsonschema, then built-in checker

    def setUp(self):
        self.assertIsNotNone(validate_quotes.jsonschema, "le paquet jsonschema est requis pour tester les deux moteurs")
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name)
        self.schema_path = self.folder / "quotes.schema.json"
        self.schema_path.write_text(json.dumps(validate_quotes.BUILTIN_SCHEMA), encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def validate(self, lines, *args, builtin=False):
        path = write_lines(self.folder, "quotes.jsonl", lines)
        with EngineSwitch(builtin):
            return run_cli([str(path), "--schema", str(self.schema_path), *args])

    def test_example_file_passes_with_warnings(self):
        for builtin in self.engines:
            code, out = self.validate(["# Base de citations", "# une entree par ligne", "", EXEMPLE_LINE], builtin=builtin)
            self.assertEqual(code, 0, out)
            self.assertIn("OK", out)
            self.assertIn("AVERTISSEMENT ligne 4 : entree non verifiee", out)
            self.assertIn("couverture des entrees verifiees : 0/366", out)
            self.assertIn("0 erreur(s)", out)
            self.assertIn(("validateur integre" if builtin else "jsonschema"), out)

    def test_invalid_json_line_reports_line_number(self):
        for builtin in self.engines:
            code, out = self.validate([json.dumps(entry()), "{not json", json.dumps(entry(id="trump-2019-03-05-001", date="2019-03-05", text="Sample text number two, different enough from number one."))], builtin=builtin)
            self.assertEqual(code, 1)
            self.assertIn("ERREUR ligne 2 : JSON invalide", out)
            self.assertIn("ECHEC", out)

    def test_schema_violations_same_under_both_engines(self):
        bad = [
            entry(extra="field"),
            entry(id="bad-id"),
            entry(text_fr="Texte traduit sans indication de traduction."),
            entry(tags=["a"] * 9),
            entry(medium="tv"),
            entry(lang="de"),
            entry(text="short"),
            entry(verified="yes"),
            entry(source_url="ftp://example.org"),
            entry(date="2020-13-01"),
            entry(tags=[1]),
            {"id": "trump-2019-03-04-001"},
        ]
        counts = []
        for builtin in self.engines:
            with EngineSwitch(builtin):
                checker = validate_quotes.SchemaChecker(validate_quotes.BUILTIN_SCHEMA)
                counts.append([len(checker.errors(item)) for item in bad])
                self.assertEqual(checker.errors(entry()), [])
                self.assertEqual(checker.errors(entry(text_fr="Traduction.", translation="human", tags=["a"], context="c")), [])
        self.assertTrue(all(count >= 1 for count in counts[0]), counts[0])
        self.assertEqual(counts[0], counts[1])

    def test_duplicate_ids_future_dates_and_urls(self):
        lines = [
            json.dumps(entry(source_url="http://example.org/one")),  # verified + http -> error
            json.dumps(entry(id="trump-2019-03-04-001", date="2999-01-01", added="2999-01-02",
                             text="Sample text number two, different enough from the first one.")),  # duplicate id + future
            json.dumps(entry(id="musk-2019-03-06-001", author="musk", date="2019-03-06", verified=False,
                             source_url="http://example.org/three", text="Sample text number three, tolerated http.")),
        ]
        for builtin in self.engines:
            code, out = self.validate(lines, builtin=builtin)
            self.assertEqual(code, 1)
            self.assertIn("ERREUR ligne 1 : source_url doit commencer par https://", out)
            self.assertIn("ERREUR ligne 2 : identifiant en double 'trump-2019-03-04-001' (deja vu ligne 1)", out)
            self.assertIn("ERREUR ligne 2 : date dans le futur", out)
            self.assertIn("ERREUR ligne 2 : added dans le futur", out)
            self.assertIn("AVERTISSEMENT ligne 3 : source_url en http://", out)
            self.assertNotIn("ERREUR ligne 3", out)

    def test_near_duplicates_per_author(self):
        text = "Sample text repeated almost verbatim for the near duplicate detection of the validator."
        lines = [
            json.dumps(entry(text=text)),
            json.dumps(entry(id="trump-2020-03-04-001", date="2020-03-04", text=text + " https://t.co/x")),
            json.dumps(entry(id="musk-2020-03-04-001", author="musk", date="2020-03-04", text=text,
                             source_url="https://x.com/elonmusk/status/2")),
        ]
        code, out = self.validate(lines)
        self.assertEqual(code, 1)
        self.assertIn("textes quasi identiques (auteur trump", out)
        self.assertIn("lignes 1 et 2", out)
        self.assertNotIn("auteur musk", out)

    def test_id_consistency_warnings(self):
        code, out = self.validate([json.dumps(entry(id="musk-2019-03-05-001"))])
        self.assertEqual(code, 0)
        self.assertIn("prefixe de l'identifiant 'musk' different de l'auteur 'trump'", out)
        self.assertIn("date de l'identifiant differente", out)

    def test_strict_and_full_coverage(self):
        code, out = self.validate([json.dumps(entry())], "--strict")
        self.assertEqual(code, 1)
        self.assertIn("ERREUR : couverture des entrees verifiees : 1/366", out)
        # Full coverage: one verified entry per key of a leap year.
        lines = []
        day = dt.date(2020, 1, 1)
        counter = 0
        while day.year == 2020:
            iso = day.isoformat()
            counter += 1
            words = " ".join(f"word{(counter * 7 + k) % 991}" for k in range(12))
            lines.append(json.dumps(entry(id=f"trump-{iso}-001", date=iso, text=f"Sample text {counter} {words}.")))
            day += dt.timedelta(days=1)
        code, out = self.validate(lines, "--strict")
        self.assertEqual(code, 0, out[-2000:])
        self.assertIn("366/366 jours MM-JJ ; complete", out)
        self.assertIn("366 entree(s), 366 verifiee(s)", out)

    def test_candidates_mode(self):
        line = json.dumps(entry(verified=False, source_type="archive", tags=["candidat"]))
        code, out = self.validate([line], "--candidates")
        self.assertEqual(code, 0)
        self.assertNotIn("entree non verifiee", out)
        self.assertNotIn("couverture", out)
        code, out = self.validate([line])
        self.assertEqual(code, 0)
        self.assertIn("entree non verifiee", out)

    def test_schema_file_is_loaded_at_runtime(self):
        restricted = json.loads(json.dumps(validate_quotes.BUILTIN_SCHEMA))
        restricted["properties"]["author"]["enum"] = ["musk"]
        self.schema_path.write_text(json.dumps(restricted), encoding="utf-8")
        for builtin in self.engines:
            code, out = self.validate([json.dumps(entry())], builtin=builtin)
            self.assertEqual(code, 1)
            self.assertIn("schema : author", out)

    def test_missing_schema_file_falls_back_with_warning(self):
        path = write_lines(self.folder, "quotes.jsonl", [EXEMPLE_LINE])
        code, out = run_cli([str(path), "--schema", str(self.folder / "absent.json")])
        self.assertEqual(code, 0)
        self.assertIn("schema integre", out)

    def test_missing_file_and_bad_schema(self):
        code, out = run_cli([str(self.folder / "absent.jsonl"), "--schema", str(self.schema_path)])
        self.assertEqual(code, 1)
        self.assertIn("introuvable", out)
        self.schema_path.write_text("{broken", encoding="utf-8")
        path = write_lines(self.folder, "quotes.jsonl", [EXEMPLE_LINE])
        code, out = run_cli([str(path), "--schema", str(self.schema_path)])
        self.assertEqual(code, 1)
        self.assertIn("illisible", out)

    def test_builtin_checker_details(self):
        check = validate_quotes.check_schema_builtin
        schema = validate_quotes.BUILTIN_SCHEMA
        self.assertEqual(check(entry(), schema), [])
        self.assertTrue(any("obligatoire" in m for m in check({"id": "x"}, schema)))
        self.assertTrue(any("inattendue" in m for m in check(entry(foo=1), schema)))
        self.assertTrue(any("exige" in m for m in check(entry(text_fr="x"), schema)))
        self.assertTrue(any("motif" in m for m in check(entry(id="nope"), schema)))
        self.assertTrue(any("au plus 8" in m for m in check(entry(tags=list("abcdefghi")), schema)))
        self.assertTrue(any("type boolean" in m for m in check(entry(verified=1), schema)))
        self.assertTrue(any("date AAAA-MM-JJ" in m for m in check(entry(added="01/01/2026"), schema)))
        self.assertEqual(check("x", {"type": ["string", "null"]}), [])
        self.assertEqual(check(None, {"type": ["string", "null"]}), [])
        self.assertEqual(check(3, {"type": "integer", "enum": [3]}), [])
        self.assertTrue(check(True, {"type": "integer"}))


if __name__ == "__main__":
    unittest.main()
