import { NextRequest, NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/auth";
import { buildTemplate } from "@/lib/glossary-excel";
import { GLOSSARY_TYPES, TEMPLATE_EXAMPLES } from "@/lib/glossary-import";

export const runtime = "nodejs"; // exceljs + Prisma need Node, not edge
export const dynamic = "force-dynamic"; // session-cookie-dependent response -- never let Vercel/Next cache this across users

export async function GET(request: NextRequest) {
  if (!(await getSessionUserFromRequest(request))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const buf = await buildTemplate(
    GLOSSARY_TYPES.map((t) => t.label),
    [...TEMPLATE_EXAMPLES] // rowNumber is ignored by buildTemplate
  );
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="glossary_template.xlsx"',
    },
  });
}
