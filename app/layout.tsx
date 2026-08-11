import type { Metadata } from "next";
import { cookies } from "next/headers";
import { COOKIE_NAME, getSessionUser } from "@/lib/auth";
import LogoutButton from "@/components/LogoutButton";
import "./globals.css";

export const metadata: Metadata = {
  title: "KAIST UA Translator Backoffice",
  description: "Glossary-controlled Korean to English translation backoffice",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const user = await getSessionUser(cookieStore.get(COOKIE_NAME)?.value).catch(() => null);

  return (
    <html lang="en">
      <body>
        {user && (
          <nav className="nav">
            <span className="nav-brand">KAIST UA Translator</span>
            <a className="nav-link" href="/translate">
              Translate
            </a>
            <a className="nav-link" href="/glossary">
              Glossary
            </a>
            {user.role === "admin" && (
              <a className="nav-link" href="/admin">
                Admin
              </a>
            )}
            <span className="nav-spacer" />
            <span className="hint" style={{ marginRight: 8 }}>
              {user.username}
            </span>
            <LogoutButton />
          </nav>
        )}
        {children}
      </body>
    </html>
  );
}
