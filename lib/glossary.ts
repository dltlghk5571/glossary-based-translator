import type { SessionUser } from "./auth";

// Any authenticated user can suggest a term encountered while translating --
// unlike canEditGlossary(), this is not admin/editor-gated.
export function canSuggestGlossaryTerm(user: SessionUser | null): boolean {
  return !!user;
}

export type GlossaryUpsertData = {
  english: string;
  description?: string;
  category?: string;
  type: string;
  aliases: string;
  usageNote: string;
  status: string;
  source: string;
  lastContext: string;
};

// Reviewer-side add/approve (/api/glossary/approve). Translate-flow suggestions
// no longer write Glossary at all -- see app/api/glossary/suggest/route.ts.
export function buildGlossaryUpsertData(body: Record<string, unknown>): GlossaryUpsertData {
  return {
    english: String(body.english ?? "").trim(),
    description: (body.description as string) ?? undefined,
    category: (body.category as string) ?? undefined,
    type: (body.type as string) || "General",
    aliases: (body.aliases as string) || "",
    usageNote: (body.usageNote as string) || "",
    status: (body.status as string) || "approved",
    source: (body.source as string) || "user",
    lastContext: (body.lastContext as string) || "",
  };
}
