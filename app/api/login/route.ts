import { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME, isValidPassword, sessionToken } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const { password } = await request.json().catch(() => ({ password: "" }));
  if (!isValidPassword(password || "")) {
    return NextResponse.json({ ok: false, error: "Invalid password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, await sessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 12, // 12h
  });
  return res;
}
