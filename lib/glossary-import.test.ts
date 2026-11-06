import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TEMPLATE_EXAMPLES,
  classifyUpload,
  collisionKey,
  findCollisions,
  findSurfaceConflicts,
  planApply,
  type Collision,
  normalizeType,
  splitAliases,
  type ExistingTerm,
  type UploadRow,
} from "./glossary-import.ts";

function row(rowNumber: number, korean: string, english: string, extra: Partial<UploadRow> = {}): UploadRow {
  return { rowNumber, korean, english, type: "", aliases: "", usageNote: "", ...extra };
}

function term(id: number, korean: string, aliases = "", extra: Partial<ExistingTerm> = {}): ExistingTerm {
  return { id, korean, english: `${korean}-en`, type: "General", aliases, usageNote: "", status: "approved", ...extra };
}

test("normalizeType accepts Korean labels and English values, blank means General", () => {
  assert.equal(normalizeType("기구"), "Organization");
  assert.equal(normalizeType("Organization"), "Organization");
  assert.equal(normalizeType("회의·절차"), "Meeting/Procedure");
  assert.equal(normalizeType(""), "General");
  assert.equal(normalizeType("없는분류"), null);
});

test("splitAliases splits on comma or pipe and drops blanks", () => {
  assert.deepEqual(splitAliases("총학, 학생회|  "), ["총학", "학생회"]);
  assert.deepEqual(splitAliases(""), []);
});

test("same korean as an existing term is one same_term collision", () => {
  const collisions = findCollisions(row(3, "총학생회", "X", { aliases: "총학" }), [term(1, "총학생회", "총학")]);
  assert.deepEqual(collisions, [{ termId: 1, termKorean: "총학생회", surface: "총학생회", kind: "same_term", canReplace: true }]);
});

test("a file alias equal to another term's korean cannot be taken over", () => {
  const collisions = findCollisions(row(3, "총학생회", "X", { aliases: "학생회" }), [term(2, "학생회")]);
  assert.deepEqual(collisions, [{ termId: 2, termKorean: "학생회", surface: "학생회", kind: "surface", canReplace: false }]);
});

test("a file korean equal to another term's alias can take that alias over", () => {
  const collisions = findCollisions(row(3, "중운위", "X"), [term(3, "중앙운영위원회", "중운위")]);
  assert.deepEqual(collisions, [{ termId: 3, termKorean: "중앙운영위원회", surface: "중운위", kind: "surface", canReplace: true }]);
});

test("classifyUpload buckets rows and skips examples and blank rows", () => {
  const example = TEMPLATE_EXAMPLES[0];
  const preview = classifyUpload(
    [
      row(3, "신규", "New"),
      row(4, "영어없음", ""),
      row(5, "분류이상", "Bad", { type: "없는분류" }),
      row(6, "가", "A", { aliases: "총학" }),
      row(7, "나", "B", { aliases: "총학" }),
      { ...example, rowNumber: 8 },
      row(9, "", ""),
      row(10, "기존", "Existing"),
    ],
    [term(50, "기존")]
  );
  assert.deepEqual(preview.newRows.map((r) => r.korean), ["신규"]);
  assert.deepEqual(preview.overlaps.map((o) => o.row.korean), ["기존"]);
  assert.deepEqual(
    preview.problems.map((p) => [p.rowNumber, p.reasons]),
    [
      [4, ["missing_english"]],
      [5, ["unknown_type"]],
      [6, ["duplicate_in_file"]],
      [7, ["duplicate_in_file"]],
    ]
  );
});

test("classifyUpload normalizes the type label of kept rows", () => {
  const preview = classifyUpload([row(3, "신규", "New", { type: "기구" })], []);
  assert.equal(preview.newRows[0].type, "Organization");
});

const sameTerm: Collision = { termId: 1, termKorean: "총학생회", surface: "총학생회", kind: "same_term", canReplace: true };

test("planApply: keeping a same_term collision skips the row", () => {
  assert.deepEqual(planApply(row(3, "총학생회", "New"), [sameTerm], {}, "excel"), { kind: "skip" });
});

test("planApply: replacing a same_term collision updates only non-blank fields", () => {
  const plan = planApply(
    { ...row(3, "총학생회", "New"), type: "General" },
    [sameTerm],
    { [collisionKey(sameTerm)]: "replace" },
    "excel"
  );
  assert.deepEqual(plan, {
    kind: "update",
    existingId: 1,
    korean: "총학생회",
    data: { english: "New", type: "General", status: "approved", source: "excel" },
    aliasRemovals: [],
  });
});

test("planApply: replace on a non-replaceable alias collision keeps it and drops the alias", () => {
  const c: Collision = { termId: 2, termKorean: "학생회", surface: "학생회", kind: "surface", canReplace: false };
  const plan = planApply({ ...row(3, "총학생회", "X", { aliases: "학생회, 총학" }), type: "General" }, [c], { [collisionKey(c)]: "replace" }, "excel");
  assert.equal(plan.kind, "create");
  if (plan.kind === "skip") return;
  assert.equal(plan.data.aliases, "총학");
  assert.deepEqual(plan.aliasRemovals, []);
});

test("planApply: own-korean collision moves the alias on replace and skips on keep", () => {
  const c: Collision = { termId: 3, termKorean: "중앙운영위원회", surface: "중운위", kind: "surface", canReplace: true };
  const r = { ...row(3, "중운위", "X"), type: "General" };
  const plan = planApply(r, [c], { [collisionKey(c)]: "replace" }, "excel");
  assert.equal(plan.kind, "create");
  if (plan.kind === "skip") return;
  assert.deepEqual(plan.aliasRemovals, [{ termId: 3, surface: "중운위" }]);
  assert.deepEqual(planApply(r, [c], {}, "excel"), { kind: "skip" });
});

test("findSurfaceConflicts ignores conflicts outside the touched surfaces", () => {
  const terms = [
    { korean: "A", aliases: "B" },
    { korean: "B", aliases: "" },
    { korean: "C", aliases: "D" },
    { korean: "D", aliases: "" },
  ];
  assert.deepEqual(findSurfaceConflicts(terms, new Set(["B"])), ["B"]);
});

test("a blank 분류 stays blank so replacing never resets the existing type", () => {
  const preview = classifyUpload([row(3, "총학생회", "New")], [term(1, "총학생회", "", { type: "Organization" })]);
  const r = preview.overlaps[0].row;
  assert.equal(r.type, "");
  const plan = planApply(r, preview.overlaps[0].collisions, { [collisionKey(sameTerm)]: "replace" }, "excel");
  assert.equal(plan.kind, "update");
  if (plan.kind === "skip") return;
  assert.equal("type" in plan.data, false);
});

test("only an exact copy of a template example is skipped, and the skip is counted", () => {
  const ex = TEMPLATE_EXAMPLES[2]; // 회장 / President / 직책
  const preview = classifyUpload(
    [
      { ...ex, rowNumber: 3 },
      row(4, ex.korean, ex.english, { type: "", usageNote: "학생회장" }),
    ],
    []
  );
  assert.equal(preview.skippedExamples, 1);
  assert.deepEqual(preview.newRows.map((r) => r.rowNumber), [4]);
});
