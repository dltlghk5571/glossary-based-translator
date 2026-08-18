# KAIST_UA Translator

LangGraph Human-in-the-Loop Glossary Translation System

## Overview

A Korean → English translation pipeline for student-society (학생사회) documents that keeps
institutional terminology consistent by controlling it through a glossary, instead of letting
the LLM decide fixed translations on its own.

Core features:
- Glossary-driven Korean → English translation
- Automatic detection of student-society terms that likely need a fixed translation
- User confirmation for any high-priority term missing from the glossary
- User-provided translations are automatically appended to the glossary
- Placeholder-based protection of glossary terms during translation
- Post-translation glossary compliance audit
- Bounded repair loop (max 2 attempts) when the audit finds violations
- Legacy translator still available via `--legacy`

## Setup

Python 3.12 is recommended. The system Python on this machine was 3.14, where `pydantic`/
`langchain-core` (a `langgraph` dependency) fail to import — a real upstream incompatibility
with that Python version, not something fixable in this project. Use a Python 3.12 virtual
environment instead:

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## API key

This project supports three LLM providers — Anthropic, Google (Gemini), and OpenAI — each read
only from the environment; there is no hardcoded key in the source. See `.env.example` for the
expected variable names.

```bash
export ANTHROPIC_API_KEY="your_anthropic_api_key_here"
export GOOGLE_API_KEY="your_google_api_key_here"      # only needed for --legacy or google-provider steps
export OPENAI_API_KEY="your_openai_api_key_here"       # only needed for openai-provider steps
```

**Provider selection.** The pipeline has three LLM-backed steps — term extraction, translation,
and glossary repair (`llm_providers.py`) — and each defaults to **Anthropic (`claude-sonnet-5`)**:
it gives reliable structured JSON for term extraction and strict instruction adherence for
translation/repair (glossary terms and `__TERM_NNN__` placeholders must come back byte-for-byte
unchanged, never paraphrased), at roughly 40% of Opus-tier cost — plenty of quality headroom for
this task. A key is only required for the provider actually selected for each step — the CLI
exits with a clear error naming the missing variable if you select a provider whose key isn't
set. Override the model within a provider via `ANTHROPIC_MODEL` / `OPENAI_MODEL` / `GOOGLE_MODEL`
(e.g. `ANTHROPIC_MODEL=claude-opus-4-8` for maximum quality, or `claude-haiku-4-5` for lowest cost).

Override any step independently:

```bash
export TRANSLATION_PROVIDER=openai      # anthropic (default) | openai | google
export TERM_EXTRACTION_PROVIDER=google
export REPAIR_PROVIDER=anthropic
```

`--legacy` mode is unaffected by all of this — it always uses `GOOGLE_API_KEY` directly (the
original Gemini-only pipeline).

## Usage

Basic run:

```bash
python translator.py --input input.txt --output output.txt --glossary glossary.csv --interactive
```

Dry run (only extract candidate/missing terms, no translation, no LLM call needed for the
translation step):

```bash
python translator.py --input input.txt --glossary glossary.csv --dry-run
```

Non-interactive (never prompt; warnings are logged instead):

```bash
python translator.py --input input.txt --output output.txt --glossary glossary.csv --no-interactive
```

Save missing-term review list and audit report:

```bash
python translator.py --input input.txt --output output.txt --glossary glossary.csv \
  --interactive --review-missing missing_terms.json --save-audit audit_report.json
```

Legacy mode (original simple glossary-substring pipeline):

```bash
python translator.py --legacy
```

## Graph visualization

```bash
python -c "from translation_graph import build_graph; print(build_graph().compile().get_graph().draw_mermaid())"
python -c "from translation_graph import save_graph_png; save_graph_png()"
```

`translation_graph.png` is a generated artifact and is not committed.

## Glossary schema

`glossary.csv` columns:

- `ko_term` — the Korean term
- `en_term` — the approved English translation
- `type` — Organization / Regulation / Role-Position / Election / Finance /
  Meeting-Procedure / Academic / General
- `aliases` — comma-separated alternate Korean surface forms (e.g. abbreviations)
- `usage_note` — auto-generated guidance on how to use the translation
- `status` — only `approved` rows are ever force-matched/required during translation and
  evaluation (`glossary_manager.match_terms`). `deprecated` marks a row that should no longer be
  used (e.g. a legacy import that was fragment-misaligned and forces a wrong translation) without
  deleting its history. `pending_reference` marks a translation inferred from repeated
  correspondence in human-translated reference captions, not yet officially approved — it's
  tracked for review but not forced into output.
- `source` — `imported` (from legacy migration), `user` (typed in during a translation run), or
  `reference_inferred` (inferred from `eval_data` reference captions, see below).
- `last_context` — the sentence the term was first seen in, for reference

A legacy `Korean,English` glossary is migrated to this schema automatically on load; a
`.csv.bak` backup of the original file is written first, and no rows are dropped.

## Evaluation

`eval_data/cases/NNN/{input.txt, reference.txt, metadata.json}` holds human-translated
Instagram-caption test cases built from the raw `sample_instagram_korean/english` folders (see
`build_eval_data.py`). Cases are split into `optimization` (used to drive improvements) and
`holdout` (used only for final, one-shot validation — never viewed or tuned against directly).

Run the pipeline over the cases and score the output with rule-based (no-API-key-needed)
metrics — glossary compliance, reference-term overlap, date/time/number/URL/mention/hashtag
preservation, and automatic failure-category classification:

```bash
python evaluate.py --cases eval_data/cases --glossary glossary.csv --out eval_data/results \
  --no-interactive --split optimization --summary eval_data/eval_summary.json
```

Each case writes `eval_data/results/NNN/{prediction.txt, audit_report.json, missing_terms.json,
eval_report.json}`; `eval_data/eval_summary.json`/`.md` aggregate across all evaluated cases.
Actually calling the LLM still needs an API key; only the *scoring* layer (`eval_metrics.py`,
`eval_common.py`) is API-key-free.

## Tests

```bash
python -m unittest test_translation_system test_evaluation test_web_pipeline test_api_handlers -v
npm run lint
npm run build
npm run test              # lib/*.test.ts -- pure-logic unit tests, no DB/server needed
npm run test:integration  # see below -- needs TEST_DATABASE_URL
```

**`npm run test:integration`** (`test/glossary-flow.integration.test.ts`) is an E2E-style
integration test: it spawns a real `next dev` server and drives it over real HTTP with forged
session cookies, exercising the actual `/api/glossary/approve` and `/api/glossary/suggest` route
handlers and a real Postgres.

- **Never run it against a production or shared dev database.** It requires `TEST_DATABASE_URL`
  in the environment and refuses to run without it (fails fast with a clear error rather than
  silently falling back to `DATABASE_URL`) -- the spawned server itself is launched with its
  `DATABASE_URL` overridden to `TEST_DATABASE_URL`, so the app under test can't reach the real DB
  either.
- Point `TEST_DATABASE_URL` at a dedicated test database -- e.g. a separate Neon branch --
  never at the same database `DATABASE_URL` points to. Apply migrations to it once before the
  first run: `DATABASE_URL_UNPOOLED=$TEST_DATABASE_URL npx prisma migrate deploy`.
- Test rows (users and glossary terms) are prefixed `__itest_` and deleted in an `after()` hook,
  but using a dedicated database is still required -- prefix-based cleanup is a safety net, not
  the isolation boundary.

## Backoffice web app (Vercel)

A Next.js backoffice (`/translate`, `/glossary`) sits alongside the CLI, split across two
persistence paths that share one Postgres (Neon) database and one schema source of truth
(Prisma migrations under `prisma/migrations/`):

- **Glossary CRUD** (`app/api/glossary/**`) is plain Next.js Route Handlers using Prisma
  Client (`lib/prisma.ts`) against the `Glossary` table. This replaced an earlier
  Python/psycopg version of these same endpoints.
- **Analyze/translate** (`api/index.py`, one Vercel Python Function routing `/api/analyze` and
  `/api/translate` by path) reuse the CLI's pipeline modules (`glossary_manager.py`,
  `term_extractor.py`, `audit.py`, `llm_providers.py`) through `web_pipeline.py`, which replaces
  the CLI's `interrupt()`-driven human-in-the-loop with explicit `analyze → approve → translate`
  steps. They read the same `Glossary` table read-only via raw SQL (`db_glossary.py`) instead of
  `glossary.csv`, since Vercel's filesystem is read-only at runtime and Prisma Client is
  TypeScript-only (no Python binding) -- so the Python side reads the Prisma-managed table
  directly rather than duplicating the schema.

  Both routes are merged into a single `api/index.py` file rather than separate
  `api/analyze.py`/`api/translate.py` files: Vercel's Python entrypoint detection only reliably
  recognizes one canonically-named file (`index.py`/`app.py`/`server.py`/`main.py`) per project --
  multiple non-canonical `api/*.py` files each defining their own `handler` hit an ambiguous
  "no python entrypoint found" build error in production. `api/index.py` dispatches on
  `self.path` internally instead.

The CLI (`translator.py`) is unaffected and keeps using `glossary.csv` directly.

**Accounts.** There's no shared password gate anymore -- real per-user accounts (`User` table:
username, scrypt-hashed password, `role` of `admin`/`user`). Admins manage accounts from `/admin`
(create/delete/reset password; a freshly issued password is shown exactly once). The session is
a `${userId}.${hmac}` cookie signed with `SESSION_SECRET` (`lib/auth.ts` on the Next.js side,
mirrored in `api/index.py` for the Python routes so both can verify it without sharing a session
store). Bootstrap the first admin account from `ADMIN_PASSWORD` with `npx tsx scripts/seed-admin.ts`
(idempotent, username `admin`) -- after that, `ADMIN_PASSWORD` isn't read again.

**Translation audit trail.** Every `/api/translate` call writes a `Translation` row: source/output
text, `warnings`, `matchedTerms` (glossary terms enforced in that run), `inputTokens`/`outputTokens`,
and the `userId` from the session cookie (`db_translations.py`). Token counts come from each
provider's usage field (`llm_providers.py`'s `call_anthropic`/`call_openai`/`call_google` now
return `(text, usage)`; `get_generate_fn`'s public `generate(prompt) -> str` signature is
unchanged, so the CLI and every other caller are unaffected -- only a caller that passes a
`usage_tracker` dict to `build_generate_fns()` sees token counts).

### Local dev

```bash
python3.12 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
npm install
npx prisma migrate deploy   # applies prisma/migrations/ to $DATABASE_URL (direct connection)
npm run dev                 # next dev -- UI, /login, /glossary (Prisma), everything except api/*.py
```

Use plain `next dev` (`npm run dev`) for day-to-day frontend/Glossary work — pages, the login
gate, and `/api/glossary/**` (Prisma) all run under it with no extra setup.

`vercel dev` is the only way to exercise `api/*.py` (`/api/analyze`, `/api/translate`) locally,
since those are separate Python serverless functions `next dev` doesn't serve. In practice this
CLI version's local Python+Next.js emulation has been unreliable in this repo (global 502s from
`vercel dev` unrelated to application code — confirmed by the same routes returning 200 under
plain `next dev`). If `vercel dev` 502s for you, don't chase it locally: verify
`/api/analyze` and `/api/translate` via the Python test suite (`test_api_handlers.py` exercises
the actual handler class over a real local HTTP connection, mocking only the LLM/DB calls) and
do the final end-to-end check on a Vercel Preview or Production deployment, where the build
pipeline differs from `vercel dev`'s local emulation.

### Deploy to Vercel

1. Import this GitHub repo in the Vercel dashboard (Framework Preset: Next.js — Python functions
   under `api/` are auto-detected from `requirements.txt`).
2. Set Environment Variables (Project Settings → Environment Variables):
   - `GOOGLE_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — at least the provider(s)
     selected via `TERM_EXTRACTION_PROVIDER` / `TRANSLATION_PROVIDER` / `REPAIR_PROVIDER`
     (default: Anthropic for all three).
   - `DATABASE_URL` — pooled Postgres connection string (app runtime / Prisma Client / Python).
   - `DATABASE_URL_UNPOOLED` — direct (non-pooled) connection string, used by `prisma.config.ts`
     for the Prisma CLI (`migrate`/`validate`/`studio`) since DDL is unreliable through a
     transaction-mode pooler.
   - `SESSION_SECRET` — signs the login session cookie; required in every environment (Python
     and Node both reject requests if it's unset -- there's no "gate disabled" fallback once
     real accounts are involved). Generate with `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`.
   - `ADMIN_PASSWORD` — only used once, by `scripts/seed-admin.ts`, to create the bootstrap
     `admin` account. Not read at request time.

   The login gate (`app/(protected)/layout.tsx`) runs as a Node.js Server Component, not
   `middleware.ts` -- Vercel's edge runtime has a platform-level `ReferenceError: __dirname is
   not defined` bug that broke every `middleware.ts` on this project regardless of its content
   (reproduced with an empty one importing nothing but `next/server`), so the gate lives in a
   layout instead.
3. Build command: `next build` (default). `npm install`'s `postinstall` script runs
   `prisma generate` automatically, so the generated client (`lib/generated/prisma/`, gitignored)
   is always rebuilt from the current schema on each deploy. Local dev command: `vercel dev`.
   Deploy: `vercel --prod` or push to the connected branch.
4. Run `npx prisma migrate deploy` against the production `DATABASE_URL_UNPOOLED` once before
   first use, and again after any schema change, then `npx tsx scripts/seed-admin.ts` once to
   create the first admin account.

## Notes

- `.venv` is not committed.
- `output.txt`, `audit_report.json`, `missing_terms.json` are generated files and are not
  committed.
- `glossary.csv` schema may change after migration from a legacy `Korean,English` file.
- `glossary.csv.bak` is a local backup and is not committed.
- `eval_data/results/`, `eval_data/eval_summary*.json`, `eval_data/eval_summary*.md` are
  regenerated by `evaluate.py` and are not committed.
