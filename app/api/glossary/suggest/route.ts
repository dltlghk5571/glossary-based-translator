import { NextRequest, NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/auth";
import { canSuggestGlossaryTerm } from "@/lib/glossary";
import { normalizeType } from "@/lib/glossary-import";
import { upsertPendingSuggestion } from "@/lib/glossary-import-server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs"; // Prisma's pg driver adapter needs Node, not edge
export const dynamic = "force-dynamic"; // session-cookie-dependent response -- never let Vercel/Next cache this across users

// Any authenticated user hits this while translating, when the analyzer finds
// a term missing from the glossary. It only ever creates (or updates this
// user's own) pending GlossarySuggestion -- it never touches Glossary, so a
// suggestion can't overwrite an approved term. Reviewers decide in 제안함.
export async function POST(request: NextRequest) {
  const user = await getSessionUserFromRequest(request);
  if (!canSuggestGlossaryTerm(user) || !user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const korean = String(body.korean ?? "").trim();
  const english = String(body.english ?? "").trim();
  if (!korean || !english) {
    return NextResponse.json({ ok: false, error: "korean and english are required" }, { status: 400 });
  }

  const suggestion = await upsertPendingSuggestion(
    prisma,
    user.id,
    {
      korean,
      english,
      type: normalizeType(String(body.type ?? "")) ?? "General",
      aliases: String(body.aliases ?? "").trim(),
      usageNote: String(body.usageNote ?? "").trim(),
    },
    "translation_flow",
    String(body.lastContext ?? "")
  );

  return NextResponse.json({ ok: true, suggestion });
}
