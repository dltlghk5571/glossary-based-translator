"use client";

import { useState } from "react";
import { updateGlossaryTerm } from "@/lib/api";
import type { GlossaryTerm } from "@/lib/types";

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

  if (terms.length === 0) {
    return <p className="hint">No terms found.</p>;
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Korean</th>
            <th>English</th>
            <th>Type</th>
            <th>Aliases</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {terms.map((term) => {
            const isEditing = editingId === term.id;
            return (
              <tr key={term.id}>
                <td>{term.korean}</td>
                <td>
                  {isEditing ? (
                    <input value={draft.english ?? ""} onChange={(e) => setDraft((d) => ({ ...d, english: e.target.value }))} />
                  ) : (
                    term.english
                  )}
                </td>
                <td className="hint">{term.type}</td>
                <td>
                  {isEditing ? (
                    <input value={draft.aliases ?? ""} onChange={(e) => setDraft((d) => ({ ...d, aliases: e.target.value }))} />
                  ) : (
                    term.aliases
                  )}
                </td>
                <td>
                  <span className={`badge badge-${term.status}`}>{term.status}</span>
                </td>
                <td>
                  {isEditing ? (
                    <div className="btn-row">
                      <button className="btn btn-sm btn-primary" onClick={() => save(term)} disabled={savingId === term.id}>
                        Save
                      </button>
                      <button className="btn btn-sm" onClick={() => setEditingId(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="btn-row">
                      <button className="btn btn-sm" onClick={() => startEdit(term)}>
                        Edit
                      </button>
                      {term.status !== "approved" && (
                        <button className="btn btn-sm" onClick={() => setStatus(term, "approved")} disabled={savingId === term.id}>
                          Approve
                        </button>
                      )}
                      {term.status !== "deprecated" && (
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => setStatus(term, "deprecated")}
                          disabled={savingId === term.id}
                        >
                          Deprecate
                        </button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
