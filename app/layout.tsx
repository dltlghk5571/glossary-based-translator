import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "KAIST UA Translator Backoffice",
  description: "Glossary-controlled Korean to English translation backoffice",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>
        <nav style={{ padding: "12px 20px", borderBottom: "1px solid #ddd", display: "flex", gap: 16 }}>
          <a href="/translate">Translate</a>
          <a href="/glossary">Glossary</a>
        </nav>
        <div style={{ padding: 20 }}>{children}</div>
      </body>
    </html>
  );
}
