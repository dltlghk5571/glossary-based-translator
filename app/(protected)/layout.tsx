import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME, getSessionUser } from "@/lib/auth";

// Runs as a Node.js Server Component (not Edge Middleware) -- Vercel's edge
// runtime has a platform-level "__dirname is not defined" bug that breaks
// ANY middleware.ts on this project (reproduced with an empty middleware
// importing nothing but next/server), so the login gate lives here instead.
export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(COOKIE_NAME)?.value;
  const user = await getSessionUser(cookie);

  if (!user) {
    redirect("/login");
  }

  return <>{children}</>;
}
