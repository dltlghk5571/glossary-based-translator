import { NextRequest, NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAdmin(request: NextRequest) {
  const user = await getSessionUserFromRequest(request);
  return user && user.role === "admin" ? user : null;
}

export async function GET(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const requests = await prisma.tokenTopUpRequest.findMany({
    where: { status: "pending" },
    include: { user: { select: { username: true } } },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ ok: true, requests });
}

export async function POST(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  const action = body.action;
  if (!Number.isInteger(id) || !["approve", "deny"].includes(action)) {
    return NextResponse.json({ ok: false, error: "invalid id or action" }, { status: 400 });
  }

  const existing = await prisma.tokenTopUpRequest.findUnique({ where: { id } });
  if (!existing || existing.status !== "pending") {
    return NextResponse.json({ ok: false, error: "request not found or already resolved" }, { status: 404 });
  }

  if (action === "approve") {
    const grantedTokens = Number(body.grantedTokens);
    if (!Number.isInteger(grantedTokens) || grantedTokens <= 0) {
      return NextResponse.json({ ok: false, error: "grantedTokens must be a positive integer" }, { status: 400 });
    }
    await prisma.$transaction([
      prisma.tokenTopUpRequest.update({
        where: { id },
        data: { status: "approved", grantedTokens, resolvedAt: new Date() },
      }),
      prisma.user.update({
        where: { id: existing.userId },
        data: { bonusTokens: { increment: grantedTokens } },
      }),
    ]);
  } else {
    await prisma.tokenTopUpRequest.update({
      where: { id },
      data: { status: "denied", resolvedAt: new Date() },
    });
  }

  return NextResponse.json({ ok: true });
}
