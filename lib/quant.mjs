// ============================================================================
// quant.mjs — the PURE decision math. No I/O, no state, no dates: given numbers
// it returns numbers. That's what makes it unit-testable (see test/quant.test.mjs)
// and what makes the trade decision reproducible from stored fields.
//
// Pipeline realized here (brief §14):
//   sources → consensus → dispersion → model → uncertainty → conservative prob
//          → exec price → fees → slippage → net EV → divergence → signal quality
//
// Probabilities and prices are all in [0,1] (dollars per $1 contract).
// ============================================================================

import { UNCERTAINTY, DIVERGENCE, FEES, SLIPPAGE, SIGNAL } from "./config.mjs";

// ---- tiny numeric helpers ----
export const clamp01 = x => Math.max(0, Math.min(1, x));
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const isNum = x => typeof x === "number" && isFinite(x);
export const round = (x, d = 4) => { const m = 10 ** d; return Math.round((x + Number.EPSILON) * m) / m; };

export function mean(xs) {
  const v = xs.filter(isNum);
  return v.length ? v.reduce((s, n) => s + n, 0) / v.length : NaN;
}
export function weightedMean(vals, weights) {
  let n = 0, d = 0;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i], w = weights[i] ?? 1;
    if (isNum(v) && isNum(w) && w > 0) { n += v * w; d += w; }
  }
  return d > 0 ? n / d : NaN;
}
// Population weighted standard deviation (dispersion of sources around consensus).
export function weightedStdev(vals, weights, mu = null) {
  const m = mu == null ? weightedMean(vals, weights) : mu;
  if (!isNum(m)) return NaN;
  let n = 0, d = 0;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i], w = weights[i] ?? 1;
    if (isNum(v) && isNum(w) && w > 0) { n += w * (v - m) ** 2; d += w; }
  }
  return d > 0 ? Math.sqrt(n / d) : NaN;
}

// ---- probability conversions (brief §1) ----
// American odds → implied probability (WITH the book's vig still in it).
export function americanToImplied(a) {
  a = +a;
  if (!isNum(a) || a === 0) return NaN;
  return a > 0 ? 100 / (a + 100) : -a / (-a + 100);
}
// Remove vig from an n-way set of raw implied probabilities (multiplicative /
// proportional method): each fair_i = implied_i / Σ implied. Works for 2-way
// (moneyline, O/U) and 3-way (1X2) alike.
export function devig(impliedByKey) {
  const keys = Object.keys(impliedByKey);
  const sum = keys.reduce((s, k) => s + (isNum(impliedByKey[k]) ? impliedByKey[k] : 0), 0);
  if (!(sum > 0)) return null;
  const fair = {};
  for (const k of keys) fair[k] = isNum(impliedByKey[k]) ? impliedByKey[k] / sum : NaN;
  return fair;
}

// ---- consensus + dispersion (brief §3) ----
// sources: [{ id, weight, prob }] for ONE side. Returns the weighted consensus,
// dispersion (weighted stdev), and per-source contributions with diffs — so the
// UI can show HOW strongly and consistently sources agree, not just a count.
export function buildConsensus(sources, { kalshiProb = null } = {}) {
  const usable = sources.filter(s => isNum(s.prob) && isNum(s.weight) && s.weight > 0);
  const vals = usable.map(s => s.prob), ws = usable.map(s => s.weight);
  const consensus = weightedMean(vals, ws);
  const dispersion = weightedStdev(vals, ws, consensus);
  const totW = ws.reduce((s, w) => s + w, 0) || 1;
  const contributions = usable.map(s => ({
    id: s.id, prob: round(s.prob),
    weight: round(s.weight, 3),
    weightShare: round(s.weight / totW, 3),
    diffFromConsensus: round(s.prob - consensus),
    diffFromKalshi: isNum(kalshiProb) ? round(s.prob - kalshiProb) : null,
  }));
  return { consensus, dispersion: isNum(dispersion) ? dispersion : 0, nBooks: usable.length, contributions };
}

// ---- uncertainty + conservative probability (brief §5, §6) ----
// Transparent LINEAR blend, then clamped. Wider when sources disagree
// (dispersion), when few books quote, and when the model strays from consensus.
export function uncertainty({ dispersion = 0, nBooks = 0, divergence = 0 }, cfg = UNCERTAINTY) {
  const fewBooks = nBooks > 0 ? cfg.kFewBooks / Math.sqrt(nBooks) : cfg.kFewBooks;
  const u = cfg.base
    + cfg.kDispersion * (isNum(dispersion) ? dispersion : 0)
    + fewBooks
    + cfg.kDivergence * Math.abs(isNum(divergence) ? divergence : 0);
  return clamp(u, cfg.min, cfg.max);
}
// We always BUY the chosen side, so "conservative" means haircut the win prob
// downward by the uncertainty. Missing trades is preferred to overconfidence.
export function conservativeProbability(modelProb, u) {
  return clamp01(modelProb - u);
}
export const divergenceOf = (modelProb, consensusProb) =>
  (isNum(modelProb) && isNum(consensusProb)) ? modelProb - consensusProb : 0;

// ---- fees + slippage (brief §7) ----
// Kalshi general trading fee. Smooth per-contract value (in $) for marginal EV.
export function feePerContract(price, coef = FEES.kalshiCoef) {
  if (!(price > 0 && price < 1)) return 0;
  return coef * price * (1 - price);
}
// Exact ledger fee for a whole order: rounded UP to the next cent.
export function kalshiFeeTotal(contracts, price, coef = FEES.kalshiCoef) {
  if (!(price > 0 && price < 1) || !(contracts > 0)) return 0;
  // Subtract a tiny epsilon before ceil so float artifacts (e.g. 1.75 stored as
  // 1.7500000000000002) don't round a whole extra cent upward.
  return Math.ceil(coef * contracts * price * (1 - price) * 100 - 1e-9) / 100;
}
// Estimated slippage (in probability/price points) beyond the quoted ask.
// Conservative by design: half the spread PLUS a size impact vs a volume-based
// depth proxy. Explicitly provisional — the public feed has no real depth.
export function slippagePerContract({ bid = null, ask = null, volume = 0, contracts = 0 }, cfg = SLIPPAGE) {
  const spread = (isNum(bid) && isNum(ask) && ask >= bid) ? ask - bid : 0;
  const depthProxy = Math.max(1, (volume || 0) * cfg.depthFromVolume);
  const sizeImpact = cfg.kSizeImpact * ((contracts || 0) / depthProxy);
  return clamp(cfg.halfSpreadWeight * spread + sizeImpact, 0, cfg.maxSlippage);
}

// ---- EV (brief §1, §7) ----
// grossReturn: model view ignoring costs. netReturn: on CONSERVATIVE prob, after
// fees+slippage — this is what the trade gate uses.
export function expectedValue({ modelProb, conservativeProb, execPrice, feePc = 0, slipPc = 0 }) {
  const grossReturn = execPrice > 0 ? modelProb / execPrice - 1 : NaN;
  const probEdgePts = modelProb - execPrice;
  const costPerContract = execPrice + feePc + slipPc;
  const netEdgePts = conservativeProb - costPerContract;
  const netReturn = costPerContract > 0 ? netEdgePts / costPerContract : NaN;
  return {
    probEdgePts, grossReturn,
    costPerContract, netEdgePts, netReturn,
  };
}

// ---- Kelly on NET EV (brief §11) ----
// Effective price is the all-in cost per contract; p is the conservative prob.
// Returns the RAW Kelly fraction f* (caller applies fraction + caps).
export function kellyStar(conservativeProb, costPerContract) {
  const p = conservativeProb, price = costPerContract;
  if (!(price > 0 && price < 1) || !(p > 0 && p < 1)) return 0;
  const b = (1 - price) / price;                 // net odds received on a win
  const f = (b * p - (1 - p)) / b;               // = p - (1-p)/b
  return f > 0 ? f : 0;
}

// ---- staleness (brief §8) ----
// history: { book:[{t,p}], kalshi:[{t,p}] } (t = epoch ms). Score 0–1: high when
// the book moved but Kalshi didn't, or the Kalshi quote is simply old. Returns a
// score plus the components so the UI can explain it. No history → 0 + reason.
export function stalenessScore(history, cfg, now = Date.now()) {
  if (!history || !history.book || !history.kalshi || history.book.length < 2) {
    return { score: 0, bookMove: 0, kalshiMove: 0, ageMs: null, reason: "insufficient-history" };
  }
  const recent = arr => arr.filter(x => now - x.t <= cfg.windowMs);
  const b = recent(history.book), k = recent(history.kalshi);
  const move = arr => (arr.length >= 2 ? arr[arr.length - 1].p - arr[0].p : 0);
  const bookMove = Math.abs(move(b)), kalshiMove = Math.abs(move(k));
  const ageMs = k.length ? now - k[k.length - 1].t : null;

  let lag = 0;
  if (bookMove >= cfg.moveThreshold) {
    // Kalshi should have followed by ~kalshiFollowRatio × the book move.
    const expected = cfg.kalshiFollowRatio * bookMove;
    lag = clamp01(1 - kalshiMove / Math.max(expected, 1e-9));
  }
  const age = ageMs != null ? clamp01(ageMs / cfg.maxAgeMs) : 0;
  const score = clamp01(Math.max(lag, 0.5 * age));
  return { score, bookMove: round(bookMove), kalshiMove: round(kalshiMove), ageMs, reason: null };
}

// ---- signal quality (brief §4) ----
// 0–100 quality of the OPPORTUNITY — NOT a probability of winning. A weighted
// blend of independent factors, scaled by a divergence penalty.
export function signalQuality({
  dispersion = 0, reliability = 0, netReturn = 0, volume = 0, staleness = 0, divergence = 0,
}, cfg = SIGNAL, dcfg = DIVERGENCE) {
  const agreement = clamp01(1 - dispersion / cfg.dispersionRef);
  const magnitude = clamp01(netReturn / cfg.magnitudeRef);
  const liquidity = clamp01(Math.log10((volume || 0) + 1) / Math.log10(cfg.liquidityRef));
  const freshness = clamp01(1 - staleness);
  const factors = { agreement, reliability: clamp01(reliability), magnitude, liquidity, freshness };
  let base = 0;
  for (const k in cfg.weights) base += cfg.weights[k] * factors[k];

  const ad = Math.abs(divergence);
  let penalty;
  if (ad <= dcfg.softCap) penalty = 1 - 0.4 * (ad / dcfg.softCap);
  else penalty = 0.6 - 0.4 * clamp01((ad - dcfg.softCap) / (dcfg.hardCap - dcfg.softCap));
  penalty = clamp(penalty, 0.1, 1);

  return { score: Math.round(100 * base * penalty), factors, divergencePenalty: round(penalty, 3) };
}

// reliability = how sharp/credible the quoting sources are (0–1), scaled so a
// Pinnacle-anchored set scores near the top.
export function reliabilityOf(weights, maxRef = 0.95) {
  const m = mean(weights);
  return isNum(m) ? clamp01(m / maxRef) : 0;
}
