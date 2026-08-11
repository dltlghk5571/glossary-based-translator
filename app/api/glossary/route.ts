import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs"; // Prisma's pg driver adapter needs Node, not edge

export async function GET(request: NextRequest) {
  if (!(await isAuthorizedRequest(request))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") || undefined;
  const q = searchParams.get("q") || undefined;

  const terms = await prisma.glossary.findMany({
    where: {
      status: status || undefined,
      ...(q
        ? {
            OR: [
              { korean: { contains: q, mode: "insensitive" } },
              { english: { contains: q, mode: "insensitive" } },
              { aliases: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { korean: "asc" },
  });

  return NextResponse.json({ ok: true, terms });
}
