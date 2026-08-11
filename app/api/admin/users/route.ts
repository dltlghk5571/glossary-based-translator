import { NextRequest, NextResponse } from "next/server";
import { generatePassword, getSessionUserFromRequest, hashPassword } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // session-cookie-dependent response -- never let Vercel/Next cache this across users

async function requireAdmin(request: NextRequest) {
  const user = await getSessionUserFromRequest(request);
  return user && user.role === "admin" ? user : null;
}

export async function GET(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const users = await prisma.user.findMany({
    select: { id: true, username: true, role: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ ok: true, users });
}

export async function POST(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const username = (body.username || "").trim();
  if (!username) {
    return NextResponse.json({ ok: false, error: "username is required" }, { status: 400 });
  }
  const role = body.role === "admin" ? "admin" : "user";
  const password = (body.password || "").trim() || generatePassword();

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    return NextResponse.json({ ok: false, error: "username already exists" }, { status: 409 });
  }

  const user = await prisma.user.create({
    data: { username, role, passwordHash: await hashPassword(password) },
    select: { id: true, username: true, role: true, createdAt: true },
  });

  return NextResponse.json({ ok: true, user, password });
}
