import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, createHmac } from "crypto";
import { promisify } from "util";
import { prisma } from "./prisma";

const scrypt = promisify(scryptCb);

export const COOKIE_NAME = "session";

// -- Password hashing (scrypt, Node's built-in KDF -- no bcrypt dependency needed) --

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hashHex] = stored.split(":");
  if (!salt || !hashHex) return false;
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hashHex, "hex");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// Admin-created passwords only need to be readable once at creation time, not memorable.
export function generatePassword(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

// -- Sessions: `${userId}.${hmac}` cookie, verified against SESSION_SECRET, user looked up fresh from DB --

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET environment variable is not set.");
  return secret;
}

function sign(userId: number): string {
  return createHmac("sha256", sessionSecret()).update(String(userId)).digest("hex");
}

export function sessionCookieValue(userId: number): string {
  return `${userId}.${sign(userId)}`;
}

function verifiedUserId(cookieValue: string | undefined): number | null {
  if (!cookieValue) return null;
  const [idPart, sig] = cookieValue.split(".");
  if (!idPart || !sig) return null;
  const userId = Number(idPart);
  if (!Number.isInteger(userId)) return null;
  const expected = sign(userId);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return userId;
}

export type SessionUser = { id: number; username: string; role: string };

export async function getSessionUser(cookieValue: string | undefined): Promise<SessionUser | null> {
  const userId = verifiedUserId(cookieValue);
  if (userId === null) return null;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, role: true } });
  return user;
}

export async function getSessionUserFromRequest(request: Request): Promise<SessionUser | null> {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return getSessionUser(match?.[1]);
}
