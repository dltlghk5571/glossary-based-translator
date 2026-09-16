import { NextRequest, NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getQuotaSnapshot } from "@/lib/quota";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // session-cookie-dependent response

export async function GET(request: NextRequest) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const quota = await getQuotaSnapshot(user.id);
  const pending = await prisma.tokenTopUpRequest.findFirst({
    where: { userId: user.id, status: "pending" },
  });

  return NextResponse.json({ ok: true, ...quota, pendingRequest: !!pending });
}
