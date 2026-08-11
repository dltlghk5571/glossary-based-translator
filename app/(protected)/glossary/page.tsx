import { cookies } from "next/headers";
import { COOKIE_NAME, canEditGlossary, getSessionUser } from "@/lib/auth";
import GlossaryClient from "@/components/GlossaryClient";

export default async function GlossaryPage() {
  const cookieStore = await cookies();
  const user = await getSessionUser(cookieStore.get(COOKIE_NAME)?.value);
  return <GlossaryClient canEdit={canEditGlossary(user)} />;
}
