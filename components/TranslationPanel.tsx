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
    <section className="card" style={{ marginTop: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>Translation</h2>
        <button className="btn btn-sm" onClick={copyOutput}>
          {copied ? "Copied!" : "Copy output"}
        </button>
      </div>
      <pre className="output-block">{result.translation}</pre>

      {result.warnings.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <h3 style={{ fontSize: 13, margin: "0 0 6px", color: "var(--warning)" }}>Warnings</h3>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {result.warnings.map((w, i) => (
              <li key={i} style={{ color: "var(--warning)", fontSize: 14 }}>
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.audit_report.violations.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <h3 style={{ fontSize: 13, margin: "0 0 6px", color: "var(--danger)" }}>Glossary Violations</h3>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {result.audit_report.violations.map((v, i) => (
              <li key={i} style={{ color: "var(--danger)", fontSize: 14 }}>
                [{v.ko_term || "?"}] {v.issue} (expected: {v.required_en_term || "-"}, found: {v.found || "-"})
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
