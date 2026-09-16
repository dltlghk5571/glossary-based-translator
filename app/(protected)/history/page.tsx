"use client";

import { useEffect, useState } from "react";
import { listHistory } from "@/lib/api";
import type { TranslationHistoryEntry } from "@/lib/types";

function preview(text: string, len = 80) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > len ? oneLine.slice(0, len) + "…" : oneLine;
}

export default function HistoryPage() {
  const [items, setItems] = useState<TranslationHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { translations } = await listHistory();
        setItems(translations);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load history");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleCopy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 1500);
    } catch {
      setError("클립보드 복사에 실패했습니다.");
    }
  }

  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1>History</h1>
          <p className="subtitle">최근 번역 50건 — 같은 내용을 다시 번역하기 전에 확인하세요.</p>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

      {loading ? (
        <p className="hint">Loading...</p>
      ) : items.length === 0 ? (
        <p className="hint">아직 번역 이력이 없습니다.</p>
      ) : (
        items.map((item) => {
          const expanded = expandedId === item.id;
          const sourceKey = `${item.id}-source`;
          const translatedKey = `${item.id}-translated`;
          return (
            <section key={item.id} className="card" style={{ marginTop: 12 }}>
              <div
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, cursor: "pointer" }}
                onClick={() => setExpandedId(expanded ? null : item.id)}
              >
                <span>{preview(item.sourceText)}</span>
                <span className="hint" style={{ whiteSpace: "nowrap" }}>
                  {new Date(item.createdAt).toLocaleString()}
                </span>
              </div>
              {expanded && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ marginBottom: 12 }}>
                    <div className="hint" style={{ marginBottom: 4 }}>
                      원문
                    </div>
                    <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{item.sourceText}</pre>
                    <button className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => handleCopy(sourceKey, item.sourceText)}>
                      {copiedKey === sourceKey ? "복사됨" : "원문 복사"}
                    </button>
                  </div>
                  <div>
                    <div className="hint" style={{ marginBottom: 4 }}>
                      번역문
                    </div>
                    <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{item.translatedText}</pre>
                    <button
                      className="btn btn-sm btn-primary"
                      style={{ marginTop: 6 }}
                      onClick={() => handleCopy(translatedKey, item.translatedText)}
                    >
                      {copiedKey === translatedKey ? "복사됨" : "번역문 복사"}
                    </button>
                  </div>
                </div>
              )}
            </section>
          );
        })
      )}
    </main>
  );
}
