import { NextRequest, NextResponse } from "next/server";
import { canEditGlossary, getSessionUserFromRequest } from "@/lib/auth";
import { findCollisions } from "@/lib/glossary-import";
import { loadExistingTerms } from "@/lib/glossary-import-server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs"; // Prisma's pg driver adapter needs Node, not edge
export const dynamic = "force-dynamic"; // session-cookie-dependent response -- never let Vercel/Next cache this across users

// Reviewer-only: pending suggestions, oldest first, with collisions computed
// against the glossary as it is right now (not when the suggestion was made).
export async function GET(request: NextRequest) {
  if (!canEditGlossary(await getSessionUserFromRequest(request))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const [pending, existing] = await Promise.all([
    prisma.glossarySuggestion.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
      include: { user: { select: { username: true } } },
    }),
    loadExistingTerms(),
  ]);

  const suggestions = pending.map((s) => {
    const collisions = findCollisions({ rowNumber: 0, ...s, type: s.type }, existing);
    const ids = new Set(collisions.map((c) => c.termId));
    return {
      id: s.id,
      korean: s.korean,
      english: s.english,
      type: s.type,
      aliases: s.aliases,
      usageNote: s.usageNote,
      source: s.source,
      createdAt: s.createdAt,
      username: s.user.username,
      collisions,
      existing: existing.filter((t) => ids.has(t.id)),
    };
  });

  return NextResponse.json({ ok: true, suggestions });
}
