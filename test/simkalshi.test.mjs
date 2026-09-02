// Tests for lib/simkalshi.mjs — real book odds in, simulated Kalshi out.
import test from "node:test";
import assert from "node:assert/strict";
import { buildSimFixture, buildSimCard } from "../lib/simkalshi.mjs";
import { analyzeCard, confirmCard } from "../lib/engine.mjs";

// Real-shaped Odds API events (h2h + totals + spreads).
const mlbBook = (key, a, h, tp, tot, sp) => ({
  key, markets: [
    { key: "h2h", outcomes: [{ name: a, price: -150 }, { name: h, price: 130 }] },
    { key: "totals", outcomes: [{ name: "Over", price: -110, point: tp }, { name: "Under", price: -110, point: tp }] },
    { key: "spreads", outcomes: [{ name: a, price: 130, point: -1.5 }, { name: h, price: -150, point: 1.5 }] },
  ],
});
const mlbEvent = (id, away, home) => ({
  id, commence_time: "2026-09-10T23:00:00Z", home_team: home, away_team: away,
  bookmakers: [mlbBook("pinnacle", away, home, 8.5), mlbBook("draftkings", away, home, 8.5), mlbBook("fanduel", away, home, 8.5)],
});

test("buildSimFixture: real books + simulated Kalshi orderbooks", () => {
  const f = buildSimFixture("mlb", mlbEvent("g1", "Dodgers", "Braves"), "mlb");
  assert.ok(f);
  assert.equal(f.markets.length, 3);
  for (const m of f.markets) {
    assert.ok(m.books.pinnacle, "real book quote present");
    const k = m.kalshi;
    const has = k.a?.ask != null || k.home?.ask != null;
    assert.ok(has, "simulated Kalshi ask present");
  }
});

test("simulated price is DETERMINISTIC (stable across polls)", () => {
  const a = buildSimFixture("mlb", mlbEvent("g1", "Dodgers", "Braves"), "mlb");
  const b = buildSimFixture("mlb", mlbEvent("g1", "Dodgers", "Braves"), "mlb");
  assert.equal(a.markets[0].kalshi.a.ask, b.markets[0].kalshi.a.ask);
  assert.equal(a.markets[0].kalshi.a.bid, b.markets[0].kalshi.a.bid);
});

test("simulated Kalshi sits near the book consensus (not arbitrary)", () => {
  const f = buildSimFixture("mlb", mlbEvent("g1", "Dodgers", "Braves"), "mlb");
  const ml = f.markets.find(m => m.key === "ml");
  // away (Dodgers) de-vigged fair ≈ 0.6; the sim ask should be within ~15 pts.
  const ask = ml.kalshi.a.ask;
  assert.ok(ask > 0.4 && ask < 0.8, `sim ask ${ask} is in a sane band`);
});

test("across a slate, SIM produces at least one gradeable TRADE", () => {
  const comp = { sport: "mlb", key: "mlb" };
  const events = [
    mlbEvent("g1", "Dodgers", "Braves"), mlbEvent("g2", "Yankees", "Astros"),
    mlbEvent("g3", "Padres", "Reds"), mlbEvent("g4", "Mets", "Cubs"),
    mlbEvent("g5", "Rays", "Jays"), mlbEvent("g6", "Sox", "Angels"),
  ];
  const card = buildSimCard(comp, events);
  assert.equal(card.source, "sim");
  assert.equal(card.fights.length, 6);
  const { confirmed } = confirmCard(analyzeCard(card, {}, Date.now()));
  assert.ok(confirmed.length >= 1, "SIM offset yields real, gate-clearing edges");
  // Every confirmed play carries the full decision record.
  for (const e of confirmed) {
    assert.ok(e.netReturn >= 0.03, "net EV clears the gate");
    assert.ok(e.conservativeProb > e.execPrice, "conservative prob beats the ask");
  }
});

test("soccer SIM omits BTTS (no book basis) but keeps 1X2 + O/U", () => {
  const soccerBook = key => ({
    key, markets: [
      { key: "h2h", outcomes: [{ name: "Arsenal", price: -140 }, { name: "Draw", price: 260 }, { name: "Chelsea", price: 380 }] },
      { key: "totals", outcomes: [{ name: "Over", price: -120, point: 2.5 }, { name: "Under", price: 100, point: 2.5 }] },
    ],
  });
  const ev = { id: "s1", commence_time: "2026-09-10T16:00:00Z", home_team: "Arsenal", away_team: "Chelsea", bookmakers: [soccerBook("pinnacle"), soccerBook("draftkings"), soccerBook("fanduel")] };
  const f = buildSimFixture("mls", ev, "epl");
  assert.ok(f);
  const keys = f.markets.map(m => m.key);
  assert.ok(keys.includes("match") && keys.includes("ou"));
  assert.ok(!keys.includes("btts"), "no fabricated BTTS market");
});
