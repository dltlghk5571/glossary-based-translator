// DB side of the glossary import and suggestion box: loads the glossary,
// stores suggestions, and executes ApplyPlans from lib/glossary-import.ts.
import type { Prisma } from "./generated/prisma/client";
import { prisma } from "./prisma";
import { MAX_UPLOAD_BYTES, UploadFormatError, readUploadRows } from "./glossary-excel";
import {
  findSurfaceConflicts,
  planSurfaces,
  splitAliases,
  type ApplyPlan,
  type Decision,
  type ExistingTerm,
  type NormalizedRow,
  type UploadRow,
} from "./glossary-import";

export type Tx = Prisma.TransactionClient;

// A 2,000-row apply is many sequential statements; the 5s default is too short.
export const APPLY_TX_OPTIONS = { timeout: 60_000, maxWait: 10_000 };

export class SurfaceConflictError extends Error {
  surfaces: string[];
  constructor(surfaces: string[]) {
    super("surface_conflict");
    this.surfaces = surfaces;
  }
}

export async function loadExistingTerms(tx: Tx = prisma): Promise<ExistingTerm[]> {
  return tx.glossary.findMany({
    select: { id: true, korean: true, english: true, type: true, aliases: true, usageNote: true, status: true },
    orderBy: { korean: "asc" },
  });
}

export async function readUploadFromForm(form: FormData): Promise<UploadRow[]> {
  const file = form.get("file");
  if (!(file instanceof Blob)) throw new UploadFormatError("unreadable");
  if (file.size > MAX_UPLOAD_BYTES) throw new UploadFormatError("too_large");
  return readUploadRows(Buffer.from(await file.arrayBuffer()));
}

export function parseDecisions(raw: unknown): Record<string, Decision> {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const out: Record<string, Decision> = {};
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed)) if (v === "replace" || v === "keep") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

// One pending suggestion per (user, korean): a repeat suggestion updates it.
export async function upsertPendingSuggestion(
  tx: Tx,
  userId: number,
  row: Omit<NormalizedRow, "rowNumber">,
  source: "excel" | "translation_flow",
  lastContext = ""
) {
  const data = {
    english: row.english,
    type: row.type, // "" stays "" so a reviewer's 바꾸기 never resets the existing type
    aliases: row.aliases,
    usageNote: row.usageNote,
    lastContext,
    source,
  };
  const existing = await tx.glossarySuggestion.findFirst({ where: { userId, korean: row.korean, status: "pending" } });
  return existing
    ? tx.glossarySuggestion.update({ where: { id: existing.id }, data })
    : tx.glossarySuggestion.create({ data: { ...data, korean: row.korean, userId } });
}

// Runs inside the caller's transaction; throws SurfaceConflictError (so the
// transaction rolls back) if the result would give a surface form two terms.
export async function executePlans(tx: Tx, plans: ApplyPlan[]): Promise<void> {
  const touched = new Set<string>();
  for (const plan of plans) {
    if (plan.kind === "skip") continue;
    planSurfaces(plan).forEach((s) => touched.add(s));
    for (const removal of plan.aliasRemovals) {
      const term = await tx.glossary.findUnique({ where: { id: removal.termId }, select: { aliases: true } });
      if (!term) continue;
      const aliases = splitAliases(term.aliases).filter((a) => a !== removal.surface).join(", ");
      await tx.glossary.update({ where: { id: removal.termId }, data: { aliases } });
    }
    if (plan.kind === "update") {
      await tx.glossary.update({ where: { id: plan.existingId }, data: plan.data });
    } else {
      await tx.glossary.create({ data: { korean: plan.korean, ...plan.data } });
    }
  }
  if (!touched.size) return;
  const conflicts = findSurfaceConflicts(await loadExistingTerms(tx), touched);
  if (conflicts.length) throw new SurfaceConflictError(conflicts);
}

export function uploadErrorResponse(err: unknown): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof UploadFormatError) return { status: 400, body: { ok: false, error: err.code } };
  if (err instanceof SurfaceConflictError) return { status: 409, body: { ok: false, error: "surface_conflict", surfaces: err.surfaces } };
  return null;
}
