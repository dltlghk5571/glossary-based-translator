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
import ExcelJS from "exceljs";
import { readUploadRows } from "../lib/glossary-excel.ts";

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

// ---- Excel upload (template / preview / apply) ----

type Cells = [string, string, string?, string?, string?];

async function xlsx(rows: Cells[]): Promise<Blob> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("용어집");
  ws.addRow(["한국어 용어", "영어 번역", "분류", "다른 표기", "사용 메모"]);
  for (const r of rows) ws.addRow(r);
  return new Blob([await wb.xlsx.writeBuffer()]);
}

function itestTerm(): string {
  const korean = `__itest_term_${randomUUID()}`;
  testTerms.push(korean);
  return korean;
}

async function upload(path: "preview" | "apply", userId: number, file: Blob, decisions: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", file, "upload.xlsx");
  form.set("decisions", JSON.stringify(decisions));
  const res = await fetch(`${BASE_URL}/api/glossary/import/${path}`, {
    method: "POST",
    headers: { Cookie: sessionCookie(userId) },
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

async function insertTerm(korean: string, english: string, aliases = "") {
  const { rows } = await db.query(
    `INSERT INTO "Glossary" (korean, english, aliases, status, source, "updatedAt") VALUES ($1, $2, $3, 'approved', 'user', now()) RETURNING id`,
    [korean, english, aliases]
  );
  return rows[0].id as number;
}

async function glossaryRow(korean: string) {
  const { rows } = await db.query(`SELECT english, aliases, type, status, source FROM "Glossary" WHERE korean = $1`, [korean]);
  return rows[0];
}

test("template: any user downloads the xlsx; anonymous gets 401", async () => {
  const user = await createUser("user");
  const res = await fetch(`${BASE_URL}/api/glossary/template`, { headers: { Cookie: sessionCookie(user.id) } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") || "", /glossary_template\.xlsx/);
  const rows = await readUploadRows(Buffer.from(await res.arrayBuffer()));
  assert.equal(rows.length, 3);

  const anon = await fetch(`${BASE_URL}/api/glossary/template`);
  assert.equal(anon.status, 401);
});

test("preview: buckets rows and writes nothing", async () => {
  const editor = await createUser("editor");
  const fresh = itestTerm();
  const existing = itestTerm();
  await insertTerm(existing, "Old");

  const { status, body } = await upload("preview", editor.id, await xlsx([[fresh, "New"], [existing, "Changed"], [itestTerm(), ""]]));
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.canApply, true);
  assert.deepEqual(body.preview.newRows.map((r: { korean: string }) => r.korean), [fresh]);
  assert.deepEqual(body.preview.overlaps.map((o: { row: { korean: string } }) => o.row.korean), [existing]);
  assert.equal(body.preview.problems.length, 1);
  assert.equal(await glossaryRow(fresh), undefined);
  assert.equal((await glossaryRow(existing)).english, "Old");
});

test("preview: an unreadable file is a 400 with its error code", async () => {
  const editor = await createUser("editor");
  const { status, body } = await upload("preview", editor.id, new Blob(["not a zip"]));
  assert.equal(status, 400);
  assert.equal(body.error, "unreadable");
});

test("apply (reviewer): adds new terms approved, keeps overlaps by default", async () => {
  const editor = await createUser("editor");
  const fresh = itestTerm();
  const existing = itestTerm();
  await insertTerm(existing, "Old");

  const { status, body } = await upload("apply", editor.id, await xlsx([[fresh, "New"], [existing, "Changed"], [itestTerm(), ""]]));
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.mode, "applied");
  assert.deepEqual(body.counts, { added: 1, replaced: 0, kept: 1, excluded: 1 });
  assert.deepEqual(await glossaryRow(fresh), { english: "New", aliases: "", type: "General", status: "approved", source: "excel" });
  assert.equal((await glossaryRow(existing)).english, "Old");
});

test("apply (reviewer): replace updates english and keeps aliases the file left blank", async () => {
  const editor = await createUser("editor");
  const existing = itestTerm();
  const id = await insertTerm(existing, "Old", "기존표기");

  const { body } = await upload("apply", editor.id, await xlsx([[existing, "Changed"]]), { [`${id}:${existing}`]: "replace" });
  assert.deepEqual(body.counts, { added: 0, replaced: 1, kept: 0, excluded: 0 });
  const after = await glossaryRow(existing);
  assert.equal(after.english, "Changed");
  assert.equal(after.aliases, "기존표기");
});

test("apply (reviewer): a term added after preview is kept, not overwritten", async () => {
  const editor = await createUser("editor");
  const korean = itestTerm();
  const file = await xlsx([[korean, "From file"]]);
  const preview = await upload("preview", editor.id, file);
  assert.equal(preview.body.preview.newRows.length, 1);

  await insertTerm(korean, "Approved meanwhile");
  const { body } = await upload("apply", editor.id, file);
  assert.deepEqual(body.counts, { added: 0, replaced: 0, kept: 1, excluded: 0 });
  assert.equal((await glossaryRow(korean)).english, "Approved meanwhile");
});

test("apply (user): only creates pending suggestions, deduped per user on re-upload", async () => {
  const user = await createUser("user");
  const fresh = itestTerm();
  const existing = itestTerm();
  const id = await insertTerm(existing, "Old");
  const file = await xlsx([[fresh, "New"], [existing, "Changed"]]);

  const first = await upload("apply", user.id, file, { [`${id}:${existing}`]: "replace" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body, { ok: true, mode: "suggested", counts: { suggested: 2, excluded: 0 } });
  await upload("apply", user.id, file);

  assert.equal(await glossaryRow(fresh), undefined);
  assert.equal((await glossaryRow(existing)).english, "Old");
  const { rows } = await db.query(
    `SELECT korean, source, status FROM "GlossarySuggestion" WHERE "userId" = $1 ORDER BY korean`,
    [user.id]
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.source === "excel" && r.status === "pending"));
});
