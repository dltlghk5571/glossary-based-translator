# Per-Organization Token Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each org (one `User` account = one org) a monthly token allowance that hard-blocks the translation pipeline once spent, with admin-managed limits and manual, admin-approved top-ups.

**Architecture:** A running `tokensUsedThisPeriod` counter and `monthlyTokenLimit`/`bonusTokens` live on `User`; a lazy per-request reset (no cron) rolls the period over when the stored `periodStart` is in a different calendar month. The Python pipeline (`web_pipeline.py`, called from the single Vercel Python handler `api/index.py`) checks the balance before calling any LLM and records real usage after. The Next.js/Prisma side owns balance display and the top-up request/approval CRUD.

**Tech Stack:** Python (psycopg, raw SQL against Prisma-managed tables — see `db_glossary.py`/`db_translations.py`), Next.js App Router API routes + Prisma, `unittest` (Python), `node --test` (TypeScript, `lib/*.test.ts` only per `package.json`).

**Spec:** `docs/superpowers/specs/2026-09-16-org-token-quota-design.md`

**Correction to the spec:** the spec says "the Next.js route (`app/api/analyze`, `app/api/translate`) catches it." There is no such Next.js route — `/api/analyze` and `/api/translate` are rewritten (see `vercel.json`) straight to the single Python handler `api/index.py`. The quota-exceeded catch therefore lives in `api/index.py`, not a `route.ts` file. Everything else in the spec is unchanged.

## Global Constraints

- No in-app payment processing — admin grants tokens manually.
- No carryover: both `tokensUsedThisPeriod` and `bonusTokens` reset to 0 on period rollover.
- `analyze_text`/`translate_text` skip the quota check entirely when called with `user_id=None` (existing tests and any non-web caller keep working unchanged).
- The call that crosses the boundary from positive to zero/negative balance is allowed to finish; only the *next* call is blocked.
- Follow existing patterns exactly: raw SQL in `db_*.py` mirrors `db_glossary.py`/`db_translations.py`; Next.js routes mirror `app/api/admin/users/route.ts`; pure business-logic helpers live in `lib/*.ts` with `lib/*.test.ts` coverage, mirroring `lib/glossary.ts`/`lib/glossary.test.ts`.

---

### Task 1: Prisma schema + migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_token_quota/migration.sql` (generated, not hand-written)

**Interfaces:**
- Produces: `User.monthlyTokenLimit` (Int, default 100000), `User.tokensUsedThisPeriod` (Int, default 0), `User.bonusTokens` (Int, default 0), `User.periodStart` (DateTime, default now()), `User.topUpRequests` (relation), model `TokenTopUpRequest` with fields `id, userId, user, status ("pending"|"approved"|"denied"), grantedTokens (Int?), note (String, default ""), createdAt, resolvedAt (DateTime?)`.

- [ ] **Step 1: Add the fields and model to the schema**

Edit `prisma/schema.prisma`'s `User` model — add after the existing `updatedAt` field:

```prisma
  monthlyTokenLimit    Int      @default(100000)
  tokensUsedThisPeriod Int      @default(0)
  bonusTokens          Int      @default(0)
  periodStart          DateTime @default(now())

  topUpRequests TokenTopUpRequest[]
```

Append a new model at the end of the file:

```prisma
model TokenTopUpRequest {
  id            Int       @id @default(autoincrement())
  userId        Int
  user          User      @relation(fields: [userId], references: [id])
  status        String    @default("pending") // pending | approved | denied
  grantedTokens Int?
  note          String    @default("")
  createdAt     DateTime  @default(now())
  resolvedAt    DateTime?

  @@index([userId])
  @@index([status])
}
```

- [ ] **Step 2: Generate and apply the migration**

Run: `npx prisma migrate dev --name add_token_quota`
Expected: a new `prisma/migrations/<timestamp>_add_token_quota/migration.sql` is created and applied against the dev database without error, and `Your database is now in sync with your schema.` is printed.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: completes without error (this also runs automatically via `postinstall`, but run it explicitly here so later tasks' TypeScript compiles against the new fields immediately).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add token quota fields to User and TokenTopUpRequest model"
```

---

### Task 2: `db_users.py` — quota read/write

**Files:**
- Create: `db_users.py`
- Test: `test_db_users.py`

**Interfaces:**
- Consumes: `db.get_connection()` (existing, returns a `psycopg` connection with `dict_row` factory).
- Produces: `get_quota(user_id: int, now: datetime | None = None) -> dict` returning `{"limit": int, "used": int, "bonus": int, "remaining": int}`; `record_usage(user_id: int, input_tokens: int, output_tokens: int, now: datetime | None = None) -> None`. Both are imported by `web_pipeline.py` in Task 3.

- [ ] **Step 1: Write the failing tests**

Create `test_db_users.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m unittest test_db_users.py -v`
Expected: `ModuleNotFoundError: No module named 'db_users'`

- [ ] **Step 3: Implement `db_users.py`**

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m unittest test_db_users.py -v`
Expected: all tests `ok`.

- [ ] **Step 5: Commit**

```bash
git add db_users.py test_db_users.py
git commit -m "feat: add db_users.py for per-org token quota read/write with lazy monthly reset"
```

---

### Task 3: Quota enforcement in `web_pipeline.py`

**Files:**
- Modify: `web_pipeline.py`
- Test: `test_web_pipeline.py`

**Interfaces:**
- Consumes: `db_users.get_quota(user_id) -> dict`, `db_users.record_usage(user_id, input_tokens, output_tokens)` (Task 2).
- Produces: `web_pipeline.QuotaExceededError(quota)` (`.quota` attribute holds the dict from `get_quota`); `analyze_text(text, user_id=None)` (new `user_id` param, was `analyze_text(text)`); `translate_text(text, user_id=None)` (unchanged signature, now also quota-checked). Both raise `QuotaExceededError` before invoking any `generate_fn` when `user_id is not None` and `remaining <= 0`. Consumed by `api/index.py` in Task 4.

- [ ] **Step 1: Write the failing tests**

Add to `test_web_pipeline.py` (new imports at top, then two new test methods):

```python
from unittest.mock import MagicMock

import db_users
```

Add inside `AnalyzeTextTests`:

```python
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
```

Add inside `TranslateTextTests`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m unittest test_web_pipeline.py -v`
Expected: `AttributeError: module 'web_pipeline' has no attribute 'QuotaExceededError'` (and related failures for the other new tests).

- [ ] **Step 3: Implement the enforcement**

In `web_pipeline.py`, add the import and exception near the top (after the existing imports):

```python
import db_users
```

```python
class QuotaExceededError(Exception):
    def __init__(self, quota):
        super().__init__(f"Token quota exhausted: {quota['used']}/{quota['limit']} used, {quota['remaining']} remaining")
        self.quota = quota
```

Replace `analyze_text`:

```python
def analyze_text(text, user_id=None):
    """Step 1: extract candidate terms, match against the glossary, surface
    missing ones for the user to fill in and approve (POST /api/glossary/approve)."""
    if user_id is not None:
        quota = db_users.get_quota(user_id)
        if quota["remaining"] <= 0:
            raise QuotaExceededError(quota)

    glossary = db_glossary.fetch_glossary_rows()
    usage = {}
    generate_fns = build_generate_fns(usage_tracker=usage)

    candidate_terms = term_extractor.extract_candidate_terms(text, generate_fns["term_extraction"])
    matched_terms = gm.match_terms(text, glossary)
    missing_terms = _detect_missing_terms(candidate_terms, glossary)

    if user_id is not None:
        db_users.record_usage(user_id, usage.get("input_tokens", 0), usage.get("output_tokens", 0))

    return {
        "candidate_terms": candidate_terms,
        "matched_terms": matched_terms,
        "missing_terms": missing_terms,
        "warnings": [],
    }
```

In `translate_text`, add the check at the very top (before `glossary = db_glossary.fetch_glossary_rows()`) and the record call right after `db_translations.insert_translation(...)`:

```python
def translate_text(text, user_id=None):
    """Step 2: protect glossary terms, translate, restore, audit, repair --
    same sequence as translation_graph.py's post-glossary-update nodes.
    Persists a Translation row (source/output text, warnings, glossary terms
    applied, token usage, user_id) for the backoffice's audit trail."""
    if user_id is not None:
        quota = db_users.get_quota(user_id)
        if quota["remaining"] <= 0:
            raise QuotaExceededError(quota)

    glossary = db_glossary.fetch_glossary_rows()
    ...
```

(the rest of the function body is unchanged up through `db_translations.insert_translation(...)`), then immediately after that call:

```python
    if user_id is not None:
        db_users.record_usage(user_id, usage.get("input_tokens"), usage.get("output_tokens"))

    return {
        "translation": final_translation,
        "audit_report": audit_report,
        "warnings": warnings,
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m unittest test_translation_system.py test_web_pipeline.py -v`
Expected: all tests `ok` (including the pre-existing ones — this confirms `user_id=None` callers are unaffected).

- [ ] **Step 5: Commit**

```bash
git add web_pipeline.py test_web_pipeline.py
git commit -m "feat: enforce per-org token quota in analyze_text/translate_text"
```

---

### Task 4: Wire quota enforcement into `api/index.py`

**Files:**
- Modify: `api/index.py`

**Interfaces:**
- Consumes: `web_pipeline.analyze_text(text, user_id=None)`, `web_pipeline.translate_text(text, user_id=None)`, `web_pipeline.QuotaExceededError` (Task 3).

- [ ] **Step 1: Pass `user_id` through to `analyze_text`**

In `api/index.py`, change the `ROUTES` dict:

```python
ROUTES = {
    "/api/analyze": lambda text, user_id: web_pipeline.analyze_text(text, user_id=user_id),
    "/api/translate": lambda text, user_id: web_pipeline.translate_text(text, user_id=user_id),
}
```

- [ ] **Step 2: Catch `QuotaExceededError` as a 403**

In `do_POST`, add a specific except clause before the generic one:

```python
        try:
            body = read_json_body(self)
            text = (body.get("text") or "").strip()
            if not text:
                return send_json(self, 400, {"ok": False, "error": "text is required"})
            result = route(text, user_id)
            send_json(self, 200, result)
        except web_pipeline.QuotaExceededError as e:
            send_json(self, 403, {"ok": False, "error": "quota_exceeded", "quota": e.quota})
        except Exception as e:
            send_json(self, 500, {"ok": False, "error": str(e)})
```

- [ ] **Step 3: Verify by reading**

There's no existing test harness for `api/index.py` (it's exercised via `test_web_pipeline.py` at the `web_pipeline` layer and manually via the deployed endpoint). Run: `python3 -m py_compile api/index.py`
Expected: no output (compiles clean).

- [ ] **Step 4: Commit**

```bash
git add api/index.py
git commit -m "feat: return 403 with quota payload when analyze/translate is quota-blocked"
```

---

### Task 5: `lib/quota.ts` + user-facing quota API routes

**Files:**
- Create: `lib/quota.ts`
- Test: `lib/quota.test.ts`
- Create: `app/api/quota/route.ts`
- Create: `app/api/quota/topup-request/route.ts`

**Interfaces:**
- Consumes: `getSessionUserFromRequest` (`lib/auth.ts`), `prisma` (`lib/prisma.ts`).
- Produces: `isSamePeriod(periodStart: Date, now: Date): boolean`, `computeRemaining(limit: number, bonus: number, used: number): number`, `getQuotaSnapshot(userId: number, now?: Date): Promise<{limit: number; used: number; bonus: number; remaining: number}>` (all exported from `lib/quota.ts`, consumed by Task 7's `lib/api.ts` types and by the admin routes in Task 6 if needed). `GET /api/quota` → `{ok, limit, used, bonus, remaining, pendingRequest}`. `POST /api/quota/topup-request` (body `{note?: string}`) → `{ok, topUp}` or `409` if a pending request already exists.

- [ ] **Step 1: Write the failing test**

Create `lib/quota.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSamePeriod, computeRemaining } from "./quota.ts";

test("isSamePeriod is true within the same calendar month", () => {
  assert.equal(isSamePeriod(new Date("2026-09-01T00:00:00Z"), new Date("2026-09-30T23:00:00Z")), true);
});

test("isSamePeriod is false across a month boundary", () => {
  assert.equal(isSamePeriod(new Date("2026-08-31T23:00:00Z"), new Date("2026-09-01T00:00:00Z")), false);
});

test("computeRemaining sums limit and bonus, subtracts used", () => {
  assert.equal(computeRemaining(100, 20, 50), 70);
  assert.equal(computeRemaining(100, 0, 150), -50);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/quota.test.ts`
Expected: fails to resolve `./quota.ts` (module not found).

- [ ] **Step 3: Implement `lib/quota.ts`**

```ts
import { prisma } from "./prisma";

export function isSamePeriod(periodStart: Date, now: Date): boolean {
  return periodStart.getUTCFullYear() === now.getUTCFullYear() && periodStart.getUTCMonth() === now.getUTCMonth();
}

export function computeRemaining(limit: number, bonus: number, used: number): number {
  return limit + bonus - used;
}

export type QuotaSnapshot = { limit: number; used: number; bonus: number; remaining: number };

// Applies the lazy monthly reset (if the stored period has rolled over) then
// returns the current snapshot. Mirrors db_users.get_quota() on the Python
// side -- both runtimes read/write the same User row, so keep the reset
// logic in sync between the two if it ever changes.
export async function getQuotaSnapshot(userId: number, now: Date = new Date()): Promise<QuotaSnapshot> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { monthlyTokenLimit: true, tokensUsedThisPeriod: true, bonusTokens: true, periodStart: true },
  });

  let used = user.tokensUsedThisPeriod;
  let bonus = user.bonusTokens;

  if (!isSamePeriod(user.periodStart, now)) {
    used = 0;
    bonus = 0;
    await prisma.user.update({
      where: { id: userId },
      data: { tokensUsedThisPeriod: 0, bonusTokens: 0, periodStart: now },
    });
  }

  return { limit: user.monthlyTokenLimit, used, bonus, remaining: computeRemaining(user.monthlyTokenLimit, bonus, used) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/quota.test.ts`
Expected: 3 passing tests.

- [ ] **Step 5: Implement `app/api/quota/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getQuotaSnapshot } from "@/lib/quota";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // session-cookie-dependent response

export async function GET(request: NextRequest) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const quota = await getQuotaSnapshot(user.id);
  const pending = await prisma.tokenTopUpRequest.findFirst({
    where: { userId: user.id, status: "pending" },
  });

  return NextResponse.json({ ok: true, ...quota, pendingRequest: !!pending });
}
```

- [ ] **Step 6: Implement `app/api/quota/topup-request/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const existing = await prisma.tokenTopUpRequest.findFirst({
    where: { userId: user.id, status: "pending" },
  });
  if (existing) {
    return NextResponse.json({ ok: false, error: "이미 대기 중인 요청이 있습니다." }, { status: 409 });
  }

  const body = await request.json().catch(() => ({}));
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";

  const topUp = await prisma.tokenTopUpRequest.create({
    data: { userId: user.id, note },
  });

  return NextResponse.json({ ok: true, topUp });
}
```

- [ ] **Step 7: Manual smoke check**

Run: `npm run dev`, log in as a non-admin user, then in another terminal:
```bash
curl -b cookies.txt http://localhost:3000/api/quota
curl -b cookies.txt -X POST http://localhost:3000/api/quota/topup-request -H "Content-Type: application/json" -d '{"note":"test"}'
curl -b cookies.txt -X POST http://localhost:3000/api/quota/topup-request -H "Content-Type: application/json" -d '{}'
```
Expected: first call returns `{"ok":true,"limit":100000,"used":0,"bonus":0,"remaining":100000,"pendingRequest":false}`; second returns `{"ok":true,"topUp":{...}}`; third (duplicate) returns `409` with the "이미 대기 중" message.

- [ ] **Step 8: Commit**

```bash
git add lib/quota.ts lib/quota.test.ts "app/api/quota"
git commit -m "feat: add org-facing quota balance and top-up request endpoints"
```

---

### Task 6: Admin quota management API routes

**Files:**
- Create: `app/api/admin/quota/route.ts`
- Create: `app/api/admin/topups/route.ts`

**Interfaces:**
- Consumes: `getSessionUserFromRequest`, `prisma` (as Task 5).
- Produces: `GET /api/admin/quota` → `{ok, orgs: [{id, username, monthlyTokenLimit, tokensUsedThisPeriod, bonusTokens}]}`; `PATCH /api/admin/quota` (body `{userId, monthlyTokenLimit}`) → `{ok, org}`. `GET /api/admin/topups` → `{ok, requests: [{id, userId, status, grantedTokens, note, createdAt, user: {username}}]}` (pending only); `POST /api/admin/topups` (body `{id, action: "approve"|"deny", grantedTokens?}`) → `{ok}`.

- [ ] **Step 1: Implement `app/api/admin/quota/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAdmin(request: NextRequest) {
  const user = await getSessionUserFromRequest(request);
  return user && user.role === "admin" ? user : null;
}

export async function GET(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const orgs = await prisma.user.findMany({
    select: { id: true, username: true, monthlyTokenLimit: true, tokensUsedThisPeriod: true, bonusTokens: true },
    orderBy: { username: "asc" },
  });
  return NextResponse.json({ ok: true, orgs });
}

export async function PATCH(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const userId = Number(body.userId);
  const monthlyTokenLimit = Number(body.monthlyTokenLimit);
  if (!Number.isInteger(userId) || !Number.isInteger(monthlyTokenLimit) || monthlyTokenLimit < 0) {
    return NextResponse.json({ ok: false, error: "invalid userId or monthlyTokenLimit" }, { status: 400 });
  }

  const org = await prisma.user.update({
    where: { id: userId },
    data: { monthlyTokenLimit },
    select: { id: true, username: true, monthlyTokenLimit: true, tokensUsedThisPeriod: true, bonusTokens: true },
  });
  return NextResponse.json({ ok: true, org });
}
```

- [ ] **Step 2: Implement `app/api/admin/topups/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAdmin(request: NextRequest) {
  const user = await getSessionUserFromRequest(request);
  return user && user.role === "admin" ? user : null;
}

export async function GET(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const requests = await prisma.tokenTopUpRequest.findMany({
    where: { status: "pending" },
    include: { user: { select: { username: true } } },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ ok: true, requests });
}

export async function POST(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  const action = body.action;
  if (!Number.isInteger(id) || !["approve", "deny"].includes(action)) {
    return NextResponse.json({ ok: false, error: "invalid id or action" }, { status: 400 });
  }

  const existing = await prisma.tokenTopUpRequest.findUnique({ where: { id } });
  if (!existing || existing.status !== "pending") {
    return NextResponse.json({ ok: false, error: "request not found or already resolved" }, { status: 404 });
  }

  if (action === "approve") {
    const grantedTokens = Number(body.grantedTokens);
    if (!Number.isInteger(grantedTokens) || grantedTokens <= 0) {
      return NextResponse.json({ ok: false, error: "grantedTokens must be a positive integer" }, { status: 400 });
    }
    await prisma.$transaction([
      prisma.tokenTopUpRequest.update({
        where: { id },
        data: { status: "approved", grantedTokens, resolvedAt: new Date() },
      }),
      prisma.user.update({
        where: { id: existing.userId },
        data: { bonusTokens: { increment: grantedTokens } },
      }),
    ]);
  } else {
    await prisma.tokenTopUpRequest.update({
      where: { id },
      data: { status: "denied", resolvedAt: new Date() },
    });
  }

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Manual smoke check**

Run: `npm run dev`, log in as admin:
```bash
curl -b admin_cookies.txt http://localhost:3000/api/admin/quota
curl -b admin_cookies.txt -X PATCH http://localhost:3000/api/admin/quota -H "Content-Type: application/json" -d '{"userId":1,"monthlyTokenLimit":50000}'
curl -b admin_cookies.txt http://localhost:3000/api/admin/topups
curl -b admin_cookies.txt -X POST http://localhost:3000/api/admin/topups -H "Content-Type: application/json" -d '{"id":1,"action":"approve","grantedTokens":20000}'
```
Expected: each returns `ok: true` with the updated/listed data; a non-admin session gets `401` on all four.

- [ ] **Step 4: Commit**

```bash
git add app/api/admin/quota app/api/admin/topups
git commit -m "feat: add admin quota management and top-up approval endpoints"
```

---

### Task 7: `lib/types.ts` + `lib/api.ts` client wiring

**Files:**
- Modify: `lib/types.ts`
- Modify: `lib/api.ts`

**Interfaces:**
- Consumes: the five routes from Tasks 5-6.
- Produces: types `QuotaInfo`, `OrgQuota`, `TopUpRequest`; functions `getQuota()`, `requestTopUp(note)`, `adminListQuotas()`, `adminUpdateQuotaLimit(userId, monthlyTokenLimit)`, `adminListTopUps()`, `adminResolveTopUp(id, action, grantedTokens?)`; error class `QuotaExceededClientError` (thrown by the shared `request()` helper on a `quota_exceeded` 403). All consumed by Tasks 8-9's page components.

- [ ] **Step 1: Add types to `lib/types.ts`**

Append:

```ts
export type QuotaInfo = {
  limit: number;
  used: number;
  bonus: number;
  remaining: number;
  pendingRequest: boolean;
};

export type OrgQuota = {
  id: number;
  username: string;
  monthlyTokenLimit: number;
  tokensUsedThisPeriod: number;
  bonusTokens: number;
};

export type TopUpRequest = {
  id: number;
  userId: number;
  status: string;
  grantedTokens: number | null;
  note: string;
  createdAt: string;
  user: { username: string };
};
```

- [ ] **Step 2: Add `QuotaExceededClientError` and quota functions to `lib/api.ts`**

Add the import and error class near the top (after the existing `import type` line):

```ts
import type { AnalyzeResult, GlossaryTerm, OrgQuota, QuotaInfo, TopUpRequest, TranslateResult } from "./types";

export class QuotaExceededClientError extends Error {
  quota: { limit: number; used: number; bonus: number; remaining: number };
  constructor(quota: { limit: number; used: number; bonus: number; remaining: number }) {
    super("한도를 초과했습니다.");
    this.quota = quota;
  }
}
```

In the shared `request<T>` function, replace the `if (!res.ok)` block:

```ts
  if (!res.ok) {
    const errorBody = data as { error?: string; quota?: { limit: number; used: number; bonus: number; remaining: number } } | null;
    if (res.status === 403 && errorBody?.error === "quota_exceeded" && errorBody.quota) {
      throw new QuotaExceededClientError(errorBody.quota);
    }
    throw new Error(errorBody?.error || `요청이 실패했습니다 (HTTP ${res.status}). 잠시 후 다시 시도해주세요.`);
  }
```

Append the new functions at the end of the file:

```ts
export function getQuota() {
  return request<{ ok: true } & QuotaInfo>("/api/quota");
}

export function requestTopUp(note: string) {
  return request<{ ok: true; topUp: { id: number } }>("/api/quota/topup-request", {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

export function adminListQuotas() {
  return request<{ ok: true; orgs: OrgQuota[] }>("/api/admin/quota");
}

export function adminUpdateQuotaLimit(userId: number, monthlyTokenLimit: number) {
  return request<{ ok: true; org: OrgQuota }>("/api/admin/quota", {
    method: "PATCH",
    body: JSON.stringify({ userId, monthlyTokenLimit }),
  });
}

export function adminListTopUps() {
  return request<{ ok: true; requests: TopUpRequest[] }>("/api/admin/topups");
}

export function adminResolveTopUp(id: number, action: "approve" | "deny", grantedTokens?: number) {
  return request<{ ok: true }>("/api/admin/topups", {
    method: "POST",
    body: JSON.stringify({ id, action, grantedTokens }),
  });
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/types.ts lib/api.ts
git commit -m "feat: add quota types and client functions to lib/api.ts"
```

---

### Task 8: Translate page — balance display + blocked/request UI

**Files:**
- Modify: `app/(protected)/translate/page.tsx`

**Interfaces:**
- Consumes: `getQuota`, `requestTopUp`, `QuotaExceededClientError` (`lib/api.ts`, Task 7); `QuotaInfo` (`lib/types.ts`, Task 7).

- [ ] **Step 1: Add quota state and load-on-mount**

In `app/(protected)/translate/page.tsx`, update the imports:

```tsx
import { useEffect, useState } from "react";
import { analyze, getQuota, QuotaExceededClientError, requestTopUp, suggestTerm, translate } from "@/lib/api";
import type { AnalyzeResult, CandidateTerm, QuotaInfo, TranslateResult } from "@/lib/types";
```

Add state right after the existing `useState` calls in `TranslatePage`:

```tsx
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [blockedQuota, setBlockedQuota] = useState<{ limit: number; used: number; bonus: number; remaining: number } | null>(null);
  const [topUpNote, setTopUpNote] = useState("");
  const [requestingTopUp, setRequestingTopUp] = useState(false);

  async function loadQuota() {
    try {
      const q = await getQuota();
      setQuota(q);
    } catch {
      // non-fatal -- balance display is a convenience, don't block the page on it
    }
  }

  useEffect(() => {
    loadQuota();
  }, []);
```

- [ ] **Step 2: Catch `QuotaExceededClientError` in both call sites**

Replace `runTranslate`'s catch block:

```tsx
  async function runTranslate() {
    setPhase("translating");
    try {
      const result = await translate(text);
      setTranslateResult(result);
      setAnalyzeResult(null);
      setPhase("idle");
      await loadQuota();
    } catch (err) {
      if (err instanceof QuotaExceededClientError) {
        setBlockedQuota(err.quota);
      } else {
        setError(err instanceof Error ? err.message : "Translate failed");
      }
      setPhase("idle");
    }
  }
```

Replace `handleTranslateClick`'s catch block:

```tsx
  async function handleTranslateClick() {
    if (!text.trim() || busy) return;
    setError("");
    setBlockedQuota(null);
    setTranslateResult(null);
    setPhase("analyzing");
    try {
      const result = await analyze(text);
      if (result.missing_terms.length === 0) {
        await runTranslate();
        return;
      }
      setAnalyzeResult(result);
      const initial: Record<string, MissingEdit> = {};
      for (const t of result.missing_terms) {
        initial[t.ko_term] = { en_term: t.suggested_translation || "", aliases: "" };
      }
      setEdits(initial);
      setPhase("reviewing");
    } catch (err) {
      if (err instanceof QuotaExceededClientError) {
        setBlockedQuota(err.quota);
      } else {
        setError(err instanceof Error ? err.message : "Analyze failed");
      }
      setPhase("idle");
    }
  }
```

- [ ] **Step 3: Add the request-top-up handler**

Add alongside the other handlers:

```tsx
  async function handleRequestTopUp() {
    setRequestingTopUp(true);
    try {
      await requestTopUp(topUpNote.trim());
      setTopUpNote("");
      await loadQuota();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setRequestingTopUp(false);
    }
  }
```

- [ ] **Step 4: Render the balance and blocked state**

In the JSX, add the balance line right after the `<p className="subtitle">` in the header:

```tsx
          <p className="subtitle">한국어 원문을 붙여넣고 Translate를 누르세요.</p>
          {quota && (
            <p className="hint">
              이번 달 잔여 토큰: {quota.remaining.toLocaleString()} / {(quota.limit + quota.bonus).toLocaleString()}
            </p>
          )}
```

Add the blocked-state card right before the `{translateResult && <TranslationPanel .../>}` line:

```tsx
      {blockedQuota && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0, fontSize: 15 }}>이번 달 토큰 한도를 초과했습니다</h2>
          <p className="hint">
            사용량: {blockedQuota.used.toLocaleString()} / {(blockedQuota.limit + blockedQuota.bonus).toLocaleString()}
          </p>
          {quota?.pendingRequest ? (
            <p className="hint">이미 충전 요청이 대기 중입니다. 관리자 승인을 기다려주세요.</p>
          ) : (
            <>
              <label className="field">
                <span>요청 사유 (선택)</span>
                <input value={topUpNote} onChange={(e) => setTopUpNote(e.target.value)} placeholder="예: 이번 달 행사 공지 다수" />
              </label>
              <button className="btn btn-primary" onClick={handleRequestTopUp} disabled={requestingTopUp}>
                {requestingTopUp ? "요청 중..." : "충전 요청하기"}
              </button>
            </>
          )}
        </section>
      )}

```

- [ ] **Step 5: Manual verification**

Run: `npm run dev`, log in as a non-admin org account whose `monthlyTokenLimit` you've set to a very low value (e.g. `1`) via `PATCH /api/admin/quota` (Task 6), then click Translate on any text.
Expected: balance line shows the low remaining count; after the block, the "이번 달 토큰 한도를 초과했습니다" card appears with a working "충전 요청하기" button; clicking it once succeeds, a second attempt shows "이미 충전 요청이 대기 중입니다."

- [ ] **Step 6: Commit**

```bash
git add "app/(protected)/translate/page.tsx"
git commit -m "feat: show token balance and blocked/top-up-request state on the translate page"
```

---

### Task 9: Admin page — quota table + top-up approval UI

**Files:**
- Modify: `app/(protected)/admin/page.tsx`

**Interfaces:**
- Consumes: `adminListQuotas`, `adminUpdateQuotaLimit`, `adminListTopUps`, `adminResolveTopUp` (`lib/api.ts`, Task 7); `OrgQuota`, `TopUpRequest` (`lib/types.ts`, Task 7).

- [ ] **Step 1: Add imports and state**

Update the imports at the top of `app/(protected)/admin/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { adminListQuotas, adminListTopUps, adminResolveTopUp, adminUpdateQuotaLimit } from "@/lib/api";
import type { OrgQuota, TopUpRequest } from "@/lib/types";
```

Add state inside `AdminPage`, alongside the existing `useState` calls:

```tsx
  const [orgs, setOrgs] = useState<OrgQuota[]>([]);
  const [topUps, setTopUps] = useState<TopUpRequest[]>([]);
  const [grantAmounts, setGrantAmounts] = useState<Record<number, string>>({});

  async function loadQuotaData() {
    try {
      const [{ orgs }, { requests }] = await Promise.all([adminListQuotas(), adminListTopUps()]);
      setOrgs(orgs);
      setTopUps(requests);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load quota data");
    }
  }
```

Add `loadQuotaData()` to the existing `useEffect`:

```tsx
  useEffect(() => {
    load();
    loadQuotaData();
  }, []);
```

- [ ] **Step 2: Add handlers**

```tsx
  async function handleUpdateLimit(userId: number, monthlyTokenLimit: number) {
    setError("");
    try {
      await adminUpdateQuotaLimit(userId, monthlyTokenLimit);
      await loadQuotaData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update limit");
    }
  }

  async function handleResolveTopUp(id: number, action: "approve" | "deny") {
    setError("");
    try {
      const grantedTokens = action === "approve" ? Number(grantAmounts[id] || 0) : undefined;
      if (action === "approve" && (!grantedTokens || grantedTokens <= 0)) {
        setError("지급할 토큰 수를 입력하세요.");
        return;
      }
      await adminResolveTopUp(id, action, grantedTokens);
      await loadQuotaData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve request");
    }
  }
```

- [ ] **Step 3: Render the quota table and top-up requests**

Add before the closing `</main>` (after the existing "계정 목록" `<section>`):

```tsx
      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0, fontSize: 15 }}>단체별 토큰 쿼터</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Username</th>
                <th>사용량</th>
                <th>월 한도</th>
                <th>보너스</th>
                <th>잔여</th>
                <th>한도 수정</th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((org) => (
                <tr key={org.id}>
                  <td>{org.username}</td>
                  <td>{org.tokensUsedThisPeriod.toLocaleString()}</td>
                  <td>{org.monthlyTokenLimit.toLocaleString()}</td>
                  <td>{org.bonusTokens.toLocaleString()}</td>
                  <td>{(org.monthlyTokenLimit + org.bonusTokens - org.tokensUsedThisPeriod).toLocaleString()}</td>
                  <td>
                    <input
                      type="number"
                      defaultValue={org.monthlyTokenLimit}
                      style={{ width: 100 }}
                      onBlur={(e) => {
                        const value = Number(e.target.value);
                        if (Number.isInteger(value) && value >= 0 && value !== org.monthlyTokenLimit) {
                          handleUpdateLimit(org.id, value);
                        }
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0, fontSize: 15 }}>충전 요청 ({topUps.length})</h2>
        {topUps.length === 0 ? (
          <p className="hint">대기 중인 요청이 없습니다.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>사유</th>
                  <th>요청일</th>
                  <th>지급 토큰</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {topUps.map((t) => (
                  <tr key={t.id}>
                    <td>{t.user.username}</td>
                    <td className="hint">{t.note || "-"}</td>
                    <td className="hint">{new Date(t.createdAt).toLocaleDateString()}</td>
                    <td>
                      <input
                        type="number"
                        placeholder="예: 20000"
                        style={{ width: 100 }}
                        value={grantAmounts[t.id] || ""}
                        onChange={(e) => setGrantAmounts((prev) => ({ ...prev, [t.id]: e.target.value }))}
                      />
                    </td>
                    <td>
                      <div className="btn-row">
                        <button className="btn btn-sm" onClick={() => handleResolveTopUp(t.id, "approve")}>
                          승인
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={() => handleResolveTopUp(t.id, "deny")}>
                          거절
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
```

- [ ] **Step 4: Manual verification**

Run: `npm run dev`, log in as admin, open `/admin`.
Expected: the quota table lists every org with editable limits (blur after changing a value persists it — reload the page to confirm); submitting a top-up request as a non-admin org account makes it appear in "충전 요청"; approving with an amount moves it out of the pending list and increases that org's 보너스/잔여 in the table above.

- [ ] **Step 5: Commit**

```bash
git add "app/(protected)/admin/page.tsx"
git commit -m "feat: add org quota table and top-up approval UI to the admin page"
```

---

## Self-Review Notes

- **Spec coverage:** data model (Task 1) — done; enforcement + lazy reset in Python (Tasks 2-4) — done; admin UI (Task 9) and its two API routes (Task 6) — done; org-facing UI (Task 8) and its two API routes (Task 5) — done; testing section — `test_db_users.py` and `test_web_pipeline.py` additions cover the lazy-reset boundary and the `QuotaExceededError` gate as specified; the spec's "manual: exercise the admin approve/deny flow... round trip" is Task 9 Step 4.
- **Correction folded in:** the spec's "Next.js route... catches it" is corrected to `api/index.py` at the top of this plan (Task 4) — the spec's intent (block at the API boundary, respond with quota info) is unchanged, only the file.
- **Type consistency check:** `QuotaInfo` (Task 7) matches the `GET /api/quota` response shape from Task 5; `OrgQuota`/`TopUpRequest` match the admin route response shapes from Task 6; `db_users.get_quota`'s return dict shape (`limit/used/bonus/remaining`) matches `QuotaExceededError.quota` (Task 3) matches the `quota` field the frontend reads in `QuotaExceededClientError` (Task 7) and renders in Task 8.
