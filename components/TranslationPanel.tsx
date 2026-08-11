"use client";

import { useState } from "react";
import type { TranslateResult } from "@/lib/types";

export default function TranslationPanel({ result }: { result: TranslateResult }) {
  const [copied, setCopied] = useState(false);

  async function copyOutput() {
    await navigator.clipboard.writeText(result.translation);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <section style={{ marginTop: 24 }}>
      <h2>Translation</h2>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
        <button onClick={copyOutput}>{copied ? "Copied!" : "Copy output"}</button>
      </div>
      <pre
        style={{
          whiteSpace: "pre-wrap",
          background: "#f7f7f7",
          padding: 12,
          borderRadius: 4,
          border: "1px solid #ddd",
        }}
      >
        {result.translation}
      </pre>

      {result.warnings.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <h3>Warnings</h3>
          <ul>
            {result.warnings.map((w, i) => (
              <li key={i} style={{ color: "#a05a00" }}>
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.audit_report.violations.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <h3>Glossary Violations</h3>
          <ul>
            {result.audit_report.violations.map((v, i) => (
              <li key={i} style={{ color: "crimson" }}>
                [{v.ko_term || "?"}] {v.issue} (expected: {v.required_en_term || "-"}, found: {v.found || "-"})
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
