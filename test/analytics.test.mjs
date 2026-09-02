// Tests for lib/analytics.mjs — deterministic synthetic ledgers.
import test from "node:test";
import assert from "node:assert/strict";
import {
  predictionsFrom, brierScore, logLoss, calibration, clvSummary, sourcePerformance, analyticsSummary,
} from "../lib/analytics.mjs";

const near = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

// Build a settled consensus position with a given model prob, win/loss, and clv.
const pos = (modelProb, grade, clv = null, extra = {}) => ({
  agentId: "consensus", status: "settled", grade, modelProb, sport: "mlb",
  marketFamily: "moneyline", price: 0.5, closingProb: 0.5 + (clv ?? 0), clv, ...extra,
});

test("predictionsFrom pulls decided consensus bets only", () => {
  const positions = [pos(0.6, "win"), pos(0.4, "loss"), { agentId: "consensus", status: "open", modelProb: 0.7 }];
  const preds = predictionsFrom(positions);
  assert.equal(preds.length, 2);
  assert.deepEqual(preds.map(x => x.outcome), [1, 0]);
});

test("brierScore: perfect vs worst vs baseline", () => {
  near(brierScore([{ p: 1, outcome: 1 }, { p: 0, outcome: 0 }]), 0);
  near(brierScore([{ p: 0, outcome: 1 }, { p: 1, outcome: 0 }]), 1);
  near(brierScore([{ p: 0.5, outcome: 1 }, { p: 0.5, outcome: 0 }]), 0.25);
  assert.equal(brierScore([]), null);
});

test("logLoss: finite even on a confident miss (clamped)", () => {
  const ll = logLoss([{ p: 0, outcome: 1 }]);
  assert.ok(Number.isFinite(ll) && ll > 0);
  near(logLoss([{ p: 1, outcome: 1 }]), 0, 1e-5);
});

test("calibration: well-calibrated 70% bucket reads ~0.7 actual", () => {
  // 10 preds at p=0.75, 7 winners → bucket 70–80% actual 0.7
  const preds = [];
  for (let i = 0; i < 10; i++) preds.push({ p: 0.75, outcome: i < 7 ? 1 : 0 });
  const cal = calibration(preds, { buckets: 10, minBucketSamples: 5 });
  const bucket = cal.buckets[7]; // 70–80%
  assert.equal(bucket.n, 10);
  near(bucket.predicted, 0.75);
  near(bucket.actual, 0.7);
  assert.ok(bucket.sufficient);
  assert.ok(cal.ece >= 0);
});

test("calibration: ECE is 0 for a perfectly calibrated set", () => {
  const preds = [];
  for (let i = 0; i < 10; i++) preds.push({ p: 0.5, outcome: i < 5 ? 1 : 0 });
  const cal = calibration(preds, { buckets: 10, minBucketSamples: 1 });
  near(cal.ece, 0);
});

test("clvSummary: separates process quality from result", () => {
  const positions = [
    pos(0.6, "loss", 0.04), // GOOD process (+CLV), lost
    pos(0.6, "win", 0.03),  // good process, won
    pos(0.6, "win", -0.05), // BAD process (−CLV), won anyway
  ];
  const s = clvSummary(positions);
  assert.equal(s.n, 3);
  near(s.meanClvPts, ((0.04 + 0.03 - 0.05) / 3) * 100, 0.1);
  assert.equal(s.goodProcess.n, 2);
  assert.equal(s.badProcess.n, 1);
  assert.equal(s.badProcess.wonPct, 100); // the −CLV trade won (luck, not edge)
});

test("sourcePerformance: labels fallback when data is thin", () => {
  const positions = [
    { agentId: "pinnacle", status: "settled", grade: "win", modelProb: 0.6, marketFamily: "moneyline" },
    { agentId: "pinnacle", status: "settled", grade: "loss", modelProb: 0.55, marketFamily: "moneyline" },
  ];
  const perf = sourcePerformance(positions);
  assert.equal(perf.pinnacle.n, 2);
  assert.ok(perf.pinnacle.brier >= 0);
  assert.equal(perf.pinnacle.weightSource, "heuristic-fallback");
  assert.equal(perf.pinnacle.effectiveWeight, perf.pinnacle.fallbackWeight);
  assert.match(perf.pinnacle.note, /insufficient data/);
});

test("analyticsSummary: observational-only until the sample threshold", () => {
  const positions = [pos(0.6, "win", 0.02), pos(0.55, "loss", -0.01)];
  const a = analyticsSummary({ positions });
  assert.equal(a.n, 2);
  assert.equal(a.adjustmentsActive, false);
  assert.match(a.note, /observational only|until/);
});
