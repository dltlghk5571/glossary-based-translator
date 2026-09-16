import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import db_users


def _fake_connection(row):
    """Mimics `with get_connection() as conn: with conn.cursor() as cur:` --
    conn/cursor are context managers whose __enter__ returns a mock exposing
    execute/fetchone."""
    cur = MagicMock()
    cur.fetchone.return_value = row
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    conn.__enter__.return_value = conn
    return conn, cur


class PureHelperTests(unittest.TestCase):
    def test_same_period_true_within_month(self):
        self.assertTrue(db_users._is_same_period(
            datetime(2026, 9, 1, tzinfo=timezone.utc),
            datetime(2026, 9, 30, tzinfo=timezone.utc),
        ))

    def test_same_period_false_across_month(self):
        self.assertFalse(db_users._is_same_period(
            datetime(2026, 8, 31, tzinfo=timezone.utc),
            datetime(2026, 9, 1, tzinfo=timezone.utc),
        ))

    def test_compute_remaining(self):
        self.assertEqual(db_users._compute_remaining(limit=100, bonus=20, used=50), 70)
        self.assertEqual(db_users._compute_remaining(limit=100, bonus=0, used=150), -50)


class GetQuotaTests(unittest.TestCase):
    @patch("db_users.get_connection")
    def test_no_rollover_returns_stored_values(self, mock_get_conn):
        now = datetime(2026, 9, 15, tzinfo=timezone.utc)
        row = {
            "monthlyTokenLimit": 100000, "tokensUsedThisPeriod": 4000,
            "bonusTokens": 500, "periodStart": datetime(2026, 9, 1, tzinfo=timezone.utc),
        }
        conn, cur = _fake_connection(row)
        mock_get_conn.return_value = conn

        result = db_users.get_quota(user_id=1, now=now)

        self.assertEqual(result, {"limit": 100000, "used": 4000, "bonus": 500, "remaining": 96500})
        # no reset UPDATE should have been issued -- only the SELECT
        self.assertEqual(cur.execute.call_count, 1)

    @patch("db_users.get_connection")
    def test_rollover_resets_used_and_bonus(self, mock_get_conn):
        now = datetime(2026, 9, 15, tzinfo=timezone.utc)
        row = {
            "monthlyTokenLimit": 100000, "tokensUsedThisPeriod": 99000,
            "bonusTokens": 5000, "periodStart": datetime(2026, 8, 20, tzinfo=timezone.utc),
        }
        conn, cur = _fake_connection(row)
        mock_get_conn.return_value = conn

        result = db_users.get_quota(user_id=1, now=now)

        self.assertEqual(result, {"limit": 100000, "used": 0, "bonus": 0, "remaining": 100000})
        # SELECT + the reset UPDATE
        self.assertEqual(cur.execute.call_count, 2)
        conn.commit.assert_called_once()

    @patch("db_users.get_connection")
    def test_missing_user_raises(self, mock_get_conn):
        conn, cur = _fake_connection(None)
        mock_get_conn.return_value = conn

        with self.assertRaises(ValueError):
            db_users.get_quota(user_id=999, now=datetime(2026, 9, 15, tzinfo=timezone.utc))


class RecordUsageTests(unittest.TestCase):
    @patch("db_users.get_connection")
    def test_adds_input_and_output_tokens(self, mock_get_conn):
        now = datetime(2026, 9, 15, tzinfo=timezone.utc)
        row = {
            "monthlyTokenLimit": 100000, "tokensUsedThisPeriod": 1000,
            "bonusTokens": 0, "periodStart": datetime(2026, 9, 1, tzinfo=timezone.utc),
        }
        conn, cur = _fake_connection(row)
        mock_get_conn.return_value = conn

        db_users.record_usage(user_id=1, input_tokens=300, output_tokens=200, now=now)

        # one SELECT (via get_quota's rollover check) + one UPDATE adding 500
        update_calls = [c for c in cur.execute.call_args_list if "UPDATE" in c.args[0]]
        self.assertEqual(len(update_calls), 1)
        self.assertEqual(update_calls[0].args[1], [500, 1])

    @patch("db_users.get_connection")
    def test_zero_total_skips_update(self, mock_get_conn):
        now = datetime(2026, 9, 15, tzinfo=timezone.utc)
        row = {
            "monthlyTokenLimit": 100000, "tokensUsedThisPeriod": 1000,
            "bonusTokens": 0, "periodStart": datetime(2026, 9, 1, tzinfo=timezone.utc),
        }
        conn, cur = _fake_connection(row)
        mock_get_conn.return_value = conn

        db_users.record_usage(user_id=1, input_tokens=0, output_tokens=0, now=now)

        update_calls = [c for c in cur.execute.call_args_list if "UPDATE" in c.args[0]]
        self.assertEqual(len(update_calls), 0)


if __name__ == "__main__":
    unittest.main()
