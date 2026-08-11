"use client";

import { useState } from "react";
import { analyze, approveTerm, translate } from "@/lib/api";
import type { AnalyzeResult, CandidateTerm, GlossaryStatus, TranslateResult } from "@/lib/types";
import TranslationPanel from "@/components/TranslationPanel";

type MissingEdit = { en_term: string; aliases: string; status: GlossaryStatus; saved: boolean };

export default function TranslatePage() {
  const [text, setText] = useState("");
  const [analyzeResult, setAnalyzeResult] = useState<AnalyzeResult | null>(null);
  const [edits, setEdits] = useState<Record<string, MissingEdit>>({});
  const [translateResult, setTranslateResult] = useState<TranslateResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [error, setError] = useState("");

  async function handleAnalyze() {
    if (!text.trim()) return;
    setAnalyzing(true);
    setError("");
    setTranslateResult(null);
    try {
      const result = await analyze(text);
      setAnalyzeResult(result);
      const initial: Record<string, MissingEdit> = {};
      for (const t of result.missing_terms) {
        initial[t.ko_term] = {
          en_term: t.suggested_translation || "",
          aliases: "",
          status: "approved",
          saved: false,
        };
      }
      setEdits(initial);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analyze failed");
    } finally {
      setAnalyzing(false);
    }
  }

  function updateEdit(koTerm: string, field: keyof MissingEdit, value: string) {
    setEdits((prev) => ({ ...prev, [koTerm]: { ...prev[koTerm], [field]: value, saved: false } }));
  }

  async function handleSaveToGlossary() {
    if (!analyzeResult) return;
    setSaving(true);
    setError("");
    try {
      for (const term of analyzeResult.missing_terms) {
        const edit = edits[term.ko_term];
        if (!edit || !edit.en_term.trim()) continue;
        await approveTerm({
          korean: term.ko_term,
          english: edit.en_term.trim(),
          type: term.type || "General",
          aliases: edit.aliases.trim(),
          status: edit.status,
          source: "user",
          lastContext: term.context_sentence || "",
        });
        setEdits((prev) => ({ ...prev, [term.ko_term]: { ...prev[term.ko_term], saved: true } }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleTranslate() {
    if (!text.trim()) return;
    setTranslating(true);
    setError("");
    try {
      const result = await translate(text);
      setTranslateResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Translate failed");
    } finally {
      setTranslating(false);
    }
  }

  return (
    <main style={{ maxWidth: 900 }}>
      <h1>Translate</h1>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="번역할 한국어 원문을 입력하세요"
        rows={10}
        style={{ width: "100%", padding: 8, fontFamily: "inherit" }}
      />

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button onClick={handleAnalyze} disabled={analyzing || !text.trim()}>
          {analyzing ? "Analyzing..." : "Analyze terms"}
        </button>
        <button onClick={handleTranslate} disabled={translating || !text.trim()}>
          {translating ? "Translating..." : "Translate"}
        </button>
      </div>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {analyzeResult && (
        <section style={{ marginTop: 24 }}>
          <h2>Missing Glossary Terms ({analyzeResult.missing_terms.length})</h2>
          {analyzeResult.missing_terms.length === 0 ? (
            <p>No missing high-priority terms detected.</p>
          ) : (
            <>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={cellStyle}>Korean</th>
                    <th style={cellStyle}>Suggested</th>
                    <th style={cellStyle}>English (en_term)</th>
                    <th style={cellStyle}>Aliases</th>
                    <th style={cellStyle}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {analyzeResult.missing_terms.map((t: CandidateTerm) => {
                    const edit = edits[t.ko_term];
                    if (!edit) return null;
                    return (
                      <tr key={t.ko_term}>
                        <td style={cellStyle}>{t.ko_term}</td>
                        <td style={cellStyle}>{t.suggested_translation}</td>
                        <td style={cellStyle}>
                          <input
                            value={edit.en_term}
                            onChange={(e) => updateEdit(t.ko_term, "en_term", e.target.value)}
                            style={{ width: "100%" }}
                          />
                        </td>
                        <td style={cellStyle}>
                          <input
                            value={edit.aliases}
                            onChange={(e) => updateEdit(t.ko_term, "aliases", e.target.value)}
                            placeholder="comma,separated"
                            style={{ width: "100%" }}
                          />
                        </td>
                        <td style={cellStyle}>
                          <select
                            value={edit.status}
                            onChange={(e) => updateEdit(t.ko_term, "status", e.target.value)}
                          >
                            <option value="approved">approved</option>
                            <option value="pending_reference">pending_reference</option>
                            <option value="deprecated">deprecated</option>
                          </select>
                          {edit.saved && <span style={{ color: "green", marginLeft: 6 }}>saved</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <button onClick={handleSaveToGlossary} disabled={saving} style={{ marginTop: 8 }}>
                {saving ? "Saving..." : "Save to glossary"}
              </button>
            </>
          )}
        </section>
      )}

      {translateResult && <TranslationPanel result={translateResult} />}
    </main>
  );
}

const cellStyle: React.CSSProperties = { border: "1px solid #ddd", padding: 6, textAlign: "left" };
