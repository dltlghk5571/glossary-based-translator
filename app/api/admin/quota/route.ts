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
  await prisma.user.updateMany({
    where: { periodStart: { lt: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)) } },
    data: { tokensUsedThisPeriod: 0, bonusTokens: 0, periodStart: new Date() },
  });
  const orgs = await prisma.user.findMany({
    select: { id: true, username: true, monthlyTokenLimit: true, tokensUsedThisPeriod: true, bonusTokens: true },
    orderBy: { username: "asc" },
  });
  return NextResponse.json({ ok: true, orgs });
}

export async function PATCH(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const userId = Number(body.userId);
  const monthlyTokenLimit = Number(body.monthlyTokenLimit);
  if (!Number.isInteger(userId) || !Number.isInteger(monthlyTokenLimit) || monthlyTokenLimit < 0) {
    return NextResponse.json({ ok: false, error: "invalid userId or monthlyTokenLimit" }, { status: 400 });
  }

  const org = await prisma.user.update({
    where: { id: userId },
    data: { monthlyTokenLimit },
    select: { id: true, username: true, monthlyTokenLimit: true, tokensUsedThisPeriod: true, bonusTokens: true },
  });
  return NextResponse.json({ ok: true, org });
}
