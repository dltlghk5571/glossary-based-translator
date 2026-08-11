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
