"use client";

import { useEffect, useState } from "react";
import { decideSuggestion, listSuggestions } from "@/lib/api";
import type { Decision } from "@/lib/glossary-import";
import type { SuggestionItem } from "@/lib/types";
import CollisionChoices, { typeLabel } from "@/components/CollisionChoices";

const SOURCE_LABEL: Record<SuggestionItem["source"], string> = { excel: "엑셀", translation_flow: "번역 중 제안" };

// Reviewer-only list of pending suggestions. `reloadKey` changes whenever the
// parent wants a refresh (e.g. after an upload); `onDecided` lets it reload terms.
export default function SuggestionBox({ reloadKey, onDecided }: { reloadKey: number; onDecided: () => void }) {
  const [items, setItems] = useState<SuggestionItem[]>([]);
  const [decisions, setDecisions] = useState<Record<number, Record<string, Decision>>>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function load() {
    try {
      setItems((await listSuggestions()).suggestions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "제안함을 불러오지 못했습니다");
    }
  }

  useEffect(() => {
    load();
  }, [reloadKey]);

  async function decide(item: SuggestionItem, action: "accept" | "reject") {
    setBusyId(item.id);
    setError("");
    try {
      await decideSuggestion(item.id, action, decisions[item.id]);
      await load();
      onDecided();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg === "surface_conflict" ? "다른 사람이 방금 용어집을 바꿨습니다. 다시 확인해주세요" : msg);
      await load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="card" style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0, fontSize: 15 }}>제안함 ({items.length})</h2>
      {error && <p className="error-text">{error}</p>}
      {items.length === 0 && <p className="hint">검토할 제안이 없습니다.</p>}
      <div style={{ display: "grid", gap: 14 }}>
        {items.map((item) => {
          const overlapping = item.collisions.length > 0;
          return (
            <div key={item.id}>
              <div>
                <strong>{item.korean}</strong> → {item.english}{" "}
                <span className="hint">
                  ({typeLabel(item.type)}
                  {item.aliases && `, 다른 표기: ${item.aliases}`}) · {item.username} ·{" "}
                  {new Date(item.createdAt).toLocaleDateString("ko-KR")} · {SOURCE_LABEL[item.source]}
                </span>
              </div>
              {overlapping && (
                <CollisionChoices
                  incoming={item}
                  collisions={item.collisions}
                  existing={item.existing}
                  decisions={decisions[item.id] ?? {}}
                  onChange={(key, d) => setDecisions((prev) => ({ ...prev, [item.id]: { ...prev[item.id], [key]: d } }))}
                  incomingName="제안"
                />
              )}
              <div className="btn-row" style={{ marginTop: 6 }}>
                <button className="btn btn-sm btn-primary" disabled={busyId === item.id} onClick={() => decide(item, "accept")}>
                  {overlapping ? "반영" : "승인"}
                </button>
                <button className="btn btn-sm btn-danger" disabled={busyId === item.id} onClick={() => decide(item, "reject")}>
                  거절
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
