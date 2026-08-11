import { NextRequest, NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs"; // Prisma's pg driver adapter needs Node, not edge
export const dynamic = "force-dynamic"; // session-cookie-dependent response -- never let Vercel/Next cache this across users

export async function POST(request: NextRequest) {
  if (!(await getSessionUserFromRequest(request))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const korean = (body.korean || "").trim();
  const english = (body.english || "").trim();
  if (!korean || !english) {
    return NextResponse.json({ ok: false, error: "korean and english are required" }, { status: 400 });
  }

  const data = {
    english,
    description: body.description ?? undefined,
    category: body.category ?? undefined,
    type: body.type || "General",
    aliases: body.aliases || "",
    usageNote: body.usageNote || "",
    status: body.status || "approved",
    source: body.source || "user",
    lastContext: body.lastContext || "",
  };

  const term = await prisma.glossary.upsert({
    where: { korean },
    update: data,
    create: { korean, ...data },
  });

  return NextResponse.json({ ok: true, term });
}
