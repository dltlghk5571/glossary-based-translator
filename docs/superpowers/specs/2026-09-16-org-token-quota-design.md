# Per-Organization Token Quota — Design

## Purpose

Each `User` account represents one student organization (단체) — this is
already how the app is operated (one login per org), not an assumption this
feature introduces. Today an org can call the translation pipeline an
unlimited number of times, with no cost ceiling. This feature gives every org
a monthly token allowance, blocks the pipeline once it's spent, and lets an
org request (and, after paying 총학생회 out-of-band) receive more for the
current month via admin approval.

## Non-goals

- No in-app payment processing (Stripe, etc.) — payment happens outside the
  app; admin grants tokens manually after confirming payment themselves.
- No carryover of unused monthly allowance or unused bonus tokens — both
  reset to zero at the start of each calendar month.
- No per-user sub-accounts within an org — the existing one-account-per-org
  model is unchanged.
- No pre-emptive token estimation before a call (e.g. counting tokens in the
  prompt to predict exact spend) — the quota check is a simple
  already-over-limit gate; see "Overage on the boundary call" below.

## 1. Data model

Two additions to `prisma/schema.prisma`. `tokensUsedThisPeriod` is an
authoritative running counter incremented after every LLM call (not derived
by summing `Translation` rows), because term_extraction calls
(`analyze_text`) don't always produce a saved `Translation` row but still
cost real tokens.

```prisma
model User {
  // ...existing fields unchanged...

  monthlyTokenLimit    Int      @default(100000)  // set per-org by admin
  tokensUsedThisPeriod Int      @default(0)        // incremented after every LLM call
  bonusTokens          Int      @default(0)         // approved top-up, added to this period's allowance only
  periodStart          DateTime @default(now())    // when periodStart's year/month != today's, lazy-reset on next check

  topUpRequests TokenTopUpRequest[]
}

model TokenTopUpRequest {
  id            Int       @id @default(autoincrement())
  userId        Int
  user          User      @relation(fields: [userId], references: [id])
  status        String    @default("pending") // pending | approved | denied
  grantedTokens Int?                            // filled in by admin on approval
  note          String    @default("")          // optional reason from the org
  createdAt     DateTime  @default(now())
  resolvedAt    DateTime?

  @@index([userId])
  @@index([status])
}
```

**Remaining balance** = `monthlyTokenLimit + bonusTokens - tokensUsedThisPeriod`.

**Lazy monthly reset**: no cron job. Any quota read/write compares
`periodStart`'s year+month to the current date; on a mismatch it resets
`tokensUsedThisPeriod = 0`, `bonusTokens = 0`, `periodStart = now()` as part
of that same read, before applying the read/write the caller actually asked
for.

**Duplicate-request guard**: an org with an existing `pending`
`TokenTopUpRequest` cannot create another one (checked at the API layer, not
the schema) — surfaced in the UI as "요청 대기중" instead of a request button.

## 2. Quota enforcement (Python backend)

New module `db_users.py` (same raw-SQL pattern as `db_glossary.py` /
`db_translations.py` — the Python side talks to Postgres directly, not
through Prisma):

- `get_quota(user_id)` — reads the row, applies the lazy reset if the period
  rolled over (persisting the reset), returns
  `{limit, used, bonus, remaining}`.
- `record_usage(user_id, input_tokens, output_tokens)` — adds
  `input_tokens + output_tokens` to `tokensUsedThisPeriod`. Re-applies the
  lazy-reset check first (a request spanning a month boundary should not
  silently add usage to a stale period).

New exception `QuotaExceededError(quota)` in `web_pipeline.py`.

**Check point**: `analyze_text(text, user_id)` and
`translate_text(text, user_id)` — both currently exist, but `analyze_text`
doesn't take `user_id` yet and needs it added. At the top of each, call
`db_users.get_quota(user_id)`; if `remaining <= 0`, raise
`QuotaExceededError`. The Next.js route (`app/api/analyze`,
`app/api/translate`) catches it and responds `403` with the quota payload;
the frontend uses that to show the blocked state.

**Record point**: both functions already build `generate_fns` — thread a
`usage_tracker` dict through both (today only `translate_text` does this;
`analyze_text` currently drops term_extraction's usage on the floor). After
the pipeline logic completes, call `db_users.record_usage(user_id, ...)`
once with the accumulated totals. `translate_text`'s tracker already covers
both `translation` and any `repair` retries automatically — `usage_tracker`
is shared across every task `build_generate_fns` returns, so no separate
accounting is needed for repair.

**Overage on the boundary call**: the check happens *before* the call, using
the balance as of the start of the request. The call that crosses zero is
allowed to complete (its actual cost isn't known until the response comes
back) — the *next* call is what gets blocked. This is the standard
usage-based-billing pattern and needs no special-casing.

## 3. Admin UI

Extend the existing `app/(protected)/admin` page (today: user management)
with:

- **Quota table** — one row per org: username, used / limit this period,
  bonus, remaining. `monthlyTokenLimit` is inline-editable.
- **Top-up requests** — pending `TokenTopUpRequest` rows (org, requested at,
  note) with an amount input + Approve (sets `status="approved"`,
  `grantedTokens`, `resolvedAt`, adds the amount to that org's
  `bonusTokens`) or Deny (`status="denied"`, `resolvedAt`, no balance
  change) action.

New routes:
- `app/api/admin/quota` — `GET` list, `PATCH` update a org's
  `monthlyTokenLimit`.
- `app/api/admin/topups` — `GET` pending requests, `POST {id, action,
  grantedTokens?}` to resolve one.

## 4. Org-facing UI

- Translate page shows remaining balance (e.g. "1,240 / 100,000 남음") via
  `GET /api/quota`, scoped to the session user.
- A `403` from `/api/analyze` or `/api/translate` renders a blocked state
  inline: "한도 초과 — 충전 요청하기" with an optional note field, posting to
  `POST /api/quota/topup-request`.
- If a pending request already exists for this org, the button is replaced
  with "요청 대기중" (checked via the same `GET /api/quota` response, which
  includes `pendingRequest: boolean`).

## Testing

- `db_users.py`: unit tests for the lazy-reset boundary (period rollover
  mid-check), `record_usage` accumulation, remaining-balance arithmetic
  (mirrors the existing `test_translation_system.py` style — pure functions
  over a fake connection, no live DB).
- `web_pipeline.py`: extend `test_web_pipeline.py` with a case where
  `get_quota` returns `remaining <= 0` and asserts `QuotaExceededError` is
  raised before any `generate_fn` is invoked (mock should assert zero calls).
- Manual: exercise the admin approve/deny flow and the blocked-state ->
  request -> approve -> unblocked round trip once against a dev DB.
