"use client";

import { GLOSSARY_TYPES, collisionKey, type Collision, type Decision, type ExistingTerm } from "@/lib/glossary-import";

export function typeLabel(value: string): string {
  return GLOSSARY_TYPES.find((t) => t.value === value)?.label ?? value;
}

type Incoming = { korean: string; english: string; type: string; aliases: string; usageNote: string };

const FIELDS: { key: keyof Incoming; label: string }[] = [
  { key: "english", label: "영어 번역" },
  { key: "type", label: "분류" },
  { key: "aliases", label: "다른 표기" },
  { key: "usageNote", label: "사용 메모" },
];

function show(key: keyof Incoming, v: string) {
  if (!v) return <span className="hint">(없음)</span>;
  return key === "type" ? typeLabel(v) : v;
}

// One overlap: what would change, and a keep/replace choice per collision.
// `incomingName` is "엑셀" or "제안", used in the 바꾸기 label and column header.
export default function CollisionChoices({
  incoming,
  collisions,
  existing,
  decisions,
  onChange,
  incomingName,
  readOnly = false,
}: {
  incoming: Incoming;
  collisions: Collision[];
  existing: ExistingTerm[];
  decisions: Record<string, Decision>;
  onChange: (key: string, d: Decision) => void;
  incomingName: "엑셀" | "제안";
  readOnly?: boolean;
}) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {collisions.map((c) => {
        const key = collisionKey(c);
        const term = existing.find((t) => t.id === c.termId);
        const decision = decisions[key] ?? "keep";
        // Same rule as the server: blank incoming values never replace existing ones.
        const changed = term
          ? FIELDS.filter((f) => incoming[f.key] && incoming[f.key] !== (term[f.key] ?? ""))
          : [];
        return (
          <div key={key} style={{ borderLeft: "3px solid #d0d7de", paddingLeft: 10 }}>
            {c.kind === "same_term" ? (
              <>
                <p className="hint" style={{ margin: "0 0 4px" }}>이미 등록된 용어입니다.</p>
                {term && changed.length > 0 ? (
                  <table className="table">
                    <thead>
                      <tr>
                        <th></th>
                        <th>기존</th>
                        <th>{incomingName}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changed.map((f) => (
                        <tr key={f.key}>
                          <td>{f.label}</td>
                          <td>{show(f.key, term[f.key] ?? "")}</td>
                          <td>{show(f.key, incoming[f.key])}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="hint" style={{ margin: 0 }}>바뀌는 내용이 없습니다.</p>
                )}
              </>
            ) : (
              <p className="hint" style={{ margin: "0 0 4px" }}>
                &lsquo;{c.surface}&rsquo; 표기가 기존 용어 &lsquo;{c.termKorean}&rsquo;
                {term ? ` (${term.english})` : ""}와 겹칩니다.
                {!c.canReplace && " 기존 용어의 이름이라 옮길 수 없습니다."}
              </p>
            )}
            {!readOnly && (
              <div style={{ display: "flex", gap: 12 }}>
                <label>
                  <input type="radio" checked={decision === "keep"} onChange={() => onChange(key, "keep")} /> 기존 유지
                </label>
                <label style={{ opacity: c.canReplace ? 1 : 0.5 }}>
                  <input
                    type="radio"
                    disabled={!c.canReplace}
                    checked={decision === "replace"}
                    onChange={() => onChange(key, "replace")}
                  />{" "}
                  {incomingName}로 바꾸기
                </label>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function setAll(collisions: Collision[], d: Decision): Record<string, Decision> {
  return Object.fromEntries(collisions.filter((c) => d === "keep" || c.canReplace).map((c) => [collisionKey(c), d]));
}
