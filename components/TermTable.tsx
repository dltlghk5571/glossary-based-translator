"use client";

import { useState } from "react";
import { updateGlossaryTerm } from "@/lib/api";
import type { GlossaryTerm } from "@/lib/types";

const cellStyle: React.CSSProperties = { border: "1px solid #ddd", padding: 6, textAlign: "left" };

export default function TermTable({
  terms,
  onChanged,
}: {
  terms: GlossaryTerm[];
  onChanged: (term: GlossaryTerm) => void;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Partial<GlossaryTerm>>({});
  const [savingId, setSavingId] = useState<number | null>(null);

  function startEdit(term: GlossaryTerm) {
    setEditingId(term.id);
    setDraft({ english: term.english, aliases: term.aliases, usageNote: term.usageNote });
  }

  async function save(term: GlossaryTerm) {
    setSavingId(term.id);
    try {
      const { term: updated } = await updateGlossaryTerm(term.id, draft);
      onChanged(updated);
      setEditingId(null);
    } finally {
      setSavingId(null);
    }
  }

  async function setStatus(term: GlossaryTerm, status: string) {
    setSavingId(term.id);
    try {
      const { term: updated } = await updateGlossaryTerm(term.id, { status });
      onChanged(updated);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={cellStyle}>Korean</th>
          <th style={cellStyle}>English</th>
          <th style={cellStyle}>Type</th>
          <th style={cellStyle}>Aliases</th>
          <th style={cellStyle}>Status</th>
          <th style={cellStyle}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {terms.map((term) => {
          const isEditing = editingId === term.id;
          return (
            <tr key={term.id}>
              <td style={cellStyle}>{term.korean}</td>
              <td style={cellStyle}>
                {isEditing ? (
                  <input
                    value={draft.english ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, english: e.target.value }))}
                    style={{ width: "100%" }}
                  />
                ) : (
                  term.english
                )}
              </td>
              <td style={cellStyle}>{term.type}</td>
              <td style={cellStyle}>
                {isEditing ? (
                  <input
                    value={draft.aliases ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, aliases: e.target.value }))}
                    style={{ width: "100%" }}
                  />
                ) : (
                  term.aliases
                )}
              </td>
              <td style={cellStyle}>{term.status}</td>
              <td style={cellStyle}>
                {isEditing ? (
                  <>
                    <button onClick={() => save(term)} disabled={savingId === term.id}>
                      Save
                    </button>{" "}
                    <button onClick={() => setEditingId(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => startEdit(term)}>Edit</button>{" "}
                    {term.status !== "approved" && (
                      <button onClick={() => setStatus(term, "approved")} disabled={savingId === term.id}>
                        Approve
                      </button>
                    )}{" "}
                    {term.status !== "deprecated" && (
                      <button onClick={() => setStatus(term, "deprecated")} disabled={savingId === term.id}>
                        Deprecate
                      </button>
                    )}
                  </>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
