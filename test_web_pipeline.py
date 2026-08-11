import json
import unittest
from unittest.mock import patch

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


class TranslateTextTests(unittest.TestCase):
    @patch("web_pipeline.db_translations.insert_translation")
    @patch("web_pipeline.db_glossary.fetch_glossary_rows")
    @patch("web_pipeline.build_generate_fns")
    def test_protects_and_restores_glossary_term(self, mock_generate_fns, mock_fetch, mock_insert):
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


if __name__ == "__main__":
    unittest.main()
