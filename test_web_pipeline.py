import json
import unittest
from unittest.mock import MagicMock, patch

import db_users
import web_pipeline

GLOSSARY = [
    {
        "ko_term": "중앙운영위원회", "en_term": "Central Steering Committee",
        "type": "Organization", "aliases": "중운위",
        "usage_note": "", "status": "approved", "source": "user", "last_context": "",
    },
]


def stub_generate_fns(term_extraction_response="[]", translation_response="", repair_response=None):
    return {
        "term_extraction": lambda prompt: term_extraction_response,
        "translation": lambda prompt: translation_response,
        "repair": lambda prompt: repair_response if repair_response is not None else translation_response,
    }


class AnalyzeTextTests(unittest.TestCase):
    @patch("web_pipeline.db_glossary.fetch_glossary_rows")
    @patch("web_pipeline.build_generate_fns")
    def test_detects_missing_high_priority_term(self, mock_generate_fns, mock_fetch):
        mock_fetch.return_value = GLOSSARY
        term_extraction_json = json.dumps([
            {"ko_term": "신조어", "type": "General", "context_sentence": "신조어가 등장했다.",
             "suggested_translation": "New Term", "priority": "high"}
        ], ensure_ascii=False)
        mock_generate_fns.return_value = stub_generate_fns(term_extraction_response=term_extraction_json)

        result = web_pipeline.analyze_text("중앙운영위원회와 신조어가 등장했다.")

        self.assertEqual(len(result["matched_terms"]), 1)
        self.assertEqual(result["matched_terms"][0]["ko_term"], "중앙운영위원회")
        self.assertEqual([t["ko_term"] for t in result["missing_terms"]], ["신조어"])

    @patch("web_pipeline.db_users.get_quota")
    @patch("web_pipeline.db_glossary.fetch_glossary_rows")
    @patch("web_pipeline.build_generate_fns")
    def test_blocks_when_quota_exhausted(self, mock_generate_fns, mock_fetch, mock_get_quota):
        mock_fetch.return_value = GLOSSARY
        mock_get_quota.return_value = {"limit": 1000, "used": 1000, "bonus": 0, "remaining": 0}
        generate_fns = stub_generate_fns()
        mock_generate_fns.return_value = generate_fns

        with self.assertRaises(web_pipeline.QuotaExceededError) as ctx:
            web_pipeline.analyze_text("중앙운영위원회", user_id=1)

        self.assertEqual(ctx.exception.quota["remaining"], 0)
        mock_generate_fns.assert_not_called()

    @patch("web_pipeline.db_users.get_quota")
    @patch("web_pipeline.db_glossary.fetch_glossary_rows")
    @patch("web_pipeline.build_generate_fns")
    def test_no_user_id_skips_quota_check(self, mock_generate_fns, mock_fetch, mock_get_quota):
        mock_fetch.return_value = GLOSSARY
        mock_generate_fns.return_value = stub_generate_fns()

        web_pipeline.analyze_text("중앙운영위원회")  # no user_id -- should not touch quota at all

        mock_get_quota.assert_not_called()


class TranslateTextTests(unittest.TestCase):
    @patch("web_pipeline.db_translations.insert_translation")
    @patch("web_pipeline.db_glossary.fetch_glossary_rows")
    @patch("web_pipeline.build_generate_fns")
    @patch("web_pipeline.db_users.get_quota")
    def test_protects_and_restores_glossary_term(self, mock_get_quota, mock_generate_fns, mock_fetch, mock_insert):
        mock_get_quota.return_value = {"limit": 1000, "used": 0, "bonus": 0, "remaining": 1000}
        mock_fetch.return_value = GLOSSARY
        mock_generate_fns.return_value = stub_generate_fns(
            translation_response="The __TERM_001__ met today."
        )

        result = web_pipeline.translate_text("중앙운영위원회는 오늘 회의를 열었다.", user_id=7)

        self.assertIn("Central Steering Committee", result["translation"])
        self.assertNotIn("__TERM_001__", result["translation"])
        self.assertFalse(result["audit_report"]["has_violation"])
        mock_insert.assert_called_once()
        self.assertEqual(mock_insert.call_args.kwargs["user_id"], 7)
        self.assertEqual(
            mock_insert.call_args.kwargs["matched_terms"],
            [{"ko_term": "중앙운영위원회", "en_term": "Central Steering Committee"}],
        )

    @patch("web_pipeline.db_translations.insert_translation")
    @patch("web_pipeline.db_glossary.fetch_glossary_rows")
    @patch("web_pipeline.build_generate_fns")
    def test_repairs_dropped_glossary_term(self, mock_generate_fns, mock_fetch, mock_insert):
        mock_fetch.return_value = GLOSSARY
        mock_generate_fns.return_value = stub_generate_fns(
            translation_response="The committee met today.",  # placeholder dropped -> violation
            repair_response="The Central Steering Committee met today.",
        )

        result = web_pipeline.translate_text("중앙운영위원회는 오늘 회의를 열었다.")

        self.assertIn("Central Steering Committee", result["translation"])
        self.assertFalse(result["audit_report"]["has_violation"])
        mock_insert.assert_called_once()

    @patch("web_pipeline.db_users.get_quota")
    @patch("web_pipeline.db_glossary.fetch_glossary_rows")
    @patch("web_pipeline.build_generate_fns")
    def test_blocks_when_quota_exhausted(self, mock_generate_fns, mock_fetch, mock_get_quota):
        mock_fetch.return_value = GLOSSARY
        mock_get_quota.return_value = {"limit": 1000, "used": 1000, "bonus": 0, "remaining": 0}

        with self.assertRaises(web_pipeline.QuotaExceededError):
            web_pipeline.translate_text("중앙운영위원회는 오늘 회의를 열었다.", user_id=1)

        mock_generate_fns.assert_not_called()

    @patch("web_pipeline.db_users.record_usage")
    @patch("web_pipeline.db_users.get_quota")
    @patch("web_pipeline.db_translations.insert_translation")
    @patch("web_pipeline.db_glossary.fetch_glossary_rows")
    @patch("web_pipeline.build_generate_fns")
    def test_records_usage_after_successful_translation(
        self, mock_generate_fns, mock_fetch, mock_insert, mock_get_quota, mock_record_usage
    ):
        mock_fetch.return_value = GLOSSARY
        mock_get_quota.return_value = {"limit": 1000, "used": 0, "bonus": 0, "remaining": 1000}

        def fake_build_generate_fns(usage_tracker=None):
            if usage_tracker is not None:
                usage_tracker["input_tokens"] = 42
                usage_tracker["output_tokens"] = 8
            return stub_generate_fns(translation_response="The __TERM_001__ met today.")

        mock_generate_fns.side_effect = fake_build_generate_fns

        web_pipeline.translate_text("중앙운영위원회는 오늘 회의를 열었다.", user_id=1)

        mock_record_usage.assert_called_once_with(1, 42, 8)


if __name__ == "__main__":
    unittest.main()
