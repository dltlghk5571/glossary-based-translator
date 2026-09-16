import { NextRequest, NextResponse } from "next/server";
import { generatePassword, getSessionUserFromRequest, hashPassword } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // session-cookie-dependent response -- never let Vercel/Next cache this across users

async function requireAdmin(request: NextRequest) {
  const user = await getSessionUserFromRequest(request);
  return user && user.role === "admin" ? user : null;
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const id = Number.parseInt((await params).id, 10);
  if (Number.isNaN(id)) {
    return NextResponse.json({ ok: false, error: "invalid user id" }, { status: 400 });
  }
  if (id === admin.id) {
    return NextResponse.json({ ok: false, error: "cannot delete your own account" }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    return NextResponse.json({ ok: false, error: "user not found" }, { status: 404 });
  }
  if (target.role === "admin") {
    const adminCount = await prisma.user.count({ where: { role: "admin" } });
    if (adminCount <= 1) {
      return NextResponse.json({ ok: false, error: "cannot delete the last admin account" }, { status: 400 });
    }
  }

  await prisma.user.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

// Body {suspended: boolean} toggles suspension; no body (or no `suspended` key)
// resets the user's password to a freshly generated one, returned once.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const id = Number.parseInt((await params).id, 10);
  if (Number.isNaN(id)) {
    return NextResponse.json({ ok: false, error: "invalid user id" }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  if (typeof body.suspended === "boolean") {
    if (id === admin.id) {
      return NextResponse.json({ ok: false, error: "cannot suspend your own account" }, { status: 400 });
    }
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) {
      return NextResponse.json({ ok: false, error: "user not found" }, { status: 404 });
    }
    if (body.suspended && target.role === "admin") {
      const activeAdminCount = await prisma.user.count({ where: { role: "admin", suspended: false } });
      if (activeAdminCount <= 1) {
        return NextResponse.json({ ok: false, error: "cannot suspend the last active admin account" }, { status: 400 });
      }
    }
    const user = await prisma.user.update({
      where: { id },
      data: { suspended: body.suspended },
      select: { id: true, username: true, role: true, suspended: true, createdAt: true },
    });
    return NextResponse.json({ ok: true, user });
  }

  const password = generatePassword();
  try {
    const user = await prisma.user.update({
      where: { id },
      data: { passwordHash: await hashPassword(password) },
      select: { id: true, username: true, role: true },
    });
    return NextResponse.json({ ok: true, user, password });
  } catch {
    return NextResponse.json({ ok: false, error: "user not found" }, { status: 404 });
  }
}
