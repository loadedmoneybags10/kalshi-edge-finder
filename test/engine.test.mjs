// Engine integration tests — placement, correlation caps, rejection reasons,
// settlement (net of fees), CLV, and migration. Drives the public API.
import test from "node:test";
import assert from "node:assert/strict";
import {
  initLedger, tryPlace, settleMarket, snapshotClose, accountStats, migrate,
  recordCandidates, REJECT, RISK_DEFAULT,
} from "../lib/engine.mjs";

// A confirmed consensus decision with sane defaults; override per test.
const dec = (o = {}) => ({
  agentId: "consensus", sport: "mlb", league: "mlb",
  fixtureId: "mlb:aaa-bbb", fixtureName: "AAA vs. BBB",
  marketKey: "ml", marketLabel: "Moneyline", marketType: "winner", marketFamily: "moneyline", line: null,
  side: "a", sideName: "AAA", oppName: "BBB", backedTeam: "AAA", opposingTeam: "BBB", direction: "team:AAA",
  execPrice: 0.50, kalshiBid: 0.48, modelProb: 0.60, consensusProb: 0.60, dispersion: 0.004, nBooks: 3,
  divergence: 0, uncertainty: 0.03, conservativeProb: 0.57,
  feePerContract: 0.0175, slipPerContract: 0.01, costPerContract: 0.5275,
  probEdgePts: 0.10, grossReturn: 0.20, netEdgePts: 0.0425, netReturn: 0.08,
  signalQuality: 90, signalFactors: {}, divergencePenalty: 1, staleness: 0, volume: 15000, spread: 0.02,
  decision: "TRADE", rejectReason: null, ...o,
});

test("tryPlace: funds a consensus trade, sizes within the single-trade cap", () => {
  const st = initLedger();
  const r = tryPlace(st, dec());
  assert.equal(r.status, "placed");
  assert.ok(r.pos.stake > 0);
  assert.ok(r.pos.stake <= st.startingBankroll * RISK_DEFAULT().maxSinglePct + 1e-9, "respects maxSinglePct");
  assert.equal(r.pos.backedTeam, "AAA");
  assert.equal(r.pos.netEv, 0.08);
});

test("tryPlace: refuses a second bet on the same market (ALREADY_BET)", () => {
  const st = initLedger();
  tryPlace(st, dec());
  const r = tryPlace(st, dec());
  assert.equal(r.status, "skip");
  assert.equal(r.code, "ALREADY_BET");
});

test("correlation: same-team second market is capped (CORRELATED_EXPOSURE)", () => {
  const st = initLedger();
  st.risk = { ...RISK_DEFAULT(), maxTeamPct: 0.02, maxCorrelatedPct: 0.02 }; // tight: first bet exhausts the team budget
  const a = tryPlace(st, dec({ marketKey: "ml" }));
  assert.equal(a.status, "placed");
  // Second bet also backs AAA (run line) → same team + same direction group.
  const b = tryPlace(st, dec({ marketKey: "rl", marketFamily: "spread", direction: "team:AAA" }));
  assert.equal(b.status, "reject");
  assert.equal(b.code, "CORRELATED_EXPOSURE");
});

test("event cap: a different-direction market on the same game hits maxEventPct", () => {
  const st = initLedger();
  st.risk = { ...RISK_DEFAULT(), maxEventPct: 0.02, maxSinglePct: 0.03 }; // first bet exhausts the event budget
  const a = tryPlace(st, dec({ marketKey: "ml", direction: "team:AAA", backedTeam: "AAA" }));
  assert.equal(a.status, "placed");
  const b = tryPlace(st, dec({ marketKey: "ou", marketFamily: "total", backedTeam: null, direction: "total:over", sideName: "Over 8.5" }));
  assert.equal(b.status, "reject");
  assert.equal(b.code, "RISK_LIMIT"); // event cap is a RISK_LIMIT reason
});

test("settlement: P&L is net of fees and CLV is recorded independently", () => {
  const st = initLedger();
  const { pos } = tryPlace(st, dec());
  snapshotClose(st, pos.fixtureId, pos.marketKey, 0.55); // market moved our way after entry
  assert.ok(pos.clv > 0, "positive CLV from favorable close");
  const grossPayout = pos.contracts;               // win pays $1/contract
  settleMarket(st, pos.fixtureId, pos.marketKey, "a"); // side a wins
  assert.equal(pos.result, "win");
  const expected = Math.round((grossPayout - pos.stake - pos.fees) * 100) / 100;
  assert.equal(pos.pnl, expected, "pnl net of Kalshi fees");
  // CLV survives settlement and is independent of the win.
  assert.ok(pos.clv > 0);
});

test("a losing trade keeps its positive CLV (process ≠ result)", () => {
  const st = initLedger();
  const { pos } = tryPlace(st, dec());
  snapshotClose(st, pos.fixtureId, pos.marketKey, 0.58);
  settleMarket(st, pos.fixtureId, pos.marketKey, "b"); // our side (a) loses
  assert.equal(pos.result, "loss");
  assert.ok(pos.clv > 0, "still a good process trade despite the loss");
  assert.ok(pos.pnl < 0);
});

test("shadow agents size on their own bankroll without portfolio caps", () => {
  const st = initLedger();
  const r = tryPlace(st, dec({ agentId: "pinnacle" }));
  assert.equal(r.status, "placed");
  assert.equal(r.pos.agentId, "pinnacle");
});

test("recordCandidates stores trades + rejections for the dashboard", () => {
  const st = initLedger();
  recordCandidates(st, [
    dec({ decision: "TRADE" }),
    dec({ decision: "NO_TRADE", rejectCode: "NET_EV_BELOW_THRESHOLD", rejectReason: REJECT.NET_EV_BELOW_THRESHOLD }),
  ]);
  assert.equal(st.candidates.length, 2);
  assert.equal(st.rejections.length, 1);
  assert.equal(st.rejections[0].rejectCode, "NET_EV_BELOW_THRESHOLD");
});

test("migrate backfills new fields on legacy state without breaking it", () => {
  const legacy = {
    startingBankroll: 1000,
    agents: { consensus: { bankroll: 1000, staked: 0, openCount: 0, settledCount: 0, wins: 0, losses: 0 } },
    positions: [{ agentId: "consensus", fightId: "mlb:x-y", fightName: "X vs Y", price: 0.5, closingProb: 0.54, marketKey: "ml", status: "settled", grade: "win", edgeRoi: 0.1, fairProb: 0.6 }],
    results: {}, risk: {},
  };
  const m = migrate(legacy);
  const p = m.positions[0];
  assert.equal(p.fixtureId, "mlb:x-y");     // backfilled from fightId
  assert.equal(p.eventId, "mlb:x-y");
  assert.equal(p.marketFamily, "other");
  assert.equal(p.clv, 0.04);                // computed from closing − entry
  assert.equal(p.modelProb, 0.6);           // from fairProb
  assert.equal(m.schemaVersion, 2);
  assert.ok(m.priceHistory && m.candidates && m.rejections);
});

test("accountStats reflects net-of-fees profit and CLV", () => {
  const st = initLedger();
  const { pos } = tryPlace(st, dec());
  snapshotClose(st, pos.fixtureId, pos.marketKey, 0.55);
  settleMarket(st, pos.fixtureId, pos.marketKey, "a");
  const s = accountStats(st);
  assert.equal(s.wins, 1);
  assert.ok(s.profit > 0);
  assert.ok(s.clv > 0);
});
