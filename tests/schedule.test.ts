/** The pure schedule rules in feltkit/_schedule.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRunAfter, nthRun } from "../feltkit/_schedule.js";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

test("the anchor is the first run while it is ahead", () => {
  assert.equal(iso(nextRunAfter("monthly", at("2026-11-20T14:00:00Z"), at("2026-11-17T12:00:00Z"))), "2026-11-20T14:00:00.000Z");
});

test("daily and weekly runs keep the anchor's time and never drift", () => {
  const a = at("2026-11-17T14:00:00Z");
  assert.equal(iso(nextRunAfter("daily", a, a)), "2026-11-18T14:00:00.000Z");
  assert.equal(iso(nextRunAfter("daily", a, at("2026-12-31T15:00:00Z"))), "2027-01-01T14:00:00.000Z");
  assert.equal(iso(nextRunAfter("weekly", a, at("2026-11-24T14:00:00Z"))), "2026-12-01T14:00:00.000Z");
});

test("monthly runs keep the day, clamped to short months, and return to it", () => {
  const a = at("2026-01-31T09:30:00Z");
  assert.equal(iso(nthRun("monthly", a, 1)), "2026-02-28T09:30:00.000Z");
  assert.equal(iso(nthRun("monthly", a, 2)), "2026-03-31T09:30:00.000Z");
  assert.equal(iso(nthRun("monthly", a, 13)), "2027-02-28T09:30:00.000Z");
  assert.equal(iso(nextRunAfter("monthly", a, at("2026-02-28T09:30:00Z"))), "2026-03-31T09:30:00.000Z");
  assert.equal(iso(nextRunAfter("monthly", a, at("2026-04-01T00:00:00Z"))), "2026-04-30T09:30:00.000Z");
});

test("missed runs collapse into the next one after now", () => {
  const a = at("2026-01-15T08:00:00Z");
  // The app was down from February to mid-June: one run, the next one due.
  assert.equal(iso(nextRunAfter("monthly", a, at("2026-06-20T00:00:00Z"))), "2026-07-15T08:00:00.000Z");
  for (let k = 0; k < 40; k++) {
    const after = a + k * 9 * 86_400_000 + 12345;
    const next = nextRunAfter("monthly", a, after);
    assert.ok(next > after, `next run must be after ${iso(after)}`);
    assert.ok(next - after <= 31 * 86_400_000, "and within one period");
  }
});
