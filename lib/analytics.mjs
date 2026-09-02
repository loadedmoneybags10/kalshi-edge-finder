// ============================================================================
// analytics.mjs — pure post-hoc analysis of the paper ledger (brief §9, §10).
//
// Nothing here changes production behavior; it MEASURES it. The point is to tell
// good process from good luck: calibration (do our 70%s happen 70% of the time?),
// Brier/log-loss (sharpness + calibration in one number), and CLV (did the market
// move our way after we bet — the leading indicator of a real edge).
//
// Source performance is tracked so weights can LATER be learned instead of
// hardcoded — but only once there's enough data (WEIGHTS_LEARNING.minSamples).
// Until then callers keep the labeled heuristic fallbacks.
// ============================================================================

import { CALIBRATION, WEIGHTS_LEARNING, SOURCES } from "./config.mjs";
import { clamp, clamp01, mean, round } from "./quant.mjs";

const decided = p => p && p.status === "settled" && (p.grade === "win" || p.grade === "loss");
const outcomeOf = p => (p.grade === "win" ? 1 : 0);

// Extract (predicted prob, outcome) pairs for calibration/scoring. `field` is the
// probability being tested — default the model/fair prob (is IT calibrated?).
export function predictionsFrom(positions, { agentId = "consensus", field = "modelProb" } = {}) {
  return (positions || [])
    .filter(p => p.agentId === agentId && decided(p))
    .map(p => ({
      p: p[field] ?? p.modelProb ?? p.fairProb,
      outcome: outcomeOf(p),
      sport: p.sport, marketFamily: p.marketFamily || "other",
      price: p.price, closing: p.closingProb, clv: p.clv,
    }))
    .filter(x => Number.isFinite(x.p));
}

// Brier score: mean squared error of probabilistic forecasts. Lower is better;
// 0.25 is the always-0.5 baseline on 50/50 events.
export function brierScore(preds) {
  if (!preds.length) return null;
  return round(mean(preds.map(x => (x.p - x.outcome) ** 2)), 5);
}

// Log loss (cross-entropy). Lower is better; probs clamped off {0,1} so a single
// confident miss doesn't return Infinity.
export function logLoss(preds, eps = 1e-6) {
  if (!preds.length) return null;
  const l = preds.map(x => {
    const p = clamp(x.p, eps, 1 - eps);
    return -(x.outcome * Math.log(p) + (1 - x.outcome) * Math.log(1 - p));
  });
  return round(mean(l), 5);
}

// Reliability curve: bucket predictions by predicted probability, compare the
// bucket's mean prediction to its realized win rate. Plus expected calibration
// error (ECE), the sample-weighted gap between the two.
export function calibration(preds, { buckets = CALIBRATION.buckets, minBucketSamples = CALIBRATION.minBucketSamples } = {}) {
  const bins = Array.from({ length: buckets }, (_, i) => ({
    lo: i / buckets, hi: (i + 1) / buckets, n: 0, sumP: 0, wins: 0,
  }));
  for (const x of preds) {
    let idx = Math.floor(x.p * buckets);
    if (idx >= buckets) idx = buckets - 1;
    if (idx < 0) idx = 0;
    const b = bins[idx];
    b.n++; b.sumP += x.p; b.wins += x.outcome;
  }
  let eceNum = 0, total = 0;
  const rows = bins.map(b => {
    const predicted = b.n ? b.sumP / b.n : null;
    const actual = b.n ? b.wins / b.n : null;
    if (b.n) { eceNum += b.n * Math.abs((predicted ?? 0) - (actual ?? 0)); total += b.n; }
    return {
      range: `${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}%`,
      n: b.n,
      predicted: predicted == null ? null : round(predicted, 4),
      actual: actual == null ? null : round(actual, 4),
      sufficient: b.n >= minBucketSamples,
    };
  });
  return { buckets: rows, ece: total ? round(eceNum / total, 4) : null, n: total };
}

// CLV summary: mean CLV, share of trades with positive CLV, and the crucial
// process-vs-luck cross-tab — a losing trade with +CLV was still a GOOD trade;
// a winning trade with −CLV was a BAD one (brief §9).
export function clvSummary(positions, { agentId = "consensus" } = {}) {
  const ps = (positions || []).filter(p => p.agentId === agentId && p.clv != null);
  if (!ps.length) return { n: 0 };
  const clvs = ps.map(p => p.clv);
  const dec = ps.filter(decided);
  const goodProcess = dec.filter(p => p.clv > 0);      // +CLV, regardless of result
  const goodWon = goodProcess.filter(p => p.grade === "win").length;
  const badProcess = dec.filter(p => p.clv <= 0);
  const badWon = badProcess.filter(p => p.grade === "win").length;
  return {
    n: ps.length,
    meanClvPts: round(mean(clvs) * 100, 2),
    positiveClvPct: round(100 * clvs.filter(c => c > 0).length / clvs.length, 1),
    goodProcess: { n: goodProcess.length, wonPct: goodProcess.length ? round(100 * goodWon / goodProcess.length, 1) : null },
    badProcess: { n: badProcess.length, wonPct: badProcess.length ? round(100 * badWon / badProcess.length, 1) : null },
  };
}

// Per-source predictive performance from settled SHADOW positions (each book
// agent bets on its own read, so its settled bets are its track record). Returns
// Brier/log-loss/n and a SUGGESTED learned weight — used only when n is large
// enough; otherwise the labeled heuristic fallback stands.
export function sourcePerformance(positions, cfg = WEIGHTS_LEARNING) {
  const out = {};
  for (const id of Object.keys(SOURCES)) {
    if (SOURCES[id].isTarget) continue;
    const preds = predictionsFrom(positions, { agentId: id, field: "modelProb" });
    const brier = brierScore(preds);
    const n = preds.length;
    const fallback = SOURCES[id].weight;
    let learnedWeight = null, weightSource = "heuristic-fallback";
    if (cfg.enabled && n >= cfg.minSamples && brier != null) {
      learnedWeight = round(clamp(1 - brier / cfg.brierRef, cfg.floor, 1), 3);
      weightSource = "learned-from-brier";
    }
    out[id] = {
      n, brier, logLoss: logLoss(preds),
      fallbackWeight: fallback,
      learnedWeight,
      effectiveWeight: learnedWeight ?? fallback,
      weightSource,
      note: n < cfg.minSamples ? `insufficient data (${n}/${cfg.minSamples}) — using labeled fallback` : "eligible",
    };
  }
  return out;
}

// One call for the dashboard analytics panel.
export function analyticsSummary(state) {
  const positions = state?.positions || [];
  const preds = predictionsFrom(positions);
  return {
    n: preds.length,
    brier: brierScore(preds),
    logLoss: logLoss(preds),
    calibration: calibration(preds),
    clv: clvSummary(positions),
    sources: sourcePerformance(positions),
    adjustmentsActive: preds.length >= CALIBRATION.minTotalForAdjust,
    note: preds.length < CALIBRATION.minTotalForAdjust
      ? `calibration is observational only until ${CALIBRATION.minTotalForAdjust} graded trades (have ${preds.length})`
      : "sufficient sample to consider calibration adjustments",
  };
}
