import { NextRequest, NextResponse } from "next/server";
import { canEditGlossary, getSessionUserFromRequest } from "@/lib/auth";
import { collisionKey, findCollisions, planApply } from "@/lib/glossary-import";
import { executePlans, loadExistingTerms, parseDecisions, uploadErrorResponse } from "@/lib/glossary-import-server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs"; // Prisma's pg driver adapter needs Node, not edge
export const dynamic = "force-dynamic"; // session-cookie-dependent response -- never let Vercel/Next cache this across users

class NotPendingError extends Error {}
class CollisionsChangedError extends Error {}

// Reviewer-only: accept or reject one pending suggestion. Accept recomputes
// collisions now; a collision with no decision keeps the existing term, and a
// plan that keeps everything marks the suggestion rejected (spec §5 기존 유지).
// `seenCollisions` are the collision keys the reviewer was shown; if the
// glossary has since grown a collision they never saw, nothing changes and
// the client gets 409 collisions_changed so it can reload and show it.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const reviewer = await getSessionUserFromRequest(request);
  if (!reviewer || !canEditGlossary(reviewer)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const { id: idParam } = await params;
  const id = Number.parseInt(idParam, 10);
  if (Number.isNaN(id)) {
    return NextResponse.json({ ok: false, error: "invalid suggestion id" }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  if (body.action !== "accept" && body.action !== "reject") {
    return NextResponse.json({ ok: false, error: "action must be accept or reject" }, { status: 400 });
  }
  const decisions = parseDecisions(body.decisions);
  const seen = new Set(Array.isArray(body.seenCollisions) ? body.seenCollisions.map(String) : []);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const s = await tx.glossarySuggestion.findUnique({ where: { id } });
      if (!s || s.status !== "pending") throw new NotPendingError();

      let result: "accepted" | "rejected" = "rejected";
      if (body.action === "accept") {
        const row = { rowNumber: 0, korean: s.korean, english: s.english, type: s.type, aliases: s.aliases, usageNote: s.usageNote };
        const collisions = findCollisions(row, await loadExistingTerms(tx));
        if (collisions.some((c) => !seen.has(collisionKey(c)))) throw new CollisionsChangedError();
        const plan = planApply(row, collisions, decisions, s.source);
        if (plan.kind !== "skip") {
          await executePlans(tx, [plan]);
          // A new term keeps the sentence it was suggested from (an update never touches lastContext).
          if (s.lastContext && plan.kind === "create") {
            await tx.glossary.update({ where: { korean: s.korean }, data: { lastContext: s.lastContext } });
          }
          result = "accepted";
        }
      }
      await tx.glossarySuggestion.update({
        where: { id },
        data: { status: result, reviewedById: reviewer.id, reviewedAt: new Date() },
      });
      return result;
    });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    if (err instanceof CollisionsChangedError) {
      return NextResponse.json({ ok: false, error: "collisions_changed" }, { status: 409 });
    }
    if (err instanceof NotPendingError) {
      return NextResponse.json({ ok: false, error: "not_pending" }, { status: 409 });
    }
    const mapped = uploadErrorResponse(err);
    if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
    throw err;
  }
}
