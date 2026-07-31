"""Tests for the eval_data pipeline: sample->case conversion, metadata,
rule-based (no-API-key) evaluation metrics, and evaluate.py's CLI plumbing.

Runs without any API key -- everything here is pure/rule-based or uses
tmpdir fixtures instead of live LLM calls.
"""
import json
import os
import shutil
import tempfile
import unittest

import build_eval_data as bed
import eval_common as ec
import eval_metrics as em
import evaluate as ev
import glossary_manager as gm


class ExtractionTests(unittest.TestCase):
    def test_hashtags(self):
        text = "행사 안내 #총학생회 #KAIST #2025 Booth #9,"
        tags = ec.extract_hashtags(text)
        self.assertIn("#총학생회", tags)
        self.assertIn("#KAIST", tags)
        self.assertNotIn("#2025", tags)  # purely numeric hashtag excluded
        self.assertNotIn("#9,", tags)

    def test_mentions(self):
        text = "문의는 @kaist_kamf 또는 @kaist.ua.official 로 연락주세요."
        mentions = ec.extract_mentions(text)
        self.assertEqual(mentions, ["@kaist_kamf", "@kaist.ua.official"])

    def test_urls(self):
        text = "신청은 https://forms.gle/abc123 에서 (https://kaist.ac.kr) 가능합니다."
        urls = ec.extract_urls(text)
        self.assertIn("https://forms.gle/abc123", urls)
        self.assertIn("https://kaist.ac.kr", urls)

    def test_dates(self):
        text = "2025.09.05, 2025-09-05, 12월 15일, 11/16 에 진행됩니다."
        dates = ec.extract_dates(text)
        self.assertIn("2025.09.05", dates)
        self.assertIn("2025-09-05", dates)
        self.assertIn("12월 15일", dates)
        self.assertIn("11/16", dates)

    def test_times(self):
        text = "20:30 시작, 오후 1시 종료, 24시 마감."
        times = ec.extract_times(text)
        self.assertIn("20:30", times)
        self.assertIn("오후 1시", times)

    def test_numbers(self):
        self.assertEqual(ec.extract_numbers("총 3명, 5회"), ["3", "5"])

    def test_hangul_ratio_and_is_korean(self):
        self.assertTrue(ec.is_korean_text("안녕하세요 총학생회입니다."))
        self.assertFalse(ec.is_korean_text("Hello, this is the student council."))


class SplitAssignmentTests(unittest.TestCase):
    def test_small_set_all_optimization(self):
        splits = ec.assign_splits(["001", "002", "003"])
        self.assertTrue(all(v == "optimization" for v in splits.values()))

    def test_medium_set_holds_out_last_two(self):
        ids = [f"{i:03d}" for i in range(1, 9)]  # 8 cases
        splits = ec.assign_splits(ids)
        self.assertEqual(splits["007"], "holdout")
        self.assertEqual(splits["008"], "holdout")
        self.assertEqual(splits["001"], "optimization")

    def test_large_set_roughly_30_percent_holdout(self):
        ids = [f"{i:03d}" for i in range(1, 21)]  # 20 cases
        splits = ec.assign_splits(ids)
        holdout = [k for k, v in splits.items() if v == "holdout"]
        self.assertEqual(len(holdout), 6)  # round(20 * 0.3)
        # holdout must be the trailing cases, never randomly scattered
        self.assertEqual(holdout, ids[-6:])


class SamplePairResolutionTests(unittest.TestCase):
    """sample -> eval-case pairing, including the swapped/ambiguous cases."""

    def test_resolve_pair_normal_order_not_swapped(self):
        with tempfile.TemporaryDirectory() as d:
            ko_path = os.path.join(d, "korean1.txt")
            en_path = os.path.join(d, "english1.txt")
            with open(ko_path, "w", encoding="utf-8") as f:
                f.write("안녕하세요, 총학생회입니다.")
            with open(en_path, "w", encoding="utf-8") as f:
                f.write("Hello, this is the student council.")

            ko_text, en_text, _, _, swapped = bed.resolve_pair(ko_path, en_path)
            self.assertFalse(swapped)
            self.assertTrue(ec.is_korean_text(ko_text))
            self.assertFalse(ec.is_korean_text(en_text))

    def test_resolve_pair_detects_and_corrects_swap(self):
        with tempfile.TemporaryDirectory() as d:
            ko_path = os.path.join(d, "korean1.txt")
            en_path = os.path.join(d, "english1.txt")
            # Folders swapped: the "korean" file actually holds English text.
            with open(ko_path, "w", encoding="utf-8") as f:
                f.write("Hello, this is the student council.")
            with open(en_path, "w", encoding="utf-8") as f:
                f.write("안녕하세요, 총학생회입니다.")

            ko_text, en_text, ko_src, en_src, swapped = bed.resolve_pair(ko_path, en_path)
            self.assertTrue(swapped)
            self.assertTrue(ec.is_korean_text(ko_text))
            self.assertFalse(ec.is_korean_text(en_text))

    def test_resolve_pair_ambiguous_pair_flagged(self):
        with tempfile.TemporaryDirectory() as d:
            ko_path = os.path.join(d, "korean1.txt")
            en_path = os.path.join(d, "english1.txt")
            with open(ko_path, "w", encoding="utf-8") as f:
                f.write("123 456 789")  # neither Korean nor English letters
            with open(en_path, "w", encoding="utf-8") as f:
                f.write("999 888 777")

            _, _, _, _, swapped = bed.resolve_pair(ko_path, en_path)
            self.assertIsNone(swapped)  # malformed/ambiguous pair -> manual review


class MetadataGenerationTests(unittest.TestCase):
    def test_build_metadata_extracts_structured_fields_and_flags(self):
        ko_text = (
            "[총학생회 공지] 2025년 9월 모집 안내\n"
            "문의: @kaist_ua #총학생회 https://kaist.ac.kr\n"
            "일시: 2025.09.05 20:30"
        )
        en_text = "Notice: recruitment announcement."
        metadata = bed.build_metadata("001", ko_text, en_text, "ko.txt", "en.txt", False, "optimization")

        self.assertEqual(metadata["id"], "001")
        self.assertTrue(metadata["has_hashtags"])
        self.assertTrue(metadata["has_mentions"])
        self.assertTrue(metadata["has_urls"])
        self.assertIn("#총학생회", metadata["hashtags"])
        self.assertIn("@kaist_ua", metadata["mentions"])
        self.assertEqual(metadata["char_count_ko"], len(ko_text))
        self.assertEqual(metadata["line_count_ko"], len(ko_text.splitlines()))
        self.assertEqual(metadata["post_type"], "recruitment")

    def test_build_metadata_low_confidence_flags_manual_review(self):
        ko_text = "그냥 평범한 문장입니다."
        en_text = "Just an ordinary sentence."
        metadata = bed.build_metadata("002", ko_text, en_text, "ko.txt", "en.txt", False, "optimization")
        self.assertEqual(metadata["post_type"], "other")
        self.assertEqual(metadata["topic"], "other")
        self.assertTrue(metadata["manual_review_required"])

    def test_build_metadata_swapped_pair_flags_manual_review(self):
        metadata = bed.build_metadata("003", "안녕", "hello", "en.txt", "ko.txt", True, "optimization")
        self.assertTrue(metadata["manual_review_required"])
        self.assertIn("swapped", metadata["notes"])


class GlossaryComplianceTests(unittest.TestCase):
    def setUp(self):
        self.glossary_rows = [
            {"ko_term": "총학생회", "en_term": "Undergraduate Association", "type": "Organization",
             "aliases": "총학", "usage_note": "", "status": "approved", "source": "user", "last_context": ""},
        ]

    def test_full_compliance(self):
        result = em.glossary_compliance("총학생회 공지", "Undergraduate Association notice", self.glossary_rows)
        self.assertEqual(result["required_terms"], 1)
        self.assertEqual(result["matched_terms"], 1)
        self.assertEqual(result["score"], 1.0)

    def test_missing_term_lowers_score(self):
        result = em.glossary_compliance("총학생회 공지", "Student council notice", self.glossary_rows)
        self.assertEqual(result["missing_required_terms"], ["총학생회"])
        self.assertEqual(result["score"], 0.0)

    def test_no_required_terms_scores_perfect(self):
        result = em.glossary_compliance("평범한 문장", "an ordinary sentence", self.glossary_rows)
        self.assertEqual(result["required_terms"], 0)
        self.assertEqual(result["score"], 1.0)

    def test_deprecated_row_is_not_required(self):
        rows = [{"ko_term": "감사", "en_term": "Auditor", "type": "Role/Position",
                  "aliases": "", "usage_note": "", "status": "deprecated", "source": "imported", "last_context": ""}]
        result = em.glossary_compliance("감사합니다", "Thank you.", rows)
        self.assertEqual(result["required_terms"], 0)


class ReferenceTermOverlapTests(unittest.TestCase):
    def test_ignores_coincidental_word_match_when_ko_term_absent_from_source(self):
        # "program" is glossary en_term for "사업", but "사업" never appears in
        # the source -- its appearance in the reference is unrelated prose.
        rows = [{"ko_term": "사업", "en_term": "program", "type": "General",
                 "aliases": "", "usage_note": "", "status": "approved", "source": "imported", "last_context": ""}]
        result = em.reference_term_overlap(
            "행사에 참여해주세요.", "We prepared a fun program for you.", "Please join the event.", rows,
        )
        self.assertEqual(result["required_terms"], 0)

    def test_counts_term_when_ko_term_present_in_source(self):
        rows = [{"ko_term": "사업", "en_term": "program", "type": "General",
                 "aliases": "", "usage_note": "", "status": "approved", "source": "imported", "last_context": ""}]
        result = em.reference_term_overlap(
            "동일한 사업을 추진하였습니다.", "We pursued the same program.", "We ran the same initiative.", rows,
        )
        self.assertEqual(result["required_terms"], 1)
        self.assertEqual(result["missing_required_terms"], ["program"])


class FormatCheckTests(unittest.TestCase):
    def test_all_preserved(self):
        input_text = "일시: 2025.09.05 20:30, 문의: @kaist_ua #총학생회 https://kaist.ac.kr"
        prediction = "Date: September 5, 2025 8:30 PM, Contact: @kaist_ua #총학생회 https://kaist.ac.kr"
        checks = em.format_checks(input_text, prediction)
        self.assertTrue(all(checks.values()))

    def test_dropped_url_flagged(self):
        input_text = "신청은 https://forms.gle/abc123 에서 가능합니다."
        prediction = "You can apply here."
        checks = em.format_checks(input_text, prediction)
        self.assertFalse(checks["links_preserved"])

    def test_dropped_number_flagged(self):
        input_text = "참가비는 1인당 30000원입니다."
        prediction = "There is a participation fee."
        checks = em.format_checks(input_text, prediction)
        self.assertFalse(checks["numbers_preserved"])

    def test_bare_month_without_day_not_a_false_positive(self):
        input_text = "지난 9월에 진행된 행사입니다."
        prediction = "This event was held last September."
        checks = em.format_checks(input_text, prediction)
        self.assertTrue(checks["dates_preserved"])
        self.assertTrue(checks["numbers_preserved"])

    def test_midnight_hour_only_time_not_a_false_positive(self):
        input_text = "기존 06~24시에서 06~익일 02시로 연장 운영합니다."
        prediction = "Extended from 6 AM-12 AM to 6 AM-2 AM the next day."
        checks = em.format_checks(input_text, prediction)
        self.assertTrue(checks["times_preserved"])

    def test_man_unit_currency_not_a_false_positive(self):
        input_text = "1인당 5만원의 회비가 발생합니다."
        prediction = "There is a fee of 50,000 won per person."
        checks = em.format_checks(input_text, prediction)
        self.assertTrue(checks["numbers_preserved"])

    def test_counter_suffix_word_form_not_a_false_positive(self):
        input_text = "계정당 1회만 이용 가능합니다."
        prediction = "May only be used once per account."
        checks = em.format_checks(input_text, prediction)
        self.assertTrue(checks["numbers_preserved"])


class DiscoverCasesTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write_case(self, cid, split="optimization", missing=None):
        missing = missing or []
        case_dir = os.path.join(self.tmpdir, cid)
        os.makedirs(case_dir, exist_ok=True)
        files = {
            "input.txt": "안녕하세요",
            "reference.txt": "Hello",
            "metadata.json": json.dumps({"split": split}),
        }
        for name, content in files.items():
            if name in missing:
                continue
            with open(os.path.join(case_dir, name), "w", encoding="utf-8") as f:
                f.write(content)

    def test_split_filtering(self):
        self._write_case("001", split="optimization")
        self._write_case("002", split="holdout")
        cases = ev.discover_cases(self.tmpdir, split="holdout")
        self.assertEqual([c[0] for c in cases], ["002"])

    def test_missing_file_is_skipped_not_crashed(self):
        self._write_case("001")
        self._write_case("002", missing=["reference.txt"])
        cases = ev.discover_cases(self.tmpdir)
        self.assertEqual([c[0] for c in cases], ["001"])

    def test_case_id_filtering(self):
        self._write_case("001")
        self._write_case("002")
        cases = ev.discover_cases(self.tmpdir, case_id="002")
        self.assertEqual([c[0] for c in cases], ["002"])


class WriteCaseOutputsTests(unittest.TestCase):
    def test_writes_all_expected_files(self):
        with tempfile.TemporaryDirectory() as d:
            out_dir = os.path.join(d, "001")
            run_result = {
                "prediction": "Hello.",
                "audit_report": {"has_violation": False, "violations": []},
                "missing_terms": [],
            }
            eval_report = {"case_id": "001", "glossary_compliance": {"score": 1.0}}
            ev.write_case_outputs(out_dir, run_result, eval_report, save_predictions=True)

            self.assertTrue(os.path.exists(os.path.join(out_dir, "prediction.txt")))
            self.assertTrue(os.path.exists(os.path.join(out_dir, "audit_report.json")))
            self.assertTrue(os.path.exists(os.path.join(out_dir, "missing_terms.json")))
            self.assertTrue(os.path.exists(os.path.join(out_dir, "eval_report.json")))

            with open(os.path.join(out_dir, "eval_report.json")) as f:
                self.assertEqual(json.load(f)["case_id"], "001")

    def test_no_save_predictions_skips_prediction_file(self):
        with tempfile.TemporaryDirectory() as d:
            out_dir = os.path.join(d, "001")
            run_result = {"prediction": "Hello.", "audit_report": {}, "missing_terms": []}
            ev.write_case_outputs(out_dir, run_result, {"case_id": "001"}, save_predictions=False)
            self.assertFalse(os.path.exists(os.path.join(out_dir, "prediction.txt")))


class SummaryReportTests(unittest.TestCase):
    def _report(self, cid, split="optimization", missing_required=None, high_priority_missing=None,
                failure_categories=None, warnings=None):
        return {
            "case_id": cid,
            "split": split,
            "glossary_compliance": {
                "required_terms": 1, "matched_terms": 0 if missing_required else 1,
                "missing_required_terms": missing_required or [], "score": 0.0 if missing_required else 1.0,
            },
            "missing_term_detection": {
                "num_candidate_terms": 0, "num_missing_terms": len(high_priority_missing or []),
                "high_priority_missing_terms": high_priority_missing or [],
            },
            "failure_categories": failure_categories or [],
            "manual_review_required": False,
            "warnings": warnings or [],
        }

    def test_build_summary_aggregates_glossary_and_candidate_missing_terms(self):
        reports = [
            self._report("001", missing_required=["총학생회"]),
            self._report("002", high_priority_missing=["총학생회"]),
            self._report("003"),
        ]
        summary = ev.build_summary(reports)
        self.assertEqual(summary["num_cases"], 3)
        self.assertIn("총학생회", summary["common_missing_terms"])
        self.assertAlmostEqual(summary["average_glossary_compliance"], 2 / 3, places=4)

    def test_build_summary_empty_input(self):
        summary = ev.build_summary([])
        self.assertEqual(summary["num_cases"], 0)
        self.assertEqual(summary["common_missing_terms"], [])

    def test_write_summary_md_lists_manual_review_and_format_loss_cases(self):
        reports = [
            self._report("001", failure_categories=["format_loss"]),
            self._report("002"),
        ]
        summary = ev.build_summary(reports)
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "summary.md")
            ev.write_summary_md(summary, reports, path)
            with open(path, encoding="utf-8") as f:
                content = f.read()
            self.assertIn("Cases with format loss", content)
            self.assertIn("001", content)


class TermExtractionFailureClassificationTests(unittest.TestCase):
    def test_false_positive_flagged_for_hallucinated_term(self):
        input_text = "총학생회 공지입니다."
        candidate_terms = [{"ko_term": "존재하지않는용어", "priority": "low"}]
        fps = em._term_extraction_false_positives(input_text, candidate_terms)
        self.assertEqual(fps, ["존재하지않는용어"])

    def test_no_false_positive_when_term_present_in_text(self):
        input_text = "총학생회 공지입니다."
        candidate_terms = [{"ko_term": "총학생회", "priority": "high"}]
        fps = em._term_extraction_false_positives(input_text, candidate_terms)
        self.assertEqual(fps, [])


if __name__ == "__main__":
    unittest.main()
