import { test } from "node:test";
import assert from "node:assert/strict";
import { isSamePeriod, computeRemaining } from "./quota.ts";

test("isSamePeriod is true within the same calendar month", () => {
  assert.equal(isSamePeriod(new Date("2026-09-01T00:00:00Z"), new Date("2026-09-30T23:00:00Z")), true);
});

test("isSamePeriod is false across a month boundary", () => {
  assert.equal(isSamePeriod(new Date("2026-08-31T23:00:00Z"), new Date("2026-09-01T00:00:00Z")), false);
});

test("computeRemaining sums limit and bonus, subtracts used", () => {
  assert.equal(computeRemaining(100, 20, 50), 70);
  assert.equal(computeRemaining(100, 0, 150), -50);
});
