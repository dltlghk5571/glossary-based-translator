import { NextRequest, NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const existing = await prisma.tokenTopUpRequest.findFirst({
    where: { userId: user.id, status: "pending" },
  });
  if (existing) {
    return NextResponse.json({ ok: false, error: "이미 대기 중인 요청이 있습니다." }, { status: 409 });
  }

  const body = await request.json().catch(() => ({}));
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";

  const topUp = await prisma.tokenTopUpRequest.create({
    data: { userId: user.id, note },
  });

  return NextResponse.json({ ok: true, topUp });
}
