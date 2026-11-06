import type { Collision, ExistingTerm, UploadPreview } from "./glossary-import";

export type CandidateTerm = {
  ko_term: string;
  type?: string;
  reason?: string;
  context_sentence?: string;
  suggested_translation?: string;
  priority?: "high" | "medium" | "low";
};

export type MatchedTerm = {
  ko_term: string;
  en_term: string;
  matched_text: string;
  start: number;
  end: number;
  matched_via: "ko_term" | "alias";
};

export type AnalyzeResult = {
  candidate_terms: CandidateTerm[];
  matched_terms: MatchedTerm[];
  missing_terms: CandidateTerm[];
  warnings: string[];
};

export type AuditViolation = {
  ko_term: string;
  required_en_term: string;
  found: string;
  issue: string;
};

export type AuditReport = {
  has_violation: boolean;
  violations: AuditViolation[];
  format_warnings: string[];
};

export type TranslateResult = {
  translation: string;
  audit_report: AuditReport;
  warnings: string[];
};

export type GlossaryTerm = {
  id: number;
  korean: string;
  english: string;
  description: string | null;
  category: string | null;
  type: string;
  aliases: string;
  usageNote: string;
  status: string;
  source: string;
  lastContext: string;
};

export type GlossaryStatus = "approved" | "pending_reference" | "deprecated";

export type QuotaInfo = {
  limit: number;
  used: number;
  bonus: number;
  remaining: number;
  pendingRequest: boolean;
};

export type OrgQuota = {
  id: number;
  username: string;
  monthlyTokenLimit: number;
  tokensUsedThisPeriod: number;
  bonusTokens: number;
};

export type TranslationHistoryEntry = {
  id: number;
  sourceText: string;
  translatedText: string;
  createdAt: string;
};

export type TopUpRequest = {
  id: number;
  userId: number;
  status: string;
  grantedTokens: number | null;
  note: string;
  createdAt: string;
  user: { username: string };
};

// Preview overlaps carry the existing terms they collide with, so the UI can
// show existing vs uploaded values side by side.
export type UploadPreviewResponse = {
  ok: true;
  preview: Omit<UploadPreview, "overlaps"> & { overlaps: (UploadPreview["overlaps"][number] & { existing: ExistingTerm[] })[] };
  canApply: boolean;
};

export type SuggestionItem = {
  id: number;
  korean: string;
  english: string;
  type: string;
  aliases: string;
  usageNote: string;
  source: "excel" | "translation_flow";
  createdAt: string;
  username: string;
  collisions: Collision[];
  existing: ExistingTerm[];
};
