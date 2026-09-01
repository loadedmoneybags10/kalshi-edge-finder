// ============================================================================
// config.mjs — every tunable in ONE place. No magic numbers scattered through
// the engine. Grouped by concern; each value carries intent in a comment.
//
// PROVENANCE DISCIPLINE (per the design brief): nothing in here is claimed to be
// statistically proven. Source weights are HEURISTIC FALLBACKS used only until
// we have enough graded history to learn them (see lib/analytics.mjs →
// sourcePerformance). They are labeled as such and must be presented that way.
// ============================================================================

// ---- Bankroll / ledger ----
export const LEDGER = {
  startingBankroll: 1000,
};

// ---- Source reliability (HEURISTIC FALLBACK weights) --------------------------
// `weight` drives the sharpness-weighted consensus. `provenance` is surfaced in
// the UI so these are never mistaken for measured values. Once a source has
// >= learn.minSamples graded predictions, analytics can replace `weight` with a
// value derived from its Brier score (see WEIGHTS_LEARNING).
export const SOURCES = {
  kalshi:     { id: "kalshi",     name: "Kalshi",     kind: "prediction-market", weight: 0.72, isTarget: true, provenance: "heuristic-fallback" },
  polymarket: { id: "polymarket", name: "Polymarket", kind: "prediction-market", weight: 0.80, provenance: "heuristic-fallback" },
  pinnacle:   { id: "pinnacle",   name: "Pinnacle",   kind: "sportsbook",        weight: 0.95, provenance: "heuristic-fallback" },
  draftkings: { id: "draftkings", name: "DraftKings", kind: "sportsbook",        weight: 0.62, provenance: "heuristic-fallback" },
  fanduel:    { id: "fanduel",    name: "FanDuel",    kind: "sportsbook",        weight: 0.60, provenance: "heuristic-fallback" },
};

export const WEIGHTS_LEARNING = {
  enabled: false,          // OFF until we have data — fallbacks only.
  minSamples: 200,         // per (source) before a learned weight may replace fallback.
  minSamplesBucketed: 50,  // per (source × sport × market) before bucketed weighting.
  // Learned weight from Brier: w = clamp(1 - brier / brierRef, floor, 1).
  brierRef: 0.25,          // Brier of an always-0.5 predictor on a 50/50 market.
  floor: 0.05,
};

// ---- Uncertainty model (Phase B) ---------------------------------------------
// Fair probability is never treated as exact. uncertainty (in probability
// points, 0–1) is a transparent LINEAR blend, then clamped. Larger dispersion,
// fewer books, and larger model↔market divergence all widen it.
export const UNCERTAINTY = {
  base: 0.015,        // irreducible floor: even perfect agreement isn't certainty.
  kDispersion: 1.00,  // × weighted stdev of source probabilities.
  kFewBooks: 0.030,   // × (1/sqrt(nBooks)) — thin coverage → more doubt.
  kDivergence: 0.50,  // × |modelProb − consensusProb| — model straying costs.
  min: 0.010,
  max: 0.150,         // cap so one noisy market can't nuke everything.
};

// ---- Model vs. market divergence (Phase B, #6) -------------------------------
// Today "model" == consensus for the consensus agent (no separate predictor
// yet), so its divergence ≈ 0. A single-book agent's divergence = that book vs
// consensus, which is exactly the lone-dissenter case we want to penalize.
export const DIVERGENCE = {
  softCap: 0.08,   // |divergence| beyond this starts materially hurting signal quality.
  hardCap: 0.20,   // beyond this we refuse the trade (needs a real model to justify).
};

// ---- Fees & slippage (Phase C, #7) -------------------------------------------
// Kalshi's general trading fee: fee = ceil(coef × C × P × (1−P)) in cents, where
// P is price in dollars (0–1) and C is contracts. coef=0.07 is Kalshi's published
// general rate; treat as provisional and verify per-series before real money.
export const FEES = {
  kalshiCoef: 0.07,
  provenance: "kalshi-published-general-rate (verify per series)",
};

// Slippage is ESTIMATED (the public feed has no depth), so it is explicitly
// provisional. We charge half the bid/ask spread (crossing cost) plus a size
// impact that grows as our contracts approach a fraction of shown volume.
export const SLIPPAGE = {
  halfSpreadWeight: 0.5,   // fraction of (ask − bid) charged as crossing cost.
  kSizeImpact: 0.10,       // × (contracts / max(depthProxy,1)) added, in prob pts.
  depthFromVolume: 0.10,   // depthProxy = volume × this (very rough liquidity proxy).
  maxSlippage: 0.05,       // hard cap in probability points.
  provenance: "estimated — no live order-book depth yet",
};

// ---- Staleness (Phase C, #8) -------------------------------------------------
export const STALENESS = {
  windowMs: 1000 * 60 * 90, // look back 90m of price history for movement.
  moveThreshold: 0.02,      // book move (pts) considered "meaningful".
  kalshiFollowRatio: 0.35,  // if Kalshi moved < this × book move, it's lagging.
  maxAgeMs: 1000 * 60 * 30, // a Kalshi quote older than this is itself stale.
  historyCap: 40,           // samples kept per market.
};

// ---- Signal Quality (Phase D, #4) --------------------------------------------
// 0–100 quality of the OPPORTUNITY (not a win probability). Weighted blend of
// factors, then multiplied by a divergence penalty. Weights sum to 1.
export const SIGNAL = {
  weights: { agreement: 0.30, reliability: 0.20, magnitude: 0.22, liquidity: 0.13, freshness: 0.15 },
  dispersionRef: 0.06,   // dispersion (pts) that drives agreement factor to ~0.
  magnitudeRef: 0.10,    // net EV return that saturates the magnitude factor.
  liquidityRef: 40000,   // volume that saturates the liquidity factor (log scale).
  gate: 70,              // MIN signal quality to trade. Reframed from the old "85".
                         // Lowered because it now sits ALONGSIDE a hard net-EV gate,
                         // not as a stand-in for one.
};

// ---- Trade gate (Phase C/D, #1) ----------------------------------------------
// The decisive gate is NET EV computed on the CONSERVATIVE probability, after
// fees and slippage. A raw book/Kalshi gap is necessary but never sufficient.
export const GATE = {
  minNetEv: 0.03,          // ≥ +3% net expected return required.
  minProbEdgePts: 0.02,    // ≥ +2 pts raw (fair − price) as a coarse pre-filter.
  minConservativeEdgePts: 0.005, // conservative prob must still beat cost by this.
  minLiquidityVolume: 500, // markets thinner than this are untradeable.
  maxSpread: 0.10,         // bid/ask wider than 10 pts → skip (illiquid/unreliable).
  maxUncertainty: 0.12,    // if the fair estimate is this fuzzy, stand down.
  maxDispersion: 0.06,     // sources disagreeing by more than this → no trade.
};

// ---- Risk / staking (Phase D, #11) -------------------------------------------
// Conservative while the model is unvalidated: quarter-Kelly on NET EV, tight
// caps, and correlation grouping. All limits are fractions of current bankroll.
export const RISK_DEFAULT = () => ({
  mode: "kelly",           // "kelly" | "fixed"
  unitPct: 0.01,           // fixed-mode stake, and the "unit" for reporting.
  kellyFraction: 0.25,     // quarter-Kelly.
  minStake: 1,             // don't place sub-$1 paper bets.
  maxSinglePct: 0.03,      // one trade (tightened from 0.05 during validation).
  maxEventPct: 0.05,       // all trades on one game/event.
  maxTeamPct: 0.06,        // all trades touching one team.
  maxSportPct: 0.20,       // all open trades in one sport.
  maxDailyPct: 0.30,       // total new exposure opened per day.
  maxCorrelatedPct: 0.05,  // one correlation group (event × direction).
});

// ---- Analytics / calibration (Phase E, #10) ----------------------------------
export const CALIBRATION = {
  buckets: 10,             // 0–10%, 10–20%, … 90–100%.
  minBucketSamples: 20,    // below this a bucket is "insufficient", shown but not acted on.
  minTotalForAdjust: 300,  // never adjust production probabilities below this many graded.
};

// Convenience: reference (non-target) sources, and a safe lookup.
export const referenceSources = () => Object.values(SOURCES).filter(s => !s.isTarget);
export const sourceById = id => SOURCES[id] || { id, name: id, weight: 0.5, kind: "", provenance: "unknown" };
