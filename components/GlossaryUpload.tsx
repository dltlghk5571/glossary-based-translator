"use client";

import { useState } from "react";
import { applyGlossaryUpload, previewGlossaryUpload } from "@/lib/api";
import type { Decision, ProblemReason } from "@/lib/glossary-import";
import type { UploadPreviewResponse } from "@/lib/types";
import CollisionChoices, { setAll, typeLabel } from "@/components/CollisionChoices";

const REASONS: Record<ProblemReason, string> = {
  missing_korean: "한국어 용어 없음",
  missing_english: "영어 번역 없음",
  unknown_type: "알 수 없는 분류",
  duplicate_in_file: "파일 안에서 중복",
};

const ERRORS: Record<string, string> = {
  unreadable: "엑셀 파일을 읽을 수 없습니다",
  no_sheet: "'용어집' 시트가 없습니다",
  missing_header: "필수 제목(한국어 용어, 영어 번역)이 없습니다",
  too_many_rows: "한 번에 2,000행까지 올릴 수 있습니다",
  too_large: "파일은 2MB까지 올릴 수 있습니다",
  surface_conflict: "다른 사람이 방금 용어집을 바꿨습니다. 다시 미리보기 해주세요",
};

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return ERRORS[msg] ?? msg;
}

export default function GlossaryUpload({ onApplied }: { onApplied: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<UploadPreviewResponse | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");

  const allCollisions = preview?.preview.overlaps.flatMap((o) => o.collisions) ?? [];

  async function handlePreview() {
    if (!file) return;
    setBusy(true);
    setError("");
    setResult("");
    try {
      setPreview(await previewGlossaryUpload(file));
      setDecisions({});
    } catch (err) {
      setPreview(null);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleApply() {
    if (!file || !preview) return;
    setBusy(true);
    setError("");
    try {
      const res = await applyGlossaryUpload(file, preview.canApply ? decisions : {});
      setResult(
        res.mode === "applied"
          ? `추가 ${res.counts.added}개, 변경 ${res.counts.replaced}개, 기존 유지 ${res.counts.kept}개, 제외 ${res.counts.excluded}개`
          : `${res.counts.suggested}개를 검수자에게 보냈습니다 (제외 ${res.counts.excluded}개).`
      );
      setPreview(null);
      setFile(null);
      onApplied();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const p = preview?.preview;

  return (
    <section className="card" style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0, fontSize: 15 }}>엑셀로 올리기</h2>
      <p className="hint">
        <a href="/api/glossary/template" download="glossary_template.xlsx">템플릿 받기</a> — 템플릿을 채워서 올리면 저장 전에 미리보기로 확인할 수 있습니다.
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="file"
          accept=".xlsx"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setPreview(null);
            setResult("");
          }}
        />
        <button className="btn" onClick={handlePreview} disabled={!file || busy}>
          {busy && !preview ? "읽는 중..." : "미리보기"}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}
      {result && <p className="hint">{result}</p>}

      {p && preview && (
        <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
          <p style={{ margin: 0 }}>
            새 용어 {p.newRows.length} · 겹치는 용어 {p.overlaps.length} · 문제 있는 행 {p.problems.length}
          </p>

          {p.newRows.length > 0 && (
            <details>
              <summary>새 용어 {p.newRows.length}</summary>
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    {p.newRows.map((r) => (
                      <tr key={r.rowNumber}>
                        <td>{r.korean}</td>
                        <td>{r.english}</td>
                        <td>{typeLabel(r.type || "General")}</td>
                        <td>{r.aliases}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          {p.overlaps.length > 0 && (
            <div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <strong>겹치는 용어 {p.overlaps.length}</strong>
                {preview.canApply && (
                  <>
                    <button className="btn btn-sm" onClick={() => setDecisions(setAll(allCollisions, "keep"))}>
                      모두 유지
                    </button>
                    <button className="btn btn-sm" onClick={() => setDecisions(setAll(allCollisions, "replace"))}>
                      모두 바꾸기
                    </button>
                  </>
                )}
              </div>
              {!preview.canApply && <p className="hint">겹치는 용어는 검수자가 확인한 뒤에 반영됩니다.</p>}
              {p.overlaps.map((o) => (
                <div key={o.row.rowNumber} style={{ marginTop: 10 }}>
                  <div>
                    <strong>{o.row.korean}</strong> → {o.row.english} <span className="hint">({o.row.rowNumber}행)</span>
                  </div>
                  <CollisionChoices
                    incoming={o.row}
                    collisions={o.collisions}
                    existing={o.existing}
                    decisions={decisions}
                    onChange={(key, d) => setDecisions((prev) => ({ ...prev, [key]: d }))}
                    incomingName="엑셀"
                    readOnly={!preview.canApply}
                  />
                </div>
              ))}
            </div>
          )}

          {p.problems.length > 0 && (
            <div>
              <strong>문제 있는 행 {p.problems.length}</strong> <span className="hint">(반영되지 않습니다)</span>
              <ul style={{ margin: "4px 0 0" }}>
                {p.problems.map((x) => (
                  <li key={x.rowNumber}>
                    {x.rowNumber}행 {x.korean && `‘${x.korean}’`}: {x.reasons.map((r) => REASONS[r]).join(", ")}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <button
              className="btn btn-primary"
              onClick={handleApply}
              disabled={busy || p.newRows.length + p.overlaps.length === 0}
            >
              {preview.canApply ? "반영하기" : "제안 보내기"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
