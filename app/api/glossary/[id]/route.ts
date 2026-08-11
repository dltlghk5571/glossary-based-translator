import { NextRequest, NextResponse } from "next/server";
import { canEditGlossary, getSessionUserFromRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs"; // Prisma's pg driver adapter needs Node, not edge
export const dynamic = "force-dynamic"; // session-cookie-dependent response -- never let Vercel/Next cache this across users

const PATCHABLE_FIELDS = [
  "korean",
  "english",
  "description",
  "category",
  "type",
  "aliases",
  "usageNote",
  "status",
  "source",
  "lastContext",
] as const;

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!canEditGlossary(await getSessionUserFromRequest(request))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const { id: idParam } = await params;
  const id = Number.parseInt(idParam, 10);
  if (Number.isNaN(id)) {
    return NextResponse.json({ ok: false, error: "invalid term id" }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const data: Record<string, string> = {};
  for (const field of PATCHABLE_FIELDS) {
    if (typeof body[field] === "string") data[field] = body[field];
  }

  try {
    const term = await prisma.glossary.update({ where: { id }, data });
    return NextResponse.json({ ok: true, term });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      return NextResponse.json({ ok: false, error: "another term with this Korean text already exists" }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: "term not found" }, { status: 404 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!canEditGlossary(await getSessionUserFromRequest(request))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const { id: idParam } = await params;
  const id = Number.parseInt(idParam, 10);
  if (Number.isNaN(id)) {
    return NextResponse.json({ ok: false, error: "invalid term id" }, { status: 400 });
  }

  try {
    await prisma.glossary.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, error: "term not found" }, { status: 404 });
  }
}
