// Integration test for the glossary approve/suggest regression (see
// lib/glossary.test.ts for the pure-logic unit tests). This spins up a real
// `next dev` server and hits it over HTTP with forged session cookies. All
// rows are prefixed "__itest_" and deleted in `after`, but this still runs
// real writes against a real Postgres -- it MUST run against a dedicated
// test database, never DATABASE_URL (dev/prod). See README.md "Tests".
//
// Run with: node --env-file=.env --test test/glossary-flow.integration.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Client } from "pg";

const PORT = 39217;
const BASE_URL = `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL is required for integration tests. Refusing to write to DATABASE_URL.");
}
if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set -- run with `node --env-file=.env --test test/glossary-flow.integration.test.ts`");
}

function sessionCookie(userId: number): string {
  const sig = createHmac("sha256", SESSION_SECRET as string).update(String(userId)).digest("hex");
  return `session=${userId}.${sig}`;
}

let server: ChildProcessWithoutNullStreams;
let serverOutput = "";
let db: Client;
const testUserIds: number[] = [];
const testTerms: string[] = [];

async function createUser(role: string): Promise<{ id: number }> {
  const username = `__itest_${role}_${randomUUID()}`;
  const { rows } = await db.query(
    `INSERT INTO "User" (username, "passwordHash", role, "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`,
    [username, "unused", role]
  );
  const id = rows[0].id as number;
  testUserIds.push(id);
  return { id };
}

async function waitForServer(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE_URL}/login`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`dev server did not become ready in time. Output so far:\n${serverOutput}`);
}

before(async () => {
  db = new Client({ connectionString: TEST_DATABASE_URL });
  await db.connect();

  // lib/prisma.ts (the app's own DB client) only ever reads DATABASE_URL --
  // override it here so the server under test writes to TEST_DATABASE_URL too,
  // regardless of whatever DATABASE_URL is set to in the parent environment.
  server = spawn("npx", ["--no-install", "next", "dev", "-p", String(PORT)], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
  server.stdout.on("data", (d) => (serverOutput += d.toString()));
  server.stderr.on("data", (d) => (serverOutput += d.toString()));
  await waitForServer();
});

after(async () => {
  if (testTerms.length) {
    await db.query(`DELETE FROM "Glossary" WHERE korean = ANY($1)`, [testTerms]);
  }
  if (testUserIds.length) {
    await db.query(`DELETE FROM "User" WHERE id = ANY($1)`, [testUserIds]);
  }
  await db.end();
  server.kill();
});

test("suggest: 'user' role can submit a missing term, but it always lands as pending_reference/translation_flow", async () => {
  const user = await createUser("user");
  const korean = `__itest_term_${randomUUID()}`;
  testTerms.push(korean);

  const res = await fetch(`${BASE_URL}/api/glossary/suggest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: sessionCookie(user.id) },
    body: JSON.stringify({ korean, english: "Foo", status: "approved", source: "admin" }),
  });
  assert.equal(res.status, 200, await res.text());

  const { rows } = await db.query(`SELECT status, source FROM "Glossary" WHERE korean = $1`, [korean]);
  assert.equal(rows[0].status, "pending_reference");
  assert.equal(rows[0].source, "translation_flow");
});

test("suggest: anonymous request is rejected with 401 and nothing is written", async () => {
  const korean = `__itest_term_${randomUUID()}`;

  const res = await fetch(`${BASE_URL}/api/glossary/suggest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ korean, english: "Foo" }),
  });
  assert.equal(res.status, 401);

  const { rows } = await db.query(`SELECT 1 FROM "Glossary" WHERE korean = $1`, [korean]);
  assert.equal(rows.length, 0);
});

test("approve: 'user' role is rejected with 401 and nothing is written -- the original regression", async () => {
  const user = await createUser("user");
  const korean = `__itest_term_${randomUUID()}`;

  const res = await fetch(`${BASE_URL}/api/glossary/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: sessionCookie(user.id) },
    body: JSON.stringify({ korean, english: "Foo", status: "approved" }),
  });
  assert.equal(res.status, 401);

  const { rows } = await db.query(`SELECT 1 FROM "Glossary" WHERE korean = $1`, [korean]);
  assert.equal(rows.length, 0);
});

test("approve: 'editor' role can set status to approved directly", async () => {
  const editor = await createUser("editor");
  const korean = `__itest_term_${randomUUID()}`;
  testTerms.push(korean);

  const res = await fetch(`${BASE_URL}/api/glossary/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: sessionCookie(editor.id) },
    body: JSON.stringify({ korean, english: "Foo", status: "approved" }),
  });
  assert.equal(res.status, 200, await res.text());

  const { rows } = await db.query(`SELECT status, source FROM "Glossary" WHERE korean = $1`, [korean]);
  assert.equal(rows[0].status, "approved");
});

test("approve: 'admin' role can set status to approved directly", async () => {
  const admin = await createUser("admin");
  const korean = `__itest_term_${randomUUID()}`;
  testTerms.push(korean);

  const res = await fetch(`${BASE_URL}/api/glossary/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: sessionCookie(admin.id) },
    body: JSON.stringify({ korean, english: "Foo", status: "approved" }),
  });
  assert.equal(res.status, 200, await res.text());

  const { rows } = await db.query(`SELECT status FROM "Glossary" WHERE korean = $1`, [korean]);
  assert.equal(rows[0].status, "approved");
});
