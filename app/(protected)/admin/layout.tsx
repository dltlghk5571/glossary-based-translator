import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME, getSessionUser } from "@/lib/auth";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const user = await getSessionUser(cookieStore.get(COOKIE_NAME)?.value);

  if (!user || user.role !== "admin") {
    redirect("/translate");
  }

  return <>{children}</>;
}
