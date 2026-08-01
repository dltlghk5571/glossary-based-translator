import os
import shutil
import tempfile
import unittest

import glossary_manager as gm
import translation_graph as tg
import audit as audit_mod


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.path = os.path.join(self.tmpdir, "glossary.csv")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_migrate_legacy_korean_english_schema(self):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("Korean,English\n총학생회,Undergraduate Student Council\n의결기구,Legislative Board\n")

        migrated = gm.migrate_glossary(self.path)
        self.assertTrue(migrated)
        self.assertTrue(os.path.exists(self.path + ".bak"))

        rows = gm.load_glossary(self.path)
        self.assertEqual(len(rows), 2)
        self.assertEqual(set(rows[0].keys()), set(gm.REQUIRED_COLUMNS))

        row = gm.find_glossary_entry(rows, "총학생회")
        self.assertEqual(row["en_term"], "Undergraduate Student Council")
        self.assertEqual(row["status"], "approved")
        self.assertEqual(row["source"], "imported")

    def test_migrate_is_noop_on_new_schema(self):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write(
                "ko_term,en_term,type,aliases,usage_note,status,source,last_context\n"
                "총학생회,Undergraduate Student Council,General,,note,approved,imported,\n"
            )
        migrated = gm.migrate_glossary(self.path)
        self.assertFalse(migrated)
        self.assertFalse(os.path.exists(self.path + ".bak"))


class MatchingTests(unittest.TestCase):
    def setUp(self):
        self.glossary = [
            {
                "ko_term": "중앙운영위원회", "en_term": "Central Steering Committee",
                "type": "Organization", "aliases": "중운위",
                "usage_note": "", "status": "approved", "source": "user", "last_context": "",
            },
            {
                "ko_term": "전체학생대표자회의", "en_term": "General Student Representative Assembly",
                "type": "Organization", "aliases": "",
                "usage_note": "", "status": "approved", "source": "user", "last_context": "",
            },
            {
                "ko_term": "학생대표자회의", "en_term": "Student Representative Assembly",
                "type": "Organization", "aliases": "",
                "usage_note": "", "status": "approved", "source": "user", "last_context": "",
            },
        ]

    def test_ko_term_exact_match(self):
        matches = gm.match_terms("중앙운영위원회는 회의를 소집하였다.", self.glossary)
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["ko_term"], "중앙운영위원회")
        self.assertEqual(matches[0]["en_term"], "Central Steering Committee")
        self.assertEqual(matches[0]["matched_via"], "ko_term")

    def test_alias_match(self):
        matches = gm.match_terms("중운위 결정에 따라 진행한다.", self.glossary)
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["ko_term"], "중앙운영위원회")
        self.assertEqual(matches[0]["en_term"], "Central Steering Committee")
        self.assertEqual(matches[0]["matched_via"], "alias")

    def test_longest_match_wins(self):
        matches = gm.match_terms("전체학생대표자회의가 개최되었다.", self.glossary)
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["ko_term"], "전체학생대표자회의")

    def test_conflict_detection(self):
        glossary = list(self.glossary) + [{
            "ko_term": "중운위단체", "en_term": "Something Else",
            "type": "Organization", "aliases": "중운위",
            "usage_note": "", "status": "approved", "source": "user", "last_context": "",
        }]
        conflicts = gm.detect_conflicts(glossary)
        surfaces = {c["surface"] for c in conflicts}
        self.assertIn("중운위", surfaces)


class MissingTermDetectionTests(unittest.TestCase):
    def test_detect_missing_terms(self):
        glossary = [{
            "ko_term": "중앙운영위원회", "en_term": "Central Steering Committee",
            "type": "Organization", "aliases": "중운위",
            "usage_note": "", "status": "approved", "source": "user", "last_context": "",
        }]
        candidate_terms = [
            {"ko_term": "중앙운영위원회", "type": "Organization", "reason": "", "context_sentence": "", "suggested_translation": "", "priority": "high"},
            {"ko_term": "중운위", "type": "Organization", "reason": "", "context_sentence": "", "suggested_translation": "", "priority": "high"},
            {"ko_term": "비상대책위원회", "type": "Organization", "reason": "", "context_sentence": "비상대책위원회는 구성되었다.", "suggested_translation": "Emergency Committee", "priority": "high"},
            {"ko_term": "선거시행세칙", "type": "Regulation", "reason": "", "context_sentence": "선거시행세칙 제12조", "suggested_translation": "Election Implementation Rules", "priority": "high"},
        ]
        nodes = tg.make_nodes(None)
        state = {"glossary": glossary, "candidate_terms": candidate_terms}
        result = nodes["detect_missing_terms"](state)
        missing_ko_terms = {t["ko_term"] for t in result["missing_terms"]}
        self.assertEqual(missing_ko_terms, {"비상대책위원회", "선거시행세칙"})


class ParseUserTranslationsTests(unittest.TestCase):
    """One term is asked (and answered) per interrupt() round-trip."""

    def test_answer_is_recorded_for_current_term(self):
        nodes = tg.make_nodes(None)
        state = {
            "current_term": {"ko_term": "비상대책위원회", "priority": "high"},
            "raw_user_response": "Emergency Committee",
            "pending_terms": [{"ko_term": "비상대책위원회", "priority": "high"}],
        }
        result = nodes["parse_user_translations"](state)
        self.assertEqual(result["user_term_decisions"], [{
            "ko_term": "비상대책위원회", "en_term": "Emergency Committee", "aliases": "",
        }])
        self.assertEqual(result["pending_terms"], [])

    def test_skip_keyword_leaves_term_unanswered(self):
        nodes = tg.make_nodes(None)
        state = {
            "current_term": {"ko_term": "선거시행세칙", "priority": "high"},
            "raw_user_response": "skip",
            "pending_terms": [{"ko_term": "선거시행세칙", "priority": "high"}],
        }
        result = nodes["parse_user_translations"](state)
        self.assertEqual(result["user_term_decisions"], [])
        self.assertIn("선거시행세칙", result["warnings"][0])

    def test_next_pending_term_is_asked_after_current_is_removed(self):
        nodes = tg.make_nodes(None)
        state = {
            "current_term": {"ko_term": "선거시행세칙", "priority": "high"},
            "raw_user_response": "Election Implementation Rules",
            "pending_terms": [
                {"ko_term": "선거시행세칙", "priority": "high"},
                {"ko_term": "총학생회", "priority": "high"},
            ],
        }
        result = nodes["parse_user_translations"](state)
        self.assertEqual(result["pending_terms"], [{"ko_term": "총학생회", "priority": "high"}])
        self.assertEqual(tg._term_answer_branch(result), "request_user_translations")


class GlossaryAppendTests(unittest.TestCase):
    def setUp(self):
        self.glossary = [{
            "ko_term": "중앙운영위원회", "en_term": "Central Steering Committee",
            "type": "Organization", "aliases": "중운위",
            "usage_note": "", "status": "approved", "source": "user", "last_context": "",
        }]
        self.candidates = [
            {"ko_term": "비상대책위원회", "type": "Organization", "context_sentence": "비상대책위원회는 선거 무산 이후 구성되었다."},
        ]

    def test_append_new_term(self):
        decisions = [{"ko_term": "비상대책위원회", "en_term": "Emergency Committee", "aliases": "비대위"}]
        updated, conflicts = gm.append_user_terms(self.glossary, decisions, self.candidates)
        self.assertEqual(conflicts, [])
        new_row = gm.find_glossary_entry(updated, "비상대책위원회")
        self.assertIsNotNone(new_row)
        self.assertEqual(new_row["en_term"], "Emergency Committee")
        self.assertEqual(new_row["type"], "Organization")
        self.assertEqual(new_row["status"], "approved")
        self.assertEqual(new_row["source"], "user")
        self.assertEqual(new_row["last_context"], "비상대책위원회는 선거 무산 이후 구성되었다.")

    def test_duplicate_append_is_noop(self):
        decisions = [{"ko_term": "중앙운영위원회", "en_term": "Central Steering Committee", "aliases": ""}]
        updated, conflicts = gm.append_user_terms(self.glossary, decisions, [])
        self.assertEqual(len(updated), 1)
        self.assertEqual(conflicts, [])

    def test_conflicting_translation_is_logged_and_existing_kept(self):
        decisions = [{"ko_term": "중앙운영위원회", "en_term": "Central Operations Committee", "aliases": ""}]
        updated, conflicts = gm.append_user_terms(self.glossary, decisions, [])
        self.assertEqual(len(updated), 1)
        self.assertEqual(updated[0]["en_term"], "Central Steering Committee")
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(conflicts[0]["existing_en_term"], "Central Steering Committee")
        self.assertEqual(conflicts[0]["new_en_term"], "Central Operations Committee")


class PlaceholderTests(unittest.TestCase):
    def setUp(self):
        self.glossary = [
            {
                "ko_term": "중앙운영위원회", "en_term": "Central Steering Committee",
                "type": "Organization", "aliases": "중운위",
                "usage_note": "", "status": "approved", "source": "user", "last_context": "",
            },
            {
                "ko_term": "총학생회칙", "en_term": "Undergraduate Student Council Bylaws",
                "type": "Regulation", "aliases": "",
                "usage_note": "", "status": "approved", "source": "user", "last_context": "",
            },
        ]
        self.text = "중앙운영위원회는 총학생회칙에 따라 회의를 소집하였다."
        self.nodes = tg.make_nodes(None)

    def test_protect_glossary_terms(self):
        state = {"raw_text": self.text, "glossary": self.glossary}
        result = self.nodes["protect_glossary_terms"](state)
        self.assertEqual(result["placeholder_map"], {
            "__TERM_001__": "Central Steering Committee",
            "__TERM_002__": "Undergraduate Student Council Bylaws",
        })
        self.assertIn("__TERM_001__", result["protected_text"])
        self.assertIn("__TERM_002__", result["protected_text"])
        self.assertNotIn("중앙운영위원회", result["protected_text"])

    def test_restore_placeholders(self):
        placeholder_map = {
            "__TERM_001__": "Central Steering Committee",
            "__TERM_002__": "Undergraduate Student Council Bylaws",
        }
        state = {
            "translation_draft": (
                "__TERM_001__ convened a meeting in accordance with __TERM_002__."
            ),
            "placeholder_map": placeholder_map,
        }
        result = self.nodes["restore_placeholders"](state)
        self.assertEqual(
            result["final_translation"],
            "Central Steering Committee convened a meeting in accordance with "
            "Undergraduate Student Council Bylaws.",
        )


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.glossary = [{
            "ko_term": "중앙운영위원회", "en_term": "Central Steering Committee",
            "type": "Organization", "aliases": "중운위",
            "usage_note": "", "status": "approved", "source": "user", "last_context": "",
        }]
        self.raw_text = "중앙운영위원회는 회의를 소집하였다."
        self.placeholder_map = {"__TERM_001__": "Central Steering Committee"}
        self.translation_draft = "__TERM_001__ convened a meeting."

    def test_no_violation_when_term_used_correctly(self):
        final_translation = "Central Steering Committee convened a meeting."
        report = audit_mod.audit_translation(
            self.raw_text, self.glossary, self.placeholder_map,
            self.translation_draft, final_translation,
        )
        self.assertFalse(report["has_violation"])

    def test_violation_when_glossary_term_not_used(self):
        final_translation = "Central Operations Committee convened a meeting."
        report = audit_mod.audit_translation(
            self.raw_text, self.glossary, self.placeholder_map,
            self.translation_draft, final_translation,
        )
        self.assertTrue(report["has_violation"])
        issues = [v["issue"] for v in report["violations"]]
        self.assertTrue(any("not followed" in i for i in issues))

    def test_violation_when_placeholder_leftover(self):
        final_translation = "__TERM_001__ convened a meeting."
        report = audit_mod.audit_translation(
            self.raw_text, self.glossary, self.placeholder_map,
            self.translation_draft, final_translation,
        )
        self.assertTrue(report["has_violation"])
        issues = [v["issue"] for v in report["violations"]]
        self.assertTrue(any("unresolved" in i for i in issues))


if __name__ == "__main__":
    unittest.main()
