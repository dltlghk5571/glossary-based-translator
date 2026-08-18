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

// `overrides` always wins over client-supplied fields -- used to force
// translate-flow suggestions to "pending_reference"/"translation_flow"
// regardless of what the request body claims.
export function buildGlossaryUpsertData(
  body: Record<string, unknown>,
  overrides: Partial<Pick<GlossaryUpsertData, "status" | "source">> = {}
): GlossaryUpsertData {
  return {
    english: String(body.english ?? "").trim(),
    description: (body.description as string) ?? undefined,
    category: (body.category as string) ?? undefined,
    type: (body.type as string) || "General",
    aliases: (body.aliases as string) || "",
    usageNote: (body.usageNote as string) || "",
    status: overrides.status ?? ((body.status as string) || "approved"),
    source: overrides.source ?? ((body.source as string) || "user"),
    lastContext: (body.lastContext as string) || "",
  };
}
