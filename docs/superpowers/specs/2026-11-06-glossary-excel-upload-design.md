# Glossary Excel Upload — Design

## Purpose

A new organization starting to use the translator wants to bring its own
terms in bulk instead of adding them one at a time on the glossary page. They
download a template Excel file, fill it in, and upload it.

The glossary is a single shared table used by every account
(`Glossary.korean` is globally unique), so who uploads decides what happens:

- **Reviewers** (`admin` / `editor`, i.e. `canEditGlossary()`) are trusted: what
  they upload is already reviewed and is applied directly after a preview.
- **Regular users** (`user`) never change the glossary directly. Their uploads
  become suggestions that a reviewer accepts or rejects later.

Whenever an uploaded term already exists in the glossary, a reviewer — not
the system — decides whether the existing entry or the new one wins.

## Goals

1. A downloadable template `.xlsx` that is easy to fill in, with required and
   optional columns clearly marked.
2. Upload + preview for everyone: rows are validated and classified before
   anything is saved.
3. Reviewer upload: per-row keep/replace choice for conflicts, then apply.
4. Regular-user upload: rows land in a new suggestion box, not the glossary.
5. A reviewer screen for the suggestion box, with keep / replace / reject for
   suggestions that collide with an existing term.
6. Fix the existing translate-flow suggestion bug (below) by routing those
   suggestions into the same suggestion box.

## Non-goals

- No import of CSV or other formats — `.xlsx` only.
- No per-organization glossaries — the shared single glossary stays.
- No editing of uploaded rows inside the preview; fix the file and re-upload.
- No change to how the Python pipeline translates. It only force-matches
  `status="approved"` rows (`glossary_manager.match_terms`), so suggestions
  living outside the `Glossary` table cannot affect translation output. The
  one Python change is in missing-term detection (§6).

## Anti-goals (would be a failure even if it "works")

- An approved term silently changing or disappearing because someone uploaded
  a file. Conflicts must always be an explicit reviewer choice, defaulting to
  keeping the existing entry.
- A regular user being able to affect translation output without review.

## Existing bug being fixed

`POST /api/glossary/suggest` (any logged-in user, called from the translate
page) does `prisma.glossary.upsert({ where: { korean } })`. If the term already
exists and is approved, the user's suggestion **overwrites** it and sets
`status="pending_reference"`, so the approved translation is lost and the term
stops being force-matched until a reviewer re-approves it. After this change
that route writes to the suggestion box instead and never touches `Glossary`.

## 1. Template file

Sheet 1 `용어집` — header row, a second row marking each column 필수/선택,
then 2–3 example rows that the parser ignores (see §3).

| Column header | Required | Maps to | Notes |
|---|---|---|---|
| 한국어 용어 | 필수 | `korean` | Trimmed. Unique within the file. |
| 영어 번역 | 필수 | `english` | Trimmed. |
| 분류 | 선택 | `type` | Dropdown (Excel data validation) of the 8 types shown in Korean; blank → `General`. |
| 다른 표기 | 선택 | `aliases` | Comma-separated alternate Korean forms (matches `split_aliases`, which splits on `,` and `|`). |
| 사용 메모 | 선택 | `usageNote` | Free text. |

Korean labels for the 8 types (mapped to the existing English values in
`GlossaryClient.tsx`'s `TYPES`): 일반=General, 기구=Organization,
규정=Regulation, 직책=Role/Position, 선거=Election, 재정=Finance,
회의·절차=Meeting/Procedure, 학사=Academic. The parser also accepts the
English values.

Sheet 2 `작성 방법` — short Korean instructions: what each column means,
alias separator, that example rows are ignored, that existing terms are not
overwritten without a reviewer's decision.

Fields not in the template are filled automatically: `source="excel"`,
`lastContext=""`; `status="approved"` for reviewer uploads.

## 2. Data model

New Prisma model (plus migration):

```prisma
model GlossarySuggestion {
  id          Int      @id @default(autoincrement())
  korean      String
  english     String
  type        String   @default("General")
  aliases     String   @default("")
  usageNote   String   @default("")
  lastContext String   @default("")
  source      String              // "excel" | "translation_flow"
  status      String   @default("pending") // "pending" | "accepted" | "rejected"
  userId      Int                 // who suggested it
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  reviewedById Int?
  reviewedAt  DateTime?
  createdAt   DateTime @default(now())

  @@index([status])
  @@index([korean])
}
```

`korean` is deliberately not unique: two users may suggest different
translations for the same term, and a suggestion may collide with an existing
`Glossary` row. Whether it collides is computed at review time, not stored, so
it stays correct if the glossary changes in between.

## 3. Upload and preview (both roles)

The glossary page gets a "엑셀로 올리기" area visible to every logged-in user,
with a "템플릿 받기" link. Uploading a file returns a preview without saving:

- **새 용어** — valid, `korean` not in `Glossary`.
- **겹치는 용어** — valid, and at least one of its surface forms (its `korean`
  or any of its aliases) is already a surface form (a `korean` or alias) of a
  `Glossary` row. Two kinds:
  - **같은 용어** — `korean` equals an existing row's `korean`. Shows the
    existing entry next to the file's row.
  - **표기 충돌** — any other surface-form overlap, e.g. the file's alias
    `학생회` is an existing term, or the file's `korean` is an existing term's
    alias. Shows which surface form collides with which existing term.

  The pipeline's matcher (`glossary_manager.match_terms`) gives a surface
  form to whichever row sorts first, so letting a collision through silently
  would change which English an approved term gets. Every collision therefore
  needs a reviewer decision. The same check runs on surface forms inside the
  file itself: two file rows sharing a surface form are 문제 있는 행.
- **문제 있는 행** — excluded, with a reason: missing 한국어 용어 or 영어 번역,
  unknown 분류, or the same 한국어 용어 appearing twice in the file (all
  occurrences flagged).

Rows that exactly match the template's example rows are skipped. Blank rows
are skipped silently. A file that is not a readable `.xlsx`, has no `용어집`
sheet or is missing a required header is rejected with a clear message.

## 4. Applying an upload

**What "바꾸기" overwrites** (both "엑셀로 바꾸기" here and "제안으로 바꾸기" in
§5): `english` always; `type`, `aliases` and `usageNote` only when the file or
suggestion has a non-blank value. Blanks keep the existing value. `description`,
`category` and `lastContext` are never touched. `status` becomes `approved`, and
`source` becomes the suggestion's source (`"excel"` or `"translation_flow"`).
The side-by-side view shows every field that will change, not only `english`.

**표기 충돌 choices** (reviewer upload and suggestion box alike):
- **기존 유지** (default) — the existing term keeps the surface form. The new
  row is added without the colliding aliases. If the new row's own `korean`
  is the collision (it is an existing term's alias), the row is skipped.
- **엑셀로 바꾸기 / 제안으로 바꾸기** — the surface form moves to the new
  row: it is removed from the existing term's `aliases`. Not offered when the
  colliding surface form is an existing term's own `korean` (a term cannot
  lose its name); then only 기존 유지 or 거절/건너뛰기 is available.

A row can have several collisions; each is decided separately. After apply,
no surface form belongs to more than one row — re-checked on the server
inside the apply transaction.

**Reviewer:** each 겹치는 용어 row has "기존 유지" (default) / "엑셀로 바꾸기",
plus "모두 유지" / "모두 바꾸기". "반영하기" writes new terms and the chosen
replacements to `Glossary` as `approved` in one transaction, then reports
added / replaced / kept / excluded counts.

**Regular user:** no keep/replace choice. "제안 보내기" saves every valid row
(new and overlapping alike) as `GlossarySuggestion` rows with
`source="excel"`, then reports how many were sent for review.

The server re-validates and re-classifies on apply; it does not trust the
preview the client sends back.

## 5. Suggestion box (reviewers only)

A "제안함" view on the glossary page (or its own tab), listing `pending`
suggestions with who suggested them, when, and the source.

- **New term** suggestion: 승인 (creates an `approved` `Glossary` row) / 거절.
- **Overlapping** suggestion (같은 용어 or 표기 충돌, computed as in §3 against
  the current glossary): existing vs suggested shown side by side;
  기존 유지 (marks suggestion rejected) / 제안으로 바꾸기 (updates the
  `Glossary` row, approved) / 거절.

Accepting or rejecting sets `status`, `reviewedById`, `reviewedAt`. If several
pending suggestions exist for the same term, accepting one leaves the others
pending; the reviewer handles them individually.

## 6. Translate-flow suggestions

`POST /api/glossary/suggest` creates a `GlossarySuggestion` with
`source="translation_flow"` instead of upserting `Glossary`. The hint text on
the translate page (`app/(protected)/translate/page.tsx`, currently mentioning
`pending_reference`) is updated to say the term goes to the reviewer's
suggestion box. Update `lib/glossary.test.ts` and
`test/glossary-flow.integration.test.ts` accordingly, and add a regression
test: suggesting an already-approved term leaves the `Glossary` row unchanged.

Existing `pending_reference` rows in `Glossary` are left as they are and stay
manageable through the current glossary table.

**Not asking again for a pending term.** Today the `pending_reference` row
stops `web_pipeline._detect_missing_terms` from raising the same term on the
next run. Since suggestions no longer create a `Glossary` row, that function
also treats any `korean` with a `pending` `GlossarySuggestion` as not missing
(one extra query in `db_glossary.py`). The suggest route also dedupes: if the
same user already has a `pending` suggestion for that `korean`, it updates
that one instead of adding another. Different users' suggestions for the same
term stay separate.

## 7. Permissions

| Action | user | editor / admin |
|---|---|---|
| Download template, upload + preview | ✓ | ✓ |
| Apply directly to `Glossary` | ✗ | ✓ |
| Send suggestions | ✓ | ✓ (not needed, but harmless) |
| View / decide suggestion box | ✗ | ✓ |

Suspended users are rejected like other write routes. Enforce on the server;
the UI only hides what the role cannot use.

## 8. Calls made by Claude (not decided by the user)

- **Excel library:** add `exceljs` to the Next.js app and do parsing and
  template generation in Next.js API routes. The Python handler
  (`api/index.py`) only accepts `{text}` JSON, so putting it there would mean
  reworking that handler; `exceljs` also supports the dropdown validation the
  template needs.
- **Template served from a route** (e.g. `GET /api/glossary/template`) built
  with `exceljs`, so the type list has one source of truth in code.
- Conflict default is 기존 유지; status defaults per §1.
- Upload size: reject files over 2 MB / 2,000 data rows (well under Vercel's
  4.5 MB request body limit).
- Korean-only UI text for the new screens, matching the translate page.
- "바꾸기" overwrite rules (§4): blanks keep existing values.
- 표기 충돌 choices (§4): what 기존 유지 and 바꾸기 mean for an alias
  collision. (That alias collisions are shown as 겹치는 용어 for the reviewer
  to decide was the user's decision.)
- Pending suggestions suppress re-asking in the translate flow, and the same
  user's repeat suggestion updates their pending one (§6).
- Existing rows with status `deprecated` or `pending_reference` count as
  겹치는 용어 like approved ones (default 기존 유지). A row that becomes
  overlapping between preview and apply defaults to 기존 유지.

## 9. Left to the builder

- Exact placement and styling of the upload area and suggestion box within
  the glossary page.
- API route names and request/response shapes.
- Splitting the work into tasks.
