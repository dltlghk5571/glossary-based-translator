import { NextRequest, NextResponse } from "next/server";
import { canEditGlossary, getSessionUserFromRequest } from "@/lib/auth";
import { classifyUpload } from "@/lib/glossary-import";
import { loadExistingTerms, readUploadFromForm, uploadErrorResponse } from "@/lib/glossary-import-server";

export const runtime = "nodejs"; // exceljs + Prisma need Node, not edge
export const dynamic = "force-dynamic"; // session-cookie-dependent response -- never let Vercel/Next cache this across users

// Any logged-in user may preview; nothing is written.
export async function POST(request: NextRequest) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const rows = await readUploadFromForm(await request.formData());
    const preview = classifyUpload(rows, await loadExistingTerms());
    return NextResponse.json({ ok: true, preview, canApply: canEditGlossary(user) });
  } catch (err) {
    const mapped = uploadErrorResponse(err);
    if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
    throw err;
  }
}
