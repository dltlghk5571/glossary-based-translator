"use client";

import { useEffect, useState } from "react";
import { listGlossary } from "@/lib/api";
import type { GlossaryTerm } from "@/lib/types";
import TermTable from "@/components/TermTable";

export default function GlossaryPage() {
  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const { terms } = await listGlossary({ status: status || undefined, q: q || undefined });
      setTerms(terms);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load glossary");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  function handleChanged(updated: GlossaryTerm) {
    setTerms((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
  }

  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1>Glossary</h1>
          <p className="subtitle">번역 파이프라인이 강제 적용하는 공식 용어집입니다.</p>
        </div>
      </div>

      <section className="card">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()}
            placeholder="Search ko/en/aliases"
            style={{ flex: 1, minWidth: 200 }}
          />
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}>
            <option value="">All statuses</option>
            <option value="approved">approved</option>
            <option value="pending_reference">pending_reference</option>
            <option value="deprecated">deprecated</option>
          </select>
          <button className="btn" onClick={load}>
            Search
          </button>
          <button
            className="btn"
            onClick={async () => {
              const res = await fetch("/api/glossary/export", { method: "POST" });
              const blob = await res.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "glossary_export.csv";
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Export CSV
          </button>
        </div>
      </section>

      {error && <p className="error-text">{error}</p>}

      <section className="card" style={{ marginTop: 16 }}>
        {loading ? <p className="hint">Loading...</p> : <TermTable terms={terms} onChanged={handleChanged} />}
      </section>
    </main>
  );
}
