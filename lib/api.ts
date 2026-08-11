import type { AnalyzeResult, GlossaryTerm, TranslateResult } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    });
  } catch {
    throw new Error("서버에 연결할 수 없습니다. 네트워크 상태를 확인하고 다시 시도해주세요.");
  }

  // A failed serverless function (timeout, crash, platform-level 502/504) can
  // return an HTML error page instead of JSON -- don't let that surface as a
  // raw "Unexpected token <" parse error.
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // not JSON -- fall through, handled below
  }

  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error;
    throw new Error(message || `요청이 실패했습니다 (HTTP ${res.status}). 잠시 후 다시 시도해주세요.`);
  }
  if (data === null) {
    throw new Error("서버 응답을 처리할 수 없습니다. 잠시 후 다시 시도해주세요.");
  }
  return data as T;
}

export function analyze(text: string) {
  return request<AnalyzeResult>("/api/analyze", {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export function translate(text: string) {
  return request<TranslateResult>("/api/translate", {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export function approveTerm(term: Partial<GlossaryTerm>) {
  return request<{ ok: true; term: GlossaryTerm }>("/api/glossary/approve", {
    method: "POST",
    body: JSON.stringify(term),
  });
}

export function listGlossary(params: { status?: string; q?: string }) {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.q) query.set("q", params.q);
  return request<{ ok: true; terms: GlossaryTerm[] }>(`/api/glossary?${query.toString()}`);
}

export function updateGlossaryTerm(id: number, fields: Partial<GlossaryTerm>) {
  return request<{ ok: true; term: GlossaryTerm }>(`/api/glossary/${id}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });
}

export function deleteGlossaryTerm(id: number) {
  return request<{ ok: true }>(`/api/glossary/${id}`, { method: "DELETE" });
}
