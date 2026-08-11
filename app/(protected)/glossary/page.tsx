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
    <main>
      <h1>Glossary</h1>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load()}
          placeholder="Search ko/en/aliases"
        />
        <button onClick={load}>Search</button>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="approved">approved</option>
          <option value="pending_reference">pending_reference</option>
          <option value="deprecated">deprecated</option>
        </select>
        <button
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

      {loading && <p>Loading...</p>}
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {!loading && !error && <TermTable terms={terms} onChanged={handleChanged} />}
    </main>
  );
}
