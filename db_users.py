"""Token quota read/write for the per-organization monthly allowance.

Same raw-SQL-against-the-Prisma-managed-table pattern as db_glossary.py /
db_translations.py. The lazy monthly reset (no cron) lives here: any read or
write first checks whether `periodStart`'s year/month differs from `now`,
and if so resets tokensUsedThisPeriod and bonusTokens to 0 before applying
whatever the caller asked for.
"""
from datetime import datetime, timezone

from db import get_connection


def _is_same_period(period_start, now):
    return period_start.year == now.year and period_start.month == now.month


def _compute_remaining(limit, bonus, used):
    return limit + bonus - used


def get_quota(user_id, now=None):
    """Returns {"limit", "used", "bonus", "remaining"}, applying the lazy
    monthly reset first if the stored period has rolled over."""
    now = now or datetime.now(timezone.utc)
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT "monthlyTokenLimit", "tokensUsedThisPeriod", "bonusTokens", "periodStart" '
                'FROM "User" WHERE id = %s',
                [user_id],
            )
            row = cur.fetchone()
            if row is None:
                raise ValueError(f"User {user_id} not found")

            limit = row["monthlyTokenLimit"]
            used = row["tokensUsedThisPeriod"]
            bonus = row["bonusTokens"]

            if not _is_same_period(row["periodStart"], now):
                used = 0
                bonus = 0
                cur.execute(
                    'UPDATE "User" SET "tokensUsedThisPeriod" = 0, "bonusTokens" = 0, "periodStart" = %s '
                    'WHERE id = %s',
                    [now, user_id],
                )
                conn.commit()

            return {"limit": limit, "used": used, "bonus": bonus, "remaining": _compute_remaining(limit, bonus, used)}


def record_usage(user_id, input_tokens, output_tokens, now=None):
    """Adds input_tokens + output_tokens to tokensUsedThisPeriod, applying
    the lazy monthly reset first so usage never lands in a stale period."""
    now = now or datetime.now(timezone.utc)
    get_quota(user_id, now=now)  # applies the reset if the period rolled over

    total = (input_tokens or 0) + (output_tokens or 0)
    if total <= 0:
        return

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                'UPDATE "User" SET "tokensUsedThisPeriod" = "tokensUsedThisPeriod" + %s WHERE id = %s',
                [total, user_id],
            )
            conn.commit()
