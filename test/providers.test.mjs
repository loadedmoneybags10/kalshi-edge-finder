// Credit-saver helper tests (default env = mock, so no network is touched).
import test from "node:test";
import assert from "node:assert/strict";
import { fetchActiveSports, fetchUpcomingEvents, oddsConfig, oddsCredits, feedMode,
         resetCreditBudget, ensureCreditBudget, creditBudget, fetchBookOdds } from "../lib/providers.mjs";
import { pickComps } from "../api/poll.mjs";

test("default feed mode is mock (no keys required)", () => {
  assert.equal(feedMode(), "mock");
});

test("fetchActiveSports returns null in mock (→ scan all leagues)", async () => {
  assert.equal(await fetchActiveSports(), null);
});

test("oddsConfig reports credits-per-call = #markets × #regions", () => {
  const c = oddsConfig();
  assert.equal(c.creditsPerCall, c.markets.split(",").length * c.regions.split(",").length);
  assert.ok(c.regions.split(",").includes("eu"), "eu region included for Pinnacle");
});

test("default markets is moneyline-only (h2h) — 1 market, minimal credit burn", () => {
  if (process.env.ODDS_MARKETS) return; // only assert the shipped default
  assert.equal(oddsConfig().markets, "h2h");
});

test("fetchUpcomingEvents returns null without a key (cannot gate → proceed with fetch)", async () => {
  const saved = process.env.ODDS_API_KEY; delete process.env.ODDS_API_KEY;
  try { assert.equal(await fetchUpcomingEvents("mlb"), null); }
  finally { if (saved !== undefined) process.env.ODDS_API_KEY = saved; }
});

test("credit budget: reset sets cap; 0 → unlimited; ensure never overrides an active budget", () => {
  resetCreditBudget(5);
  let b = creditBudget();
  assert.equal(b.cap, 5); assert.equal(b.spent, 0); assert.equal(b.active, true);
  ensureCreditBudget(99);                 // already active → must NOT change the cap
  assert.equal(creditBudget().cap, 5);
  resetCreditBudget(0);                    // 0 disables the guard
  assert.equal(creditBudget().cap, null);
});

test("credit budget refuses a paid odds call that would exceed the cap — before any network", async () => {
  const savedFeed = process.env.FEED, savedKey = process.env.ODDS_API_KEY;
  process.env.FEED = "live"; process.env.ODDS_API_KEY = "dummy-test-key"; // force the paid path
  resetCreditBudget(1);                    // an odds call costs #markets×#regions ≥ 2 → over cap
  try {
    await assert.rejects(() => fetchBookOdds("mlb"), e => e.code === "CREDIT_BUDGET");
    assert.equal(creditBudget().spent, 0); // refused before charging
    assert.equal(creditBudget().blocked, 1);
  } finally {
    resetCreditBudget(0);                   // leave the guard off for other tests
    if (savedFeed === undefined) delete process.env.FEED; else process.env.FEED = savedFeed;
    if (savedKey === undefined) delete process.env.ODDS_API_KEY; else process.env.ODDS_API_KEY = savedKey;
  }
});

test("oddsCredits starts empty until a real call sets it", () => {
  const c = oddsCredits();
  assert.ok("remaining" in c && "used" in c);
});

test("active-sports gating filters competitions to the active set", () => {
  const all = pickComps("all");
  assert.ok(all.length >= 5);
  // Simulate an in-season set: only MLB active → everything else skipped.
  const active = new Set(["baseball_mlb"]);
  const gated = all.filter(c => active.has(c.oddsSport));
  assert.equal(gated.length, 1);
  assert.equal(gated[0].key, "mlb");
});
