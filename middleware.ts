import { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME, isValidSessionCookie } from "./lib/auth";

export async function middleware(request: NextRequest) {
  const cookie = request.cookies.get(COOKIE_NAME)?.value;
  if (await isValidSessionCookie(cookie)) {
    return NextResponse.next();
  }
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/translate/:path*", "/glossary/:path*", "/evaluation/:path*"],
};
