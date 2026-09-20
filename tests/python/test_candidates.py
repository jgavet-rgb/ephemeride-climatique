"""Tests de la selection de citations candidates (candidates_core et quotes_candidates)."""

import contextlib
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

import candidates_core as core  # noqa: E402
import common  # noqa: E402
import quotes_candidates  # noqa: E402
import validate_quotes  # noqa: E402

SOURCES = FIXTURES / "candidates"
LONG_TEXT = "Sample text about topic 500 that is long enough to pass the minimum length filter of the pipeline."


def row(**overrides):
    base = {"author": "trump", "id": "1", "text": LONG_TEXT, "date": "2019-03-04", "favorites": 10,
            "retweets": 1, "is_retweet": False, "has_engagement": True}
    base.update(overrides)
    return base


class ColumnDetectionTests(unittest.TestCase):
    def test_csv_export_columns(self):
        columns = core.detect_columns(["id", "text", "isRetweet", "isDeleted", "device", "favorites",
                                       "retweets", "date", "isFlagged"])
        self.assertEqual(columns, {"id": "id", "text": "text", "date": "date", "favorites": "favorites",
                                   "retweets": "retweets", "is_retweet": "isRetweet"})

    def test_api_style_columns(self):
        columns = core.detect_columns(["created_at", "id_str", "full_text", "text", "retweet_count",
                                       "favorite_count", "retweeted", "lang"])
        self.assertEqual(columns["id"], "id_str")
        self.assertEqual(columns["text"], "full_text")  # the untruncated text is preferred
        self.assertEqual(columns["date"], "created_at")
        self.assertEqual(columns["favorites"], "favorite_count")
        self.assertEqual(columns["retweets"], "retweet_count")
        self.assertEqual(columns["is_retweet"], "retweeted")

    def test_case_insensitive_and_missing(self):
        columns = core.detect_columns(["Tweet_ID", "Content", "Timestamp", "LikeCount", "RetweetCount"])
        self.assertEqual(columns["id"], "Tweet_ID")
        self.assertEqual(columns["text"], "Content")
        self.assertEqual(columns["date"], "Timestamp")
        self.assertEqual(columns["favorites"], "LikeCount")
        self.assertEqual(columns["retweets"], "RetweetCount")
        self.assertIsNone(columns["is_retweet"])
        self.assertEqual(core.detect_columns(["foo", "bar"]), {role: None for role in core.COLUMN_ALIASES})

    def test_flatten_record(self):
        flat = core.flatten_record({"id": "1", "public_metrics": {"like_count": 5, "retweet_count": 2}})
        self.assertEqual(flat["like_count"], 5)
        self.assertEqual(flat["public_metrics.retweet_count"], 2)
        columns = core.detect_columns(flat.keys())
        self.assertEqual(columns["favorites"], "like_count")


class FieldParsingTests(unittest.TestCase):
    def test_parse_date_formats(self):
        self.assertEqual(core.parse_date("2019-12-06T20:31:11.000Z"), "2019-12-06")
        self.assertEqual(core.parse_date("2019-12-06T20:31:11+00:00"), "2019-12-06")
        self.assertEqual(core.parse_date("2019-12-06 20:31:11"), "2019-12-06")
        self.assertEqual(core.parse_date("2019-12-06"), "2019-12-06")
        self.assertEqual(core.parse_date("Fri Dec 06 20:31:11 +0000 2019"), "2019-12-06")
        self.assertEqual(core.parse_date("12/06/2019 20:31"), "2019-12-06")
        self.assertEqual(core.parse_date(1575664271), "2019-12-06")
        self.assertEqual(core.parse_date("1575664271000"), "2019-12-06")
        self.assertIsNone(core.parse_date(""))
        self.assertIsNone(core.parse_date(None))
        self.assertIsNone(core.parse_date("not a date"))
        self.assertIsNone(core.parse_date("2019-13-45"))

    def test_parse_count_flag_id(self):
        self.assertEqual(core.parse_count("1,234"), 1234)
        self.assertEqual(core.parse_count(12.0), 12)
        self.assertIsNone(core.parse_count(""))
        self.assertIsNone(core.parse_count("abc"))
        self.assertTrue(core.parse_flag("t"))
        self.assertTrue(core.parse_flag(True))
        self.assertFalse(core.parse_flag("f"))
        self.assertFalse(core.parse_flag(None))
        self.assertEqual(core.parse_status_id("1202722213412782082"), "1202722213412782082")
        self.assertEqual(core.parse_status_id("1202722213412782082.0"), "1202722213412782082")
        self.assertEqual(core.parse_status_id(12345), "12345")
        self.assertIsNone(core.parse_status_id(""))
        self.assertIsNone(core.parse_status_id("abc"))

    def test_extract_row(self):
        columns = core.detect_columns(["id", "text", "isRetweet", "favorites", "retweets", "date"])
        record = {"id": "42", "text": "  RT @someone: sample  ", "isRetweet": "f", "favorites": "3",
                  "retweets": "1", "date": "2020-02-29 10:00:00"}
        extracted = core.extract_row(record, columns, "trump")
        self.assertEqual(extracted["id"], "42")
        self.assertEqual(extracted["text"], "RT @someone: sample")
        self.assertTrue(extracted["is_retweet"])
        self.assertEqual(extracted["date"], "2020-02-29")
        self.assertEqual((extracted["favorites"], extracted["retweets"]), (3, 1))
        self.assertTrue(extracted["has_engagement"])
        no_engagement = core.extract_row({"text": LONG_TEXT, "date": "2020-01-01"},
                                         core.detect_columns(["text", "date"]), "musk")
        self.assertFalse(no_engagement["has_engagement"])
        self.assertIsNone(no_engagement["id"])


class FilterTests(unittest.TestCase):
    def test_filter_reasons(self):
        self.assertIsNone(core.filter_reason(row()))
        self.assertEqual(core.filter_reason(row(is_retweet=True)), "retweet")
        self.assertEqual(core.filter_reason(row(date=None)), "sans_date")
        self.assertEqual(core.filter_reason(row(text="Too short sample text")), "trop_court")
        self.assertEqual(core.filter_reason(row(text="https://example.com/a https://example.com/b")), "sans_contenu")
        self.assertEqual(core.filter_reason(row(text="@sample #tag @other #again ...")), "sans_contenu")
        self.assertEqual(core.filter_reason(row(text="Sample words then a link https://example.com/very/long/url/that/should/not/count/for/length")), "trop_court")
        self.assertEqual(core.filter_reason(row(text="Sample " * 200)), "trop_long")
        self.assertIsNone(core.filter_reason(row(text="Sample text of exactly twenty"), min_length=20))

    def test_strip_urls_and_substantive(self):
        self.assertEqual(core.strip_urls("Sample  text https://t.co/abc  end"), "Sample text end")
        self.assertTrue(core.is_substantive("Sample text"))
        self.assertFalse(core.is_substantive("www.example.com"))


class NormalizationAndDedupTests(unittest.TestCase):
    def test_normalize_text(self):
        text = "Sample TEXT, with @mention &amp; a link https://t.co/xyz #Tag!"
        self.assertEqual(core.normalize_text(text), "sample text with a link tag")

    def test_shingles_and_jaccard(self):
        self.assertEqual(core.shingles("a b c d"), frozenset({("a", "b", "c"), ("b", "c", "d")}))
        self.assertEqual(core.shingles("a b"), frozenset({("a", "b")}))
        self.assertEqual(core.shingles(""), frozenset())
        left = core.shingles("a b c d")
        right = core.shingles("a b c d e")
        self.assertAlmostEqual(core.jaccard(left, right), 2 / 3)
        self.assertEqual(core.jaccard(frozenset(), frozenset()), 1.0)
        self.assertEqual(core.jaccard(left, left), 1.0)

    def test_dedup_keeps_first_and_drops_variants(self):
        texts = [
            "Sample text about topic one, written for the dedup test of the pipeline.",
            "Sample text about topic one, written for the dedup test of the pipeline. https://t.co/abc",
            "Sample text about topic two, a completely different fabricated sentence for the test.",
            "SAMPLE TEXT ABOUT TOPIC ONE, WRITTEN FOR THE DEDUP TEST OF THE PIPELINE!!!",
        ]
        self.assertEqual(core.dedup_indices(texts), [0, 2])

    def test_dedup_against_existing(self):
        texts = ["Sample text about topic three, already present in the quotes database of the test.",
                 "Sample text about topic four, a new fabricated sentence not present anywhere else."]
        existing = ["Sample text about topic three, already present in the quotes database of the test."]
        self.assertEqual(core.dedup_indices(texts, existing), [1])

    def test_dedup_compares_only_with_kept_texts(self):
        base = "one two three four five six seven eight nine ten"
        # B is a near duplicate of A (dropped); C is near B but not near A: C is kept.
        texts = [base, base + " eleven", base + " eleven twelve thirteen fourteen fifteen sixteen seventeen"]
        kept = core.dedup_indices(texts, threshold=0.8)
        self.assertEqual(kept[0], 0)
        self.assertNotIn(1, kept)
        self.assertIn(2, kept)

    def test_find_near_duplicates_pairs(self):
        texts = ["Sample text alpha beta gamma delta epsilon zeta eta theta",
                 "Sample text totally different words here for the second entry of the list",
                 "Sample text alpha beta gamma delta epsilon zeta eta theta!"]
        pairs = core.find_near_duplicates(texts, 0.9)
        self.assertEqual([(i, j) for i, j, _ in pairs], [(0, 2)])
        self.assertEqual(pairs[0][2], 1.0)
        self.assertEqual(core.find_near_duplicates([], 0.9), [])

    def test_prefix_filter_matches_brute_force(self):
        words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu".split()
        texts = []
        for start in range(12):
            for length in (6, 7, 8):
                texts.append(" ".join(words[(start + k) % 12] for k in range(length)))
        for threshold in (0.5, 0.8, 0.9):
            sets = [core.shingles(core.normalize_text(t)) for t in texts]
            brute = {(i, j) for i in range(len(sets)) for j in range(i + 1, len(sets))
                     if core.jaccard(sets[i], sets[j]) >= threshold}
            indexed = {(i, j) for i, j, _ in core.find_near_duplicates(texts, threshold)}
            self.assertEqual(indexed, brute, threshold)


class ScoringAndSelectionTests(unittest.TestCase):
    def test_percentile_90(self):
        self.assertEqual(core.percentile_90([]), 0.0)
        self.assertEqual(core.percentile_90([5]), 5.0)
        self.assertEqual(core.percentile_90(list(range(1, 11))), 9.0)
        self.assertEqual(core.percentile_90([100, 1, 50]), 100.0)

    def test_scores_are_normalized_per_author_and_year(self):
        rows = [row(id="a", date="2012-01-01", favorites=50, retweets=10),
                row(id="b", date="2012-01-02", favorites=5, retweets=1),
                row(id="c", date="2020-01-01", favorites=50000, retweets=10000),
                row(id="d", date="2020-01-02", favorites=5000, retweets=1000),
                row(id="e", author="musk", date="2020-01-01", has_engagement=False, favorites=None, retweets=None)]
        core.score_rows(rows)
        by_id = {r["id"]: r for r in rows}
        self.assertEqual(by_id["a"]["metric"], 70.0)
        self.assertEqual(by_id["a"]["score"], 1.0)
        self.assertEqual(by_id["c"]["score"], 1.0)
        self.assertAlmostEqual(by_id["b"]["score"], 0.1)
        self.assertAlmostEqual(by_id["d"]["score"], 0.1)
        self.assertIsNone(by_id["e"]["metric"])
        self.assertEqual(by_id["e"]["score"], float(len(LONG_TEXT)))  # length fallback

    def test_select_per_day(self):
        rows = [row(id="1", date="2019-03-04"), row(id="2", date="2020-03-04"), row(id="3", date="2021-03-04"),
                row(id="4", date="2019-07-14"), row(id="5", author="musk", date="2019-03-04")]
        scores = {"1": 0.2, "2": 0.9, "3": 0.5, "4": 0.1, "5": 0.3}
        for r in rows:
            r["score"] = scores[r["id"]]
        selected = core.select_per_day(rows, 2)
        self.assertEqual([r["id"] for r in selected], ["5", "2", "3", "4"])

    def test_coverage(self):
        report = core.coverage([{"author": "trump", "date": "2019-03-04"}, {"author": "trump", "date": "2020-03-04"},
                                {"author": "trump", "date": "2020-02-29"}])
        self.assertEqual(report["trump"]["covered"], 2)
        self.assertEqual(len(report["trump"]["missing"]), 364)
        self.assertNotIn("02-29", report["trump"]["missing"])


class EntryTests(unittest.TestCase):
    def test_make_entry(self):
        entry = core.make_entry(row(id="123", date="2019-03-04"), 2, "2026-09-17")
        self.assertEqual(entry["id"], "trump-2019-03-04-002")
        self.assertEqual(entry["medium"], "twitter")
        self.assertEqual(entry["source_url"], "https://x.com/realDonaldTrump/status/123")
        self.assertEqual(entry["tags"], ["candidat"])
        self.assertFalse(entry["verified"])
        self.assertEqual(entry["added"], "2026-09-17")
        self.assertEqual(entry["source_type"], "archive")
        self.assertEqual(entry["lang"], "en")
        self.assertNotIn("context", entry)
        self.assertNotIn("text_fr", entry)
        self.assertEqual(set(entry) - set(validate_quotes.BUILTIN_SCHEMA["properties"]), set())

    def test_medium_switch_and_missing_id(self):
        self.assertEqual(core.make_entry(row(date="2023-07-23"), 1, "2026-01-01")["medium"], "twitter")
        self.assertEqual(core.make_entry(row(date="2023-07-24"), 1, "2026-01-01")["medium"], "x")
        entry = core.make_entry(row(author="musk", id=None, date="2024-01-01"), 1, "2026-01-01")
        self.assertEqual(entry["source_url"], "https://x.com/elonmusk")
        self.assertEqual(entry["tags"], ["candidat", "sans-identifiant"])
        self.assertEqual(entry["id"], "musk-2024-01-01-001")

    def test_number_entries(self):
        rows = [row(id="1", date="2019-03-04", score=0.5), row(id="2", date="2019-03-04", score=0.9),
                row(id="3", author="musk", date="2019-03-04", score=0.1)]
        entries = core.number_entries(rows, "2026-01-01", existing_ids=["trump-2019-03-04-001", "trump-2019-03-04-002"])
        self.assertEqual([e["id"] for e in entries], ["musk-2019-03-04-001", "trump-2019-03-04-003", "trump-2019-03-04-004"])
        self.assertEqual(entries[1]["source_url"], "https://x.com/realDonaldTrump/status/2")  # best score first


class CliTests(unittest.TestCase):
    def run_cli(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = quotes_candidates.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_end_to_end_on_fixtures(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            existing = folder / "quotes.jsonl"
            existing.write_text(
                "# test database\n"
                + json.dumps({"id": "trump-2021-05-05-001", "author": "trump", "date": "2021-05-05",
                              "text": "Sample text about topic 013 that duplicates an existing verified entry of the test database for the dedup check.",
                              "lang": "en", "medium": "twitter", "source_url": "https://x.com/realDonaldTrump/status/1013",
                              "verified": True, "added": "2026-01-01"}) + "\n"
                + json.dumps({"id": "trump-2019-03-04-001", "author": "trump", "date": "2019-03-04",
                              "text": "Sample text about topic 900 already present for that date, so numbering must start at 002.",
                              "lang": "en", "medium": "twitter", "source_url": "https://x.com/realDonaldTrump/status/900",
                              "verified": True, "added": "2026-01-01"}) + "\n",
                encoding="utf-8")
            out_path = folder / "candidates.jsonl"
            code, out, err = self.run_cli(["--sources", str(SOURCES), "--existing", str(existing),
                                           "--out", str(out_path), "--per-day", "5"])
            self.assertEqual(code, 0, err)
            entries = common.read_jsonl(out_path)
            by_id = {entry["id"]: entry for entry in entries}
            texts = [entry["text"] for entry in entries]

            # Filters: retweets, short texts, link-only or mention-only texts, rows without a date.
            self.assertFalse(any(text.startswith("RT @") for text in texts))
            self.assertFalse(any("topic 003" in text or "topic 104" in text for text in texts))
            self.assertFalse(any("Too short" in text or "Short sample" in text for text in texts))
            self.assertFalse(any("topic 015" in text or "topic 112" in text for text in texts))
            # Dedup: URL variant, exact repeat on another date, repost, entry already in the database.
            def starting_with(topic):
                return sum(1 for text in texts if text.startswith(f"Sample text about topic {topic}"))
            self.assertEqual(starting_with("001"), 1)
            self.assertEqual(starting_with("009"), 1)
            self.assertEqual(starting_with("101"), 1)
            self.assertEqual(starting_with("013"), 0)
            # Numbering continues after the identifiers already used in the database.
            self.assertIn("trump-2019-03-04-002", by_id)
            self.assertNotIn("trump-2019-03-04-001", by_id)
            self.assertEqual(by_id["trump-2019-03-04-002"]["source_url"], "https://x.com/realDonaldTrump/status/1001")
            # Medium, handles, tags, dates.
            self.assertEqual(by_id["trump-2023-09-10-001"]["medium"], "x")
            self.assertEqual(by_id["musk-2023-08-14-001"]["medium"], "x")
            self.assertEqual(by_id["musk-2019-12-06-001"]["medium"], "twitter")
            self.assertEqual(by_id["musk-2019-12-06-001"]["source_url"], "https://x.com/elonmusk/status/2001")
            self.assertEqual(by_id["musk-2024-03-15-001"]["source_url"], "https://x.com/elonmusk/status/2010")
            self.assertEqual(by_id["trump-2019-11-11-001"]["tags"], ["candidat", "sans-identifiant"])
            self.assertIn("trump-2020-02-29-001", by_id)
            self.assertIn("musk-2020-02-29-001", by_id)
            for entry in entries:
                self.assertFalse(entry["verified"])
                self.assertEqual(entry["added"], common.iso_today_utc())
                self.assertNotIn("context", entry)
                self.assertNotIn("text_fr", entry)
                self.assertEqual(entry["text"], entry["text"].strip())
            # Every entry is schema-conformant (validator in candidates mode).
            report = validate_quotes.validate_file(out_path, validate_quotes.BUILTIN_SCHEMA, candidates=True)
            self.assertEqual(report.errors, [])
            # Coverage report in French on stdout.
            self.assertIn("trump : ", out)
            self.assertIn("/366 jours MM-JJ couverts", out)
            self.assertIn("manquants (", out)
            self.assertIn("...", out)
            self.assertIn("quasi-doublons", out)
            self.assertIn("candidats ecrits", out)

    def test_per_day_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            out_path = folder / "candidates.jsonl"
            code, _, _ = self.run_cli(["--sources", str(SOURCES), "--existing", str(folder / "none.jsonl"),
                                       "--out", str(out_path), "--per-day", "1"])
            self.assertEqual(code, 0)
            entries = common.read_jsonl(out_path)
            per_key = {}
            for entry in entries:
                per_key[(entry["author"], entry["date"][5:])] = per_key.get((entry["author"], entry["date"][5:]), 0) + 1
            self.assertTrue(all(count == 1 for count in per_key.values()))
            self.assertEqual(sum(1 for e in entries if e["author"] == "trump" and e["date"][5:] == "03-04"), 1)

    def test_report_only_and_missing_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            out_path = folder / "candidates.jsonl"
            code, out, _ = self.run_cli(["--sources", str(SOURCES), "--existing", str(folder / "none.jsonl"),
                                         "--out", str(out_path), "--report-only"])
            self.assertEqual(code, 0)
            self.assertFalse(out_path.exists())
            self.assertIn("rapport seul", out)
            code, _, err = self.run_cli(["--sources", str(folder / "nowhere"), "--out", str(out_path)])
            self.assertEqual(code, 1)
            self.assertIn("introuvable", err)

    def test_iter_records_formats(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            jsonl = folder / "a.jsonl"
            jsonl.write_text('{"id": "1", "text": "x"}\n\n# comment\n{"id": "2", "text": "y"}\n', encoding="utf-8")
            self.assertEqual([r["id"] for r in quotes_candidates.iter_records(jsonl)], ["1", "2"])
            wrapped = folder / "b.json"
            wrapped.write_text(json.dumps({"meta": 1, "data": [{"id": "3"}]}), encoding="utf-8")
            self.assertEqual([r["id"] for r in quotes_candidates.iter_records(wrapped)], ["3"])
            csv_path = folder / "c.csv"
            csv_path.write_text("id,text\n4,\"quoted, text\"\n", encoding="utf-8")
            self.assertEqual(list(quotes_candidates.iter_records(csv_path)), [{"id": "4", "text": "quoted, text"}])


if __name__ == "__main__":
    unittest.main()
