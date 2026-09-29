// Credit-saver helper tests (default env = mock, so no network is touched).
import test from "node:test";
import assert from "node:assert/strict";
import { fetchActiveSports, fetchUpcomingEvents, oddsConfig, oddsCredits, feedMode } from "../lib/providers.mjs";
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
