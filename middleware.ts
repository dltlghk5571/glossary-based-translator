import { NextRequest, NextResponse } from "next/server";

// TEMP DIAGNOSTIC: fails closed (always redirects to /login) instead of
// calling ./lib/auth, to isolate whether that import chain is what triggers
// the edge runtime's "__dirname is not defined" error in production.
export async function middleware(request: NextRequest) {
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/translate/:path*", "/glossary/:path*", "/evaluation/:path*"],
};
