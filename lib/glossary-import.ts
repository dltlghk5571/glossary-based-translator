// Pure decision logic for the glossary Excel upload and the suggestion box.
// No runtime imports of sibling lib/ files: `node --test` loads this file
// directly and can't resolve Next's extensionless imports.

export const GLOSSARY_TYPES: readonly { value: string; label: string }[] = [
  { value: "General", label: "일반" },
  { value: "Organization", label: "기구" },
  { value: "Regulation", label: "규정" },
  { value: "Role/Position", label: "직책" },
  { value: "Election", label: "선거" },
  { value: "Finance", label: "재정" },
  { value: "Meeting/Procedure", label: "회의·절차" },
  { value: "Academic", label: "학사" },
];

export type UploadRow = {
  rowNumber: number;
  korean: string;
  english: string;
  type: string;
  aliases: string;
  usageNote: string;
};

// Same shape as UploadRow, with `type` normalized to a GLOSSARY_TYPES value --
// or left "" when the cell was blank, so "바꾸기" never resets an existing type
// (a create falls back to the Prisma default "General").
export type NormalizedRow = UploadRow;

export type ExistingTerm = {
  id: number;
  korean: string;
  english: string;
  type: string;
  aliases: string;
  usageNote: string;
  status: string;
};

export type Collision = {
  termId: number;
  termKorean: string;
  surface: string;
  kind: "same_term" | "surface";
  canReplace: boolean;
};

export type ProblemReason = "missing_korean" | "missing_english" | "unknown_type" | "duplicate_in_file";

export type UploadPreview = {
  newRows: NormalizedRow[];
  overlaps: { row: NormalizedRow; collisions: Collision[] }[];
  problems: { rowNumber: number; korean: string; reasons: ProblemReason[] }[];
};

export const TEMPLATE_EXAMPLES: readonly UploadRow[] = [
  { rowNumber: 0, korean: "총학생회", english: "Undergraduate Student Council", type: "기구", aliases: "총학", usageNote: "공식 기구명으로만 사용" },
  { rowNumber: 0, korean: "회칙", english: "Constitution", type: "규정", aliases: "", usageNote: "" },
  { rowNumber: 0, korean: "회장", english: "President", type: "직책", aliases: "", usageNote: "" },
];

export function normalizeType(input: string): string | null {
  const s = input.trim();
  if (!s) return "General";
  const found = GLOSSARY_TYPES.find((t) => t.label === s || t.value === s);
  return found ? found.value : null;
}

// Same separators as glossary_manager.split_aliases (Python), so both sides agree.
export function splitAliases(s: string): string[] {
  return s
    .split(/[,|]/)
    .map((a) => a.trim())
    .filter(Boolean);
}

function surfacesOf(t: { korean: string; aliases: string }): string[] {
  return [t.korean.trim(), ...splitAliases(t.aliases)].filter(Boolean);
}

export function collisionKey(c: Collision): string {
  return `${c.termId}:${c.surface}`;
}

export function findCollisions(row: NormalizedRow, existing: ExistingTerm[]): Collision[] {
  const collisions: Collision[] = [];
  const rowSurfaces = surfacesOf(row);
  for (const t of existing) {
    if (t.korean === row.korean) {
      collisions.push({ termId: t.id, termKorean: t.korean, surface: t.korean, kind: "same_term", canReplace: true });
      continue;
    }
    const theirs = new Set(surfacesOf(t));
    for (const surface of rowSurfaces) {
      if (theirs.has(surface)) {
        collisions.push({ termId: t.id, termKorean: t.korean, surface, kind: "surface", canReplace: surface !== t.korean });
      }
    }
  }
  return collisions;
}

function isBlank(r: UploadRow): boolean {
  return !r.korean && !r.english && !r.type && !r.aliases && !r.usageNote;
}

function isExample(r: UploadRow): boolean {
  return TEMPLATE_EXAMPLES.some((e) => e.korean === r.korean && e.english === r.english);
}

export function classifyUpload(rows: UploadRow[], existing: ExistingTerm[]): UploadPreview {
  const kept = rows.filter((r) => !isBlank(r) && !isExample(r));

  // Which rows share a surface form with another row in the same file.
  const surfaceRows = new Map<string, Set<number>>();
  kept.forEach((r, i) => {
    for (const s of surfacesOf(r)) {
      if (!surfaceRows.has(s)) surfaceRows.set(s, new Set());
      surfaceRows.get(s)!.add(i);
    }
  });
  const duplicated = new Set<number>();
  for (const idxs of surfaceRows.values()) {
    if (idxs.size > 1) idxs.forEach((i) => duplicated.add(i));
  }

  const preview: UploadPreview = { newRows: [], overlaps: [], problems: [] };
  kept.forEach((r, i) => {
    const reasons: ProblemReason[] = [];
    if (!r.korean) reasons.push("missing_korean");
    if (!r.english) reasons.push("missing_english");
    const type = normalizeType(r.type);
    if (type === null) reasons.push("unknown_type");
    if (duplicated.has(i)) reasons.push("duplicate_in_file");
    if (reasons.length) {
      preview.problems.push({ rowNumber: r.rowNumber, korean: r.korean, reasons });
      return;
    }
    const normalized: NormalizedRow = { ...r, type: r.type.trim() ? (type as string) : "" };
    const collisions = findCollisions(normalized, existing);
    if (collisions.length) preview.overlaps.push({ row: normalized, collisions });
    else preview.newRows.push(normalized);
  });
  return preview;
}

export type Decision = "keep" | "replace";

export type ApplyPlan =
  | { kind: "skip" }
  | {
      kind: "create" | "update";
      existingId?: number;
      korean: string;
      data: { english: string; type?: string; aliases?: string; usageNote?: string; status: "approved"; source: string };
      aliasRemovals: { termId: number; surface: string }[];
    };

// Missing decisions, and "replace" where the collision can't be replaced, mean "keep".
export function planApply(
  row: NormalizedRow,
  collisions: Collision[],
  decisions: Record<string, Decision>,
  source: string
): ApplyPlan {
  const wantsReplace = (c: Collision) => c.canReplace && decisions[collisionKey(c)] === "replace";
  let existingId: number | undefined;
  let aliases = splitAliases(row.aliases);
  const aliasRemovals: { termId: number; surface: string }[] = [];

  for (const c of collisions) {
    if (c.kind === "same_term") {
      if (!wantsReplace(c)) return { kind: "skip" };
      existingId = c.termId;
    } else if (c.surface === row.korean) {
      if (!wantsReplace(c)) return { kind: "skip" };
      aliasRemovals.push({ termId: c.termId, surface: c.surface });
    } else if (wantsReplace(c)) {
      aliasRemovals.push({ termId: c.termId, surface: c.surface });
    } else {
      aliases = aliases.filter((a) => a !== c.surface);
    }
  }

  const data: Extract<ApplyPlan, { kind: "create" | "update" }>["data"] = { english: row.english, status: "approved", source };
  if (row.type) data.type = row.type;
  if (aliases.length) data.aliases = aliases.join(", ");
  if (row.usageNote) data.usageNote = row.usageNote;

  return existingId === undefined
    ? { kind: "create", korean: row.korean, data, aliasRemovals }
    : { kind: "update", existingId, korean: row.korean, data, aliasRemovals };
}

// Surfaces in `onlySurfaces` claimed by more than one term. Scoped so that
// conflicts already present in legacy data never block an unrelated upload.
export function findSurfaceConflicts(terms: { korean: string; aliases: string }[], onlySurfaces: Set<string>): string[] {
  const counts = new Map<string, number>();
  for (const t of terms) {
    for (const s of new Set(surfacesOf(t))) {
      if (onlySurfaces.has(s)) counts.set(s, (counts.get(s) || 0) + 1);
    }
  }
  return [...counts].filter(([, n]) => n > 1).map(([s]) => s);
}

// Every surface form an apply plan writes, for the post-apply conflict check.
export function planSurfaces(plan: ApplyPlan): string[] {
  if (plan.kind === "skip") return [];
  return [plan.korean, ...splitAliases(plan.data.aliases || "")];
}
