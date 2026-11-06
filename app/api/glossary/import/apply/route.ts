import { NextRequest, NextResponse } from "next/server";
import { canEditGlossary, getSessionUserFromRequest } from "@/lib/auth";
import { classifyUpload, planApply } from "@/lib/glossary-import";
import {
  APPLY_TX_OPTIONS,
  executePlans,
  loadExistingTerms,
  parseDecisions,
  readUploadFromForm,
  uploadErrorResponse,
  upsertPendingSuggestion,
} from "@/lib/glossary-import-server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs"; // exceljs + Prisma need Node, not edge
export const dynamic = "force-dynamic"; // session-cookie-dependent response -- never let Vercel/Next cache this across users

// Reviewers (admin/editor) apply straight to Glossary; everyone else's rows
// become pending suggestions. The file is re-read and collisions recomputed
// here -- the client's preview is never trusted.
export async function POST(request: NextRequest) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const form = await request.formData();
    const rows = await readUploadFromForm(form);
    const decisions = parseDecisions(form.get("decisions"));

    if (!canEditGlossary(user)) {
      const preview = classifyUpload(rows, await loadExistingTerms());
      const valid = [...preview.newRows, ...preview.overlaps.map((o) => o.row)];
      await prisma.$transaction(async (tx) => {
        for (const row of valid) await upsertPendingSuggestion(tx, user.id, row, "excel");
      }, APPLY_TX_OPTIONS);
      return NextResponse.json({
        ok: true,
        mode: "suggested",
        counts: { suggested: valid.length, excluded: preview.problems.length },
      });
    }

    const counts = await prisma.$transaction(async (tx) => {
      const preview = classifyUpload(rows, await loadExistingTerms(tx));
      const plans = [
        ...preview.newRows.map((row) => planApply(row, [], decisions, "excel")),
        ...preview.overlaps.map((o) => planApply(o.row, o.collisions, decisions, "excel")),
      ];
      await executePlans(tx, plans);
      return {
        added: plans.filter((p) => p.kind === "create").length,
        replaced: plans.filter((p) => p.kind === "update").length,
        kept: plans.filter((p) => p.kind === "skip").length,
        excluded: preview.problems.length,
      };
    }, APPLY_TX_OPTIONS);
    return NextResponse.json({ ok: true, mode: "applied", counts });
  } catch (err) {
    const mapped = uploadErrorResponse(err);
    if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
    throw err;
  }
}
