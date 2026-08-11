// Uses Web Crypto (crypto.subtle) instead of Node's "crypto" module so this
// file compiles for both the Node and Edge runtimes -- middleware.ts pulls
// this in, and `vercel dev` builds middleware for the edge runtime.
const COOKIE_NAME = "admin_session";

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sessionToken(): Promise<string> {
  return hmacHex(process.env.ADMIN_PASSWORD || "", "admin");
}

export function isValidPassword(candidate: string): boolean {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return true; // no password configured -> gate disabled (local dev)
  return timingSafeEqualStr(candidate, password);
}

export async function isValidSessionCookie(value: string | undefined): Promise<boolean> {
  if (!process.env.ADMIN_PASSWORD) return true;
  if (!value) return false;
  return timingSafeEqualStr(value, await sessionToken());
}

export async function isAuthorizedRequest(request: Request): Promise<boolean> {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return isValidSessionCookie(match?.[1]);
}

export { COOKIE_NAME, sessionToken };
