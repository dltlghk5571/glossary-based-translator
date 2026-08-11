import { NextRequest, NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs"; // Prisma's pg driver adapter needs Node, not edge

const PATCHABLE_FIELDS = [
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
  if (!(await getSessionUserFromRequest(request))) {
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
  } catch {
    return NextResponse.json({ ok: false, error: "term not found" }, { status: 404 });
  }
}
