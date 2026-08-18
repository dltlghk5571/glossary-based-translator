import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGlossaryUpsertData, canSuggestGlossaryTerm } from "./glossary.ts";

test("translate-flow suggestions always land as pending_reference/translation_flow, regardless of client input", () => {
  const data = buildGlossaryUpsertData(
    { english: "Foo", status: "approved", source: "admin" },
    { status: "pending_reference", source: "translation_flow" }
  );
  assert.equal(data.status, "pending_reference");
  assert.equal(data.source, "translation_flow");
});

test("glossary management (no overrides) honors client-supplied status/source, defaulting to approved/user", () => {
  const withStatus = buildGlossaryUpsertData({ english: "Foo", status: "deprecated", source: "admin" });
  assert.equal(withStatus.status, "deprecated");
  assert.equal(withStatus.source, "admin");

  const defaults = buildGlossaryUpsertData({ english: "Foo" });
  assert.equal(defaults.status, "approved");
  assert.equal(defaults.source, "user");
});

test("canSuggestGlossaryTerm allows any authenticated user, rejects anonymous", () => {
  assert.equal(canSuggestGlossaryTerm({ id: 1, username: "u", role: "user" }), true);
  assert.equal(canSuggestGlossaryTerm({ id: 2, username: "e", role: "editor" }), true);
  assert.equal(canSuggestGlossaryTerm({ id: 3, username: "a", role: "admin" }), true);
  assert.equal(canSuggestGlossaryTerm(null), false);
});

