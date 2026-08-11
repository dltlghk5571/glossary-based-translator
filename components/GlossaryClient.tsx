"use client";

import { useEffect, useState } from "react";
import { approveTerm, listGlossary } from "@/lib/api";
import type { GlossaryTerm } from "@/lib/types";
import TermTable from "@/components/TermTable";

const TYPES = ["General", "Organization", "Regulation", "Role/Position", "Election", "Finance", "Meeting/Procedure", "Academic"];

function emptyNewTerm() {
  return { korean: "", english: "", type: "General", aliases: "", status: "approved" };
}

export default function GlossaryClient({ canEdit }: { canEdit: boolean }) {
  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [newTerm, setNewTerm] = useState(emptyNewTerm());
  const [adding, setAdding] = useState(false);

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

  function handleDeleted(id: number) {
    setTerms((prev) => prev.filter((t) => t.id !== id));
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newTerm.korean.trim() || !newTerm.english.trim()) return;
    setAdding(true);
    setError("");
    try {
      await approveTerm({
        korean: newTerm.korean.trim(),
        english: newTerm.english.trim(),
        type: newTerm.type,
        aliases: newTerm.aliases.trim(),
        status: newTerm.status,
        source: "user",
      });
      setNewTerm(emptyNewTerm());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add term");
    } finally {
      setAdding(false);
    }
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
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && load()}
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

      {canEdit && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2 style={{ marginTop: 0, fontSize: 15 }}>새 용어 추가</h2>
          <form onSubmit={handleAdd}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label className="field" style={{ marginBottom: 0 }}>
                <span>Korean</span>
                <input value={newTerm.korean} onChange={(e) => setNewTerm((t) => ({ ...t, korean: e.target.value }))} />
              </label>
              <label className="field" style={{ marginBottom: 0 }}>
                <span>English</span>
                <input value={newTerm.english} onChange={(e) => setNewTerm((t) => ({ ...t, english: e.target.value }))} />
              </label>
              <label className="field" style={{ marginBottom: 0 }}>
                <span>Type</span>
                <select value={newTerm.type} onChange={(e) => setNewTerm((t) => ({ ...t, type: e.target.value }))}>
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field" style={{ marginBottom: 0 }}>
                <span>Aliases</span>
                <input
                  value={newTerm.aliases}
                  onChange={(e) => setNewTerm((t) => ({ ...t, aliases: e.target.value }))}
                  placeholder="comma,separated"
                />
              </label>
              <label className="field" style={{ marginBottom: 0 }}>
                <span>Status</span>
                <select value={newTerm.status} onChange={(e) => setNewTerm((t) => ({ ...t, status: e.target.value }))}>
                  <option value="approved">approved</option>
                  <option value="pending_reference">pending_reference</option>
                  <option value="deprecated">deprecated</option>
                </select>
              </label>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={adding || !newTerm.korean.trim() || !newTerm.english.trim()}
              >
                {adding ? "Adding..." : "Add"}
              </button>
            </div>
          </form>
        </section>
      )}

      {error && <p className="error-text">{error}</p>}

      <section className="card" style={{ marginTop: 16 }}>
        {loading ? (
          <p className="hint">Loading...</p>
        ) : (
          <TermTable terms={terms} canEdit={canEdit} onChanged={handleChanged} onDeleted={handleDeleted} />
        )}
      </section>
    </main>
  );
}
