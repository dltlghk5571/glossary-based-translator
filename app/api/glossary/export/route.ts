import { NextRequest, NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs"; // Prisma's pg driver adapter needs Node, not edge
export const dynamic = "force-dynamic"; // session-cookie-dependent response -- never let Vercel/Next cache this across users

const COLUMNS = [
  "korean",
  "english",
  "type",
  "aliases",
  "usageNote",
  "status",
  "source",
  "lastContext",
  "description",
  "category",
] as const;

function csvEscape(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function POST(request: NextRequest) {
  if (!(await getSessionUserFromRequest(request))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const terms = await prisma.glossary.findMany({ orderBy: { korean: "asc" } });
  const lines = [COLUMNS.join(",")];
  for (const term of terms) {
    lines.push(COLUMNS.map((col) => csvEscape((term as Record<string, unknown>)[col])).join(","));
  }

  return new NextResponse(lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="glossary_export.csv"',
    },
  });
}
