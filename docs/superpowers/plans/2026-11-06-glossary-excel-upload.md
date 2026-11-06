# Glossary Excel Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users download a glossary template `.xlsx`, upload a filled one, preview it, and either apply it directly (reviewers) or send it to a reviewer suggestion box (regular users). Also route translate-flow suggestions into that box so they stop overwriting approved terms.

**Architecture:** All decision logic is pure TypeScript in `lib/glossary-import.ts`: classify rows, find surface-form collisions, and turn reviewer decisions into an apply plan. `lib/glossary-excel.ts` wraps `exceljs` (template build, upload read). Next.js API routes run plans inside Prisma transactions. A new `GlossarySuggestion` table holds regular-user and translate-flow suggestions. The Python pipeline only learns to treat terms with a pending suggestion as "not missing".

**Tech Stack:** Next.js 15 App Router API routes + Prisma 7 (Postgres), `exceljs@4.4.0` (new dependency), `node --test` for `lib/*.test.ts`, the existing `next dev` integration test, and Python `unittest` + psycopg for the pipeline.

**Spec:** `docs/superpowers/specs/2026-11-06-glossary-excel-upload-design.md`

## Global Constraints

- `.xlsx` only. Reject files over 2 MB or with more than 2,000 data rows.
- Template headers, exact text: `한국어 용어`, `영어 번역`, `분류`, `다른 표기`, `사용 메모`. Sheet names: `용어집`, `작성 방법`.
- Type labels ↔ values: 일반=General, 기구=Organization, 규정=Regulation, 직책=Role/Position, 선거=Election, 재정=Finance, 회의·절차=Meeting/Procedure, 학사=Academic. Blank → General. English values are accepted too.
- Aliases separate on `,` or `|`, the same as `glossary_manager.split_aliases`. When writing, join with `, `.
- Every collision defaults to 기존 유지 (`"keep"`). The server re-reads the file and recomputes collisions on apply; it never trusts a preview sent back by the client.
- "바꾸기" always sets `english`. It sets `type`/`aliases`/`usageNote` only when non-blank, and never touches `description`/`category`/`lastContext`. Result `status="approved"`, `source` = the row's source (`"excel"` or `"translation_flow"`).
- Regular users never write `Glossary`. Permission checks happen on the server: `canEditGlossary()` for reviewers, any session user for upload, preview and suggest.
- New UI copy is Korean.
- Modules covered by `node --test` (`lib/glossary-import.ts`, `lib/glossary-excel.ts`) must have **no runtime imports of sibling `lib/` files**: Node can't resolve the extensionless imports Next uses. `import type` is fine, and so are package imports. Tests import them with a `.ts` suffix, like `lib/quota.test.ts`.
- Follow existing patterns: route files start with `export const runtime = "nodejs"` and `export const dynamic = "force-dynamic"`, like `app/api/glossary/approve/route.ts`. Raw SQL in `db_glossary.py`.

## Review Focus

1. **An existing glossary that already has surface conflicts** (legacy data). Upload must not fail because of conflicts it didn't create. The final check only looks at surfaces this upload touched. Test in Task 3.
2. **Excel cells that aren't plain strings** (numbers, rich text, hyperlinks, formulas, cells with surrounding spaces). They should read as their displayed text, trimmed. Test in Task 4.
3. **Glossary changing between preview and apply.** A row that newly collides at apply time defaults to keep, and the approved term stays. Test in Task 5.
4. **A regular user re-uploading the same file, or suggesting the same term twice.** Their pending suggestion for that `korean` is updated, not duplicated. Tests in Tasks 5 and 6.
5. **Reviewer accepts a suggestion whose term was approved in the meantime by someone else.** The collision is computed at decision time and shown. Accepting with no decision keeps the existing term. Test in Task 6.

---

### Task 1: `GlossarySuggestion` model and migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_glossary_suggestion/migration.sql` (generated)

**Interfaces:**
- Produces: Prisma model `glossarySuggestion` with fields `id, korean, english, type, aliases, usageNote, lastContext, source, status ("pending"|"accepted"|"rejected"), userId, reviewedById Int?, reviewedAt DateTime?, createdAt`. Also `User.glossarySuggestions GlossarySuggestion[]`.

- [ ] **Step 1:** Add the model exactly as in spec §2, plus the back-relation `glossarySuggestions GlossarySuggestion[]` on `User`. Leave out a relation for `reviewedById`: it is a plain `Int?`.
- [ ] **Step 2:** Run `npx prisma migrate dev --name add_glossary_suggestion`. Expected: the migration is created and applied, and the client regenerates.
- [ ] **Step 3:** Run `npm run build`. Expected: succeeds.
- [ ] **Step 4: Commit** `feat: add GlossarySuggestion model`

---

### Task 2: Row classification (`lib/glossary-import.ts`, part 1)

**Files:**
- Create: `lib/glossary-import.ts`
- Test: `lib/glossary-import.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const GLOSSARY_TYPES: readonly { value: string; label: string }[]; // 8 entries, order as in Global Constraints
  export const TEMPLATE_EXAMPLES: readonly UploadRow[]; // 3 rows, see Step 3
  export function normalizeType(input: string): string | null; // label or value -> value; "" -> "General"; unknown -> null
  export function splitAliases(s: string): string[];           // split on , or |, trim, drop empty
  export type UploadRow = { rowNumber: number; korean: string; english: string; type: string; aliases: string; usageNote: string };
  export type NormalizedRow = UploadRow;                        // type already normalized to a value
  export type ExistingTerm = { id: number; korean: string; english: string; type: string; aliases: string; usageNote: string; status: string };
  export type Collision = { termId: number; termKorean: string; surface: string; kind: "same_term" | "surface"; canReplace: boolean };
  export type ProblemReason = "missing_korean" | "missing_english" | "unknown_type" | "duplicate_in_file";
  export type UploadPreview = {
    newRows: NormalizedRow[];
    overlaps: { row: NormalizedRow; collisions: Collision[] }[];
    problems: { rowNumber: number; korean: string; reasons: ProblemReason[] }[];
  };
  export function findCollisions(row: NormalizedRow, existing: ExistingTerm[]): Collision[];
  export function classifyUpload(rows: UploadRow[], existing: ExistingTerm[]): UploadPreview;
  export function collisionKey(c: Collision): string; // `${c.termId}:${c.surface}`
  ```

Collision rules for `findCollisions`:
- An existing row with the same `korean` gives one `same_term` collision (`surface = korean`, `canReplace: true`). That row is then not checked for `surface` collisions.
- For every other existing row: each of the new row's surfaces (its `korean` and `splitAliases(aliases)`) that equals one of that row's surfaces gives one `surface` collision. `canReplace` is `surface !== existing.korean`: an existing term can give up an alias but never its own name.

`classifyUpload` skips blank rows (all five fields empty) and rows equal to a `TEMPLATE_EXAMPLES` entry (same `korean` and `english`). It then marks problems, and only after that classifies the remaining rows into new rows and overlaps. `duplicate_in_file` flags **every** row that shares any surface with another non-skipped row in the file.

- [ ] **Step 1: Write the failing tests** in `lib/glossary-import.test.ts`:
  - `normalizeType("기구") === "Organization"`, `normalizeType("Organization") === "Organization"`, `normalizeType("") === "General"`, `normalizeType("없는분류") === null`.
  - `splitAliases("총학, 학생회|  ") ` deep-equals `["총학", "학생회"]`.
  - existing `{id:1, korean:"총학생회", aliases:"총학"}`, row `총학생회` → one collision `{kind:"same_term", termId:1, surface:"총학생회", canReplace:true}`.
  - existing `{id:2, korean:"학생회", aliases:""}`, row `총학생회` with alias `학생회` → `{kind:"surface", termId:2, surface:"학생회", canReplace:false}`.
  - existing `{id:3, korean:"중앙운영위원회", aliases:"중운위"}`, row `중운위` → `{kind:"surface", termId:3, surface:"중운위", canReplace:true}`.
  - `classifyUpload`: rows `[ok new, missing english, unknown type "없는분류", two rows sharing alias "총학", one TEMPLATE_EXAMPLES row, one blank row]` → `newRows.length === 1`. `problems` reasons are `missing_english`, `unknown_type`, and `duplicate_in_file` for **both** sharing rows. The example and blank rows appear nowhere.
- [ ] **Step 2:** Run `npm run test`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement. `TEMPLATE_EXAMPLES` (rowNumber 0):
  `총학생회 / Undergraduate Student Council / 기구 / 총학 / 공식 기구명으로만 사용`,
  `회칙 / Constitution / 규정 / "" / ""`,
  `회장 / President / 직책 / "" / ""`.
- [ ] **Step 4:** Run `npm run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: classify glossary upload rows and find surface collisions`

---

### Task 3: Decisions to an apply plan (`lib/glossary-import.ts`, part 2)

**Files:**
- Modify: `lib/glossary-import.ts`
- Test: `lib/glossary-import.test.ts`

**Interfaces:**
- Consumes: Task 2 types.
- Produces:
  ```ts
  export type Decision = "keep" | "replace";
  export type ApplyPlan =
    | { kind: "skip" }
    | {
        kind: "create" | "update";
        existingId?: number;            // set for "update"
        korean: string;
        data: { english: string; type?: string; aliases?: string; usageNote?: string; status: "approved"; source: string };
        aliasRemovals: { termId: number; surface: string }[];
      };
  export function planApply(row: NormalizedRow, collisions: Collision[], decisions: Record<string, Decision>, source: string): ApplyPlan;
  export function findSurfaceConflicts(terms: { korean: string; aliases: string }[], onlySurfaces: Set<string>): string[];
  ```

Rules for `planApply`. A missing decision, or `"replace"` on a collision with `canReplace: false`, counts as `"keep"`.
- A `same_term` collision with keep → `skip`. With replace → `update` with `existingId`.
- A `surface` collision where the surface is the row's own `korean`: keep → `skip`, replace → add an `aliasRemovals` entry.
- A `surface` collision on one of the row's aliases: keep → drop that alias from the row, replace → add an `aliasRemovals` entry.
- No collisions → `create`.
- `data.type`/`aliases`/`usageNote` are included only when non-blank, after dropping kept aliases. For `create`, missing ones fall back to the Prisma defaults.

`findSurfaceConflicts` returns the surfaces in `onlySurfaces` that belong to more than one term.

- [ ] **Step 1: Write the failing tests:**
  - `same_term` + `{}` decisions → `{kind:"skip"}`.
  - `same_term` + replace, row with blank `aliases`/`usageNote` and type `General` → `update`. `data` has `english`, `type:"General"` and no `aliases`/`usageNote` keys.
  - Alias collision `학생회` with `canReplace:false` + `"replace"` → `create` with `학생회` dropped from `data.aliases` and no `aliasRemovals`.
  - Own-korean collision `중운위` (canReplace) + replace → `create` with `aliasRemovals` deep-equal to `[{termId:3, surface:"중운위"}]`. Keep → `skip`.
  - `findSurfaceConflicts([{korean:"A",aliases:"B"},{korean:"B",aliases:""},{korean:"C",aliases:"D"},{korean:"D",aliases:""}], new Set(["B"]))` deep-equals `["B"]` (the pre-existing `D` conflict is ignored — Review Focus 1).
- [ ] **Step 2:** Run `npm run test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: turn reviewer decisions into glossary apply plans`

---

### Task 4: Excel template and reader (`lib/glossary-excel.ts`)

**Files:**
- Modify: `package.json`, `package-lock.json` (`npm install exceljs@4.4.0`)
- Create: `lib/glossary-excel.ts`
- Test: `lib/glossary-excel.test.ts`

**Interfaces:**
- Consumes: only `import type { UploadRow } from "./glossary-import"`. Types and examples are passed in as arguments (Global Constraints).
- Produces:
  ```ts
  export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
  export const MAX_DATA_ROWS = 2000;
  export class UploadFormatError extends Error { code: "unreadable" | "no_sheet" | "missing_header" | "too_many_rows" | "too_large" }
  export function buildTemplate(typeLabels: string[], examples: Omit<UploadRow, "rowNumber">[]): Promise<Buffer>;
  export function readUploadRows(buf: Buffer): Promise<UploadRow[]>;
  ```

Template sheet `용어집`:
- Row 1: the five headers, bold.
- Row 2: `필수, 필수, 선택, 선택, 선택`.
- Rows 3–5: the examples, with the 분류 column showing the Korean label.
- 분류 column `C3:C2002`: list validation over `typeLabels`.
- Column widths: about 20 / 32 / 12 / 20 / 32.

Sheet `작성 방법` holds these lines in column A, one per row:
```
1행의 제목은 바꾸지 마세요. 2행(필수/선택)과 예시 3줄은 올릴 때 자동으로 무시됩니다.
한국어 용어, 영어 번역은 반드시 채워야 합니다.
분류는 목록에서 고르세요. 비워 두면 '일반'으로 등록됩니다.
다른 표기는 같은 뜻의 다른 한국어 표현이며 쉼표(,)로 여러 개 적을 수 있습니다.
이미 등록된 용어와 겹치는 행은 검수자가 확인한 뒤에만 반영됩니다.
```

How `readUploadRows` reads a file:
- It finds columns by header text in row 1, in any order. A missing `한국어 용어` or `영어 번역` header → `missing_header`.
- It skips row 2 when its 한국어 용어 cell is `필수`.
- It reads every cell with `cell.text.trim()`.
- If load fails → `unreadable`. No `용어집` sheet → `no_sheet`. More than `MAX_DATA_ROWS` non-empty rows → `too_many_rows`.
- `rowNumber` is the Excel row number.

- [ ] **Step 1: Write the failing tests:**
  - `readUploadRows(await buildTemplate(labels, examples))` returns exactly the 3 example rows, with `type` as the Korean label.
  - A workbook built in the test with exceljs: headers reordered, a numeric 한국어 용어 cell `2026`, a rich-text 영어 번역 cell, a cell `"  회의  "`. It reads as strings `"2026"`, the plain text and `"회의"` (Review Focus 2).
  - `readUploadRows(Buffer.from("not a zip"))` rejects with `code === "unreadable"`.
  - A workbook without a `용어집` sheet → `no_sheet`. Without the `영어 번역` header → `missing_header`.
- [ ] **Step 2:** Run `npm run test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: build glossary Excel template and read uploads`

---

### Task 5: Template, preview and apply routes

**Files:**
- Create: `app/api/glossary/template/route.ts`, `app/api/glossary/import/preview/route.ts`, `app/api/glossary/import/apply/route.ts`, `lib/glossary-import-server.ts`
- Modify: `test/glossary-flow.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - `GET /api/glossary/template` (any session user) → the `.xlsx` with `Content-Disposition: attachment; filename="glossary_template.xlsx"`.
  - `POST /api/glossary/import/preview`, multipart field `file` → `{ ok: true, preview: UploadPreview, canApply: boolean }`. `canApply` = `canEditGlossary(user)`.
  - `POST /api/glossary/import/apply`, multipart `file` and `decisions` (a JSON string `Record<string, Decision>`):
    - reviewer → `{ ok: true, mode: "applied", counts: { added, replaced, kept, excluded } }`;
    - user → `{ ok: true, mode: "suggested", counts: { suggested, excluded } }`.
  - Errors: 400 `{ ok: false, error: <UploadFormatError code> }`, 401 `unauthorized`.
  - `lib/glossary-import-server.ts`: `loadExistingTerms(tx?): Promise<ExistingTerm[]>`, `readUploadFromForm(form: FormData): Promise<UploadRow[]>` (checks `MAX_UPLOAD_BYTES`, throws `UploadFormatError("too_large")`), and `upsertPendingSuggestion(tx, userId, row, source, lastContext?)`. The last one updates this user's `pending` suggestion with the same `korean`, or creates one. Task 6 reuses all three.

How the reviewer apply runs, all in one `prisma.$transaction`:
1. Load the existing terms.
2. Run `classifyUpload`.
3. Run `planApply` for each new or overlap row (`source: "excel"`).
4. Apply `aliasRemovals` (rewrite that term's `aliases` without the surface), then the creates and updates.
5. Reload the terms and call `findSurfaceConflicts` with the surfaces this upload touched.
6. If that returns anything, throw so the transaction rolls back, and return 409 `{ ok:false, error:"surface_conflict", surfaces }`.

Counts: `added` = creates, `replaced` = updates, `kept` = skips, `excluded` = `problems.length`.

The user apply saves each new and overlap row via `upsertPendingSuggestion(..., "excel")`.

- [ ] **Step 1: Write the failing integration tests.** Build the upload files with exceljs in the test, and prefix every term with `__itest_`. Also delete `GlossarySuggestion` rows for test users in `after`.
  - Template: a `user` GET returns 200, and `readUploadRows` on the body returns the 3 examples. Anonymous → 401.
  - Preview: an editor uploads a file with 1 new term, 1 term equal to an existing approved term, and 1 missing-english row. The response shows one row in each bucket, and nothing has been written.
  - Reviewer apply with `{}` decisions: the new term is created as `approved` with `source "excel"`, the existing approved term is unchanged, and `counts` deep-equals `{added:1, replaced:0, kept:1, excluded:1}`.
  - Reviewer apply with `replace` on the same-term collision: `english` is updated, and the existing `aliases` stays when the file's 다른 표기 is blank.
  - Review Focus 3: preview shows term X as new. A different term X is then inserted directly in the DB. Apply with `{}` → X is kept unchanged and counted as `kept`.
  - User apply: no `Glossary` rows change, and 2 `pending` suggestions exist. Uploading the same file again still leaves 2 (Review Focus 4).
  - A user posting with `decisions` containing replace still only creates suggestions.
- [ ] **Step 2:** Run `npm run test:integration`. Expected: FAIL (404s).
- [ ] **Step 3:** Implement the three routes and `lib/glossary-import-server.ts`.
- [ ] **Step 4:** Run `npm run test:integration` and `npm run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: glossary Excel template, preview and apply routes`

---

### Task 6: Suggestion box routes and the translate-flow fix

**Files:**
- Modify: `app/api/glossary/suggest/route.ts`, `lib/glossary.ts`, `lib/glossary.test.ts`, `test/glossary-flow.integration.test.ts`
- Create: `app/api/glossary/suggestions/route.ts`, `app/api/glossary/suggestions/[id]/route.ts`

**Interfaces:**
- Consumes: Tasks 2, 3 and 5 (`findCollisions`, `planApply`, `upsertPendingSuggestion`, `loadExistingTerms`).
- Produces:
  - `POST /api/glossary/suggest` (any session user, same body as today) → `{ ok: true, suggestion }`. It calls `upsertPendingSuggestion(..., "translation_flow", body.lastContext)` and never writes `Glossary`.
  - `GET /api/glossary/suggestions` (reviewer) → `{ ok: true, suggestions: { id, korean, english, type, aliases, usageNote, source, createdAt, username, collisions: Collision[], existing: ExistingTerm[] }[] }`. These are `pending` only, oldest first. `existing` holds the terms named in `collisions`.
  - `POST /api/glossary/suggestions/[id]` (reviewer), body `{ action: "accept" | "reject", decisions?: Record<string, Decision> }` → `{ ok: true, result: "accepted" | "rejected" }`. Accept recomputes collisions, then runs `planApply(..., suggestion.source)` with the same transaction, alias-removal and conflict-check steps as Task 5. If the plan is `skip`, the suggestion is marked `rejected` (spec §5 "기존 유지"). It sets `reviewedById`/`reviewedAt`. A suggestion that isn't pending → 409.
- Remove the now-unused `overrides` path from `buildGlossaryUpsertData` only if nothing else uses it. Update `lib/glossary.test.ts` to match.

- [ ] **Step 1: Write the failing integration tests:**
  - Rewrite the existing "suggest: 'user' role … pending_reference" test so that it now expects a `pending` `GlossarySuggestion` with `source "translation_flow"` and no `Glossary` row.
  - Regression: an approved term `__itest_X` exists, and a user suggests `__itest_X` with a different english. The `Glossary` row is byte-identical before and after.
  - Suggesting the same term twice as the same user → 1 pending suggestion with the latest english. Two different users → 2.
  - A `user` GETting `/api/glossary/suggestions` → 401.
  - Accept a new-term suggestion → an approved `Glossary` row with `source "translation_flow"`, and the suggestion `accepted` with `reviewedById` set.
  - Review Focus 5: a suggestion for X is made, then X is approved directly. GET shows a `same_term` collision. Accepting with no decisions keeps the existing X, and the result is `rejected`.
  - Accept with `replace` on `same_term` → `english` is updated.
- [ ] **Step 2:** Run `npm run test:integration`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run test:integration` and `npm run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: glossary suggestion box; translate-flow suggestions no longer overwrite terms`

---

### Task 7: Python — don't ask again for a term that has a pending suggestion

**Files:**
- Modify: `db_glossary.py`, `web_pipeline.py`, `test_web_pipeline.py`

**Interfaces:**
- Produces:
  - `db_glossary.fetch_pending_suggestion_koreans() -> set[str]`. It runs `SELECT DISTINCT korean FROM "GlossarySuggestion" WHERE status = 'pending'`.
  - `web_pipeline._detect_missing_terms(candidate_terms, glossary, pending_koreans=frozenset())`. A candidate whose `ko_term` is in `pending_koreans` is not missing. `analyze_text` passes in the fetched set.

- [ ] **Step 1: Write the failing test** `test_pending_suggestion_is_not_missing` in `AnalyzeTextTests`. Patch `fetch_pending_suggestion_koreans` to return `{"신조어"}`. With the same input as `test_detects_missing_high_priority_term`, assert that `missing_terms == []`. Add a `setUp` to `AnalyzeTextTests` that patches `web_pipeline.db_glossary.fetch_pending_suggestion_koreans` to return `set()`, so the existing tests never hit a DB.
- [ ] **Step 2:** Run `.venv/bin/python -m unittest test_web_pipeline -v`. Expected: the new test FAILs.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `.venv/bin/python -m unittest test_translation_system test_evaluation test_web_pipeline test_api_handlers`. Expected: all OK.
- [ ] **Step 5: Commit** `feat: skip re-asking terms that already have a pending suggestion`

---

### Task 8: UI — upload panel, suggestion box, copy updates

**Files:**
- Create: `components/GlossaryUpload.tsx`, `components/SuggestionBox.tsx`
- Modify: `components/GlossaryClient.tsx`, `lib/api.ts`, `lib/types.ts`, `app/(protected)/translate/page.tsx`, `README.md`

**Interfaces:**
- Consumes: the Task 5 and 6 routes. `GLOSSARY_TYPES` replaces the local `TYPES` array in `GlossaryClient.tsx`.
- Produces in `lib/api.ts`: `previewGlossaryUpload(file: File)`, `applyGlossaryUpload(file: File, decisions: Record<string, Decision>)`, `listSuggestions()` and `decideSuggestion(id, action, decisions?)`. The multipart ones must **not** set `Content-Type` themselves: the existing `request()` forces JSON, so give it a way to skip the header, or use `fetch` with the same error handling. `suggestTerm`'s return type becomes `{ ok: true; suggestion: ... }`.

Behavior (spec §3–5):
- **GlossaryUpload** (all users), titled `엑셀로 올리기`:
  - A `템플릿 받기` link to `/api/glossary/template`, a file input with `accept=".xlsx"`, and a `미리보기` button.
  - The preview shows `새 용어 N`, `겹치는 용어 N` and `문제 있는 행 N`. Problem rows show Korean reasons: 한국어 용어 없음 / 영어 번역 없음 / 알 수 없는 분류 / 파일 안에서 중복.
  - For each overlap row: existing vs file values for every field that would change. Each collision gets its own `기존 유지`/`엑셀로 바꾸기` radio pair, with 바꾸기 disabled when `!canReplace`. There are also `모두 유지` and `모두 바꾸기` buttons.
  - Reviewers then get a `반영하기` button, and users get `제안 보내기` and no radio buttons. Show the result counts and reload the term list.
  - Map error codes to Korean messages: unreadable → `엑셀 파일을 읽을 수 없습니다`, no_sheet → `'용어집' 시트가 없습니다`, missing_header → `필수 제목(한국어 용어, 영어 번역)이 없습니다`, too_many_rows → `한 번에 2,000행까지 올릴 수 있습니다`, too_large → `파일은 2MB까지 올릴 수 있습니다`, surface_conflict → `다른 사람이 방금 용어집을 바꿨습니다. 다시 미리보기 해주세요`.
- **SuggestionBox** (only when `canEdit`), titled `제안함 (N)`:
  - Each row shows the suggester, the date, and the source label (`엑셀` / `번역 중 제안`).
  - New term → `승인`/`거절`. Overlapping → the side-by-side view and per-collision radios as above (`제안으로 바꾸기`), then `반영`/`거절`.
- **Translate page hint**: replace the `pending_reference` sentence with `저장된 용어는 검수자의 제안함으로 보내지며, 검수자가 승인하면 용어집에 반영됩니다.`
- **README**: add the upload flow and the suggestion box to the glossary section. Note that translate-flow suggestions no longer create `Glossary` rows.

- [ ] **Step 1:** Implement the components and API helpers.
- [ ] **Step 2:** Run `npm run lint && npm run build`. Expected: both succeed.
- [ ] **Step 3: Manual check** with `npm run dev`:
  - As an editor: download the template, fill 2 new terms and 1 existing term, preview, choose 바꾸기 for the existing one, apply, and see it in the table.
  - As a user: upload the same file and see `제안 보내기`.
  - As an editor: see the suggestions in 제안함, accept one, and reject one.
  - As a user on the translate page: save a missing term, then run analyze again with the same text. The term isn't asked again.
- [ ] **Step 4: Commit** `feat: glossary Excel upload and suggestion box UI`
- [ ] **Step 5:** Run `graphify update .`.
