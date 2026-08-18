import { NextRequest, NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/auth";
import { buildGlossaryUpsertData, canSuggestGlossaryTerm } from "@/lib/glossary";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs"; // Prisma's pg driver adapter needs Node, not edge
export const dynamic = "force-dynamic"; // session-cookie-dependent response -- never let Vercel/Next cache this across users

// Any authenticated user hits this while translating, when the analyzer finds
// a term missing from the glossary. Always lands as "pending_reference" --
// only /api/glossary/approve (admin/editor) can mark a term "approved".
export async function POST(request: NextRequest) {
  const user = await getSessionUserFromRequest(request);
  if (!canSuggestGlossaryTerm(user)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const korean = (body.korean || "").trim();
  const english = (body.english || "").trim();
  if (!korean || !english) {
    return NextResponse.json({ ok: false, error: "korean and english are required" }, { status: 400 });
  }

  const data = buildGlossaryUpsertData(body, { status: "pending_reference", source: "translation_flow" });

  const term = await prisma.glossary.upsert({
    where: { korean },
    update: data,
    create: { korean, ...data },
  });

  return NextResponse.json({ ok: true, term });
}
