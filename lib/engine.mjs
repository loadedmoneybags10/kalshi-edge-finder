// ============================================================================
// Engine (server-side, authoritative) — the decision pipeline (brief §14):
//
//   raw quotes → de-vig → weighted consensus + dispersion → model prob →
//   uncertainty → conservative prob → Kalshi exec price → fees + slippage →
//   NET EV → model/market divergence → liquidity → signal quality →
//   risk + correlation → execution
//
// "Edge found" NEVER means "place trade". A candidate must clear a NET-EV gate
// computed on the CONSERVATIVE probability after fees and slippage, a signal-
// quality gate, and the portfolio risk/correlation caps. Every rejection is
// recorded with a structured reason.
//
// Math lives in lib/quant.mjs (pure, tested). Tunables live in lib/config.mjs.
// This module orchestrates them and owns the paper ledger + settlement + CLV.
// ============================================================================

import {
  LEDGER, SOURCES, referenceSources, sourceById,
  GATE, SIGNAL, UNCERTAINTY, FEES, SLIPPAGE, DIVERGENCE, STALENESS,
  RISK_DEFAULT as CONFIG_RISK_DEFAULT,
} from "./config.mjs";
import {
  clamp01, round, mean, americanToImplied, devig,
  buildConsensus, uncertainty as calcUncertainty, conservativeProbability, divergenceOf,
  feePerContract, kalshiFeeTotal, slippagePerContract, expectedValue,
  kellyStar, stalenessScore, signalQuality, reliabilityOf,
} from "./quant.mjs";

export const START = LEDGER.startingBankroll;
export { americanToImplied };
export const RISK_DEFAULT = CONFIG_RISK_DEFAULT;

// Structured rejection reasons (brief §13). Order also encodes precedence.
export const REJECT = {
  NO_KALSHI: "no executable Kalshi price",
  DATA_QUALITY: "data quality problem (missing/insufficient book quotes)",
  SPREAD_TOO_WIDE: "spread too wide",
  LIQUIDITY_INSUFFICIENT: "liquidity insufficient",
  EDGE_TOO_SMALL: "raw probability edge too small",
  BOOK_DISAGREEMENT: "bookmaker disagreement too high",
  EXCESSIVE_DIVERGENCE: "excessive model/market divergence",
  UNCERTAINTY_TOO_HIGH: "uncertainty too high",
  NET_EV_BELOW_THRESHOLD: "net EV below threshold after uncertainty and fees",
  SIGNAL_QUALITY_LOW: "signal quality below threshold",
  // portfolio-level (placement):
  ALREADY_BET: "already have this market",
  STAKE_TOO_SMALL: "stake below minimum",
  RISK_LIMIT: "risk/exposure limit reached",
  CORRELATED_EXPOSURE: "correlated exposure limit reached",
};

const r2 = x => Math.round((+x + Number.EPSILON) * 100) / 100;
const r4 = x => round(+x, 4);
const uid = () => "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export const agentIds = () => [...Object.keys(SOURCES).filter(i => i !== "kalshi"), "consensus"];

// ---- market/side helpers ----------------------------------------------------
const marketSides = mk => mk.sides ? mk.sides : [{ key: "a", name: mk.a }, { key: "b", name: mk.b }];

const MARKET_FAMILY = {
  winner: "moneyline", ml: "moneyline",
  runline: "spread", spread: "spread",
  runs_ou: "total", goals_ou: "total", rounds: "total", totals: "total",
  match3: "result", btts: "btts", finish: "method",
};
const familyOf = mk => MARKET_FAMILY[mk.type] || mk.type || "other";

// The team a bet on `sideKey` profits from (null for totals/BTTS/draw), plus the
// opposing team — the basis for correlation grouping (brief §12).
function correlationTags(fight, mk, sideKey) {
  const family = familyOf(mk);
  const A = fight.sideA, B = fight.sideB;
  let backed = null, opposing = null, direction;
  if (family === "moneyline") {
    backed = sideKey === "a" ? A : B; opposing = sideKey === "a" ? B : A;
    direction = `team:${backed}`;
  } else if (family === "spread") {
    const favName = mk.favSide === "a" ? A : B, dogName = mk.favSide === "a" ? B : A;
    backed = sideKey === "a" ? favName : dogName; opposing = sideKey === "a" ? dogName : favName;
    direction = `team:${backed}`;
  } else if (family === "result") {
    if (sideKey === "home") { backed = A; opposing = B; direction = `team:${A}`; }
    else if (sideKey === "away") { backed = B; opposing = A; direction = `team:${B}`; }
    else { direction = `draw`; }
  } else if (family === "total") {
    direction = `total:${sideKey === "a" ? "over" : "under"}`;
  } else if (family === "btts") {
    direction = `btts:${sideKey === "a" ? "yes" : "no"}`;
  } else {
    direction = `${family}:${sideKey}`;
  }
  return { backedTeam: backed, opposingTeam: opposing, marketFamily: family, direction };
}

// De-vig one source's quote across a market's sides → fair prob per side.
function fairFromQuote(src, quote, sides) {
  if (!quote) return null;
  const implied = {};
  for (const s of sides) {
    const v = quote[s.key];
    implied[s.key] = src.kind === "sportsbook" ? americanToImplied(v) : Number(v);
  }
  return devig(implied);
}

// ---- per-market analysis: consensus, dispersion, and one decision per agent --
function analyzeMarket(fight, mk, priceHistory = {}, now = Date.now()) {
  const sides = marketSides(mk);
  const R = referenceSources();
  const reads = {};
  R.forEach(s => (reads[s.id] = fairFromQuote(s, mk.books?.[s.id], sides)));

  // Kalshi executable prices per side.
  const kalshi = {};
  sides.forEach(sd => {
    const q = mk.kalshi?.[sd.key];
    kalshi[sd.key] = q ? { ask: q.ask, bid: q.bid ?? q.ask, last: q.last, volume: +q.volume || 0 } : null;
  });

  // Consensus + dispersion per side (brief §3).
  const cons = {};
  sides.forEach(sd => {
    const sources = R
      .map(s => ({ id: s.id, weight: s.weight, prob: reads[s.id]?.[sd.key] }))
      .filter(s => Number.isFinite(s.prob));
    cons[sd.key] = buildConsensus(sources, { kalshiProb: kalshi[sd.key]?.ask ?? null });
  });

  // Staleness is per-market (uses book-consensus vs Kalshi movement over time).
  const histKey = `${fight.id}:${mk.key}`;
  const stale = stalenessScore(priceHistory[histKey], STALENESS, now);

  // One candidate decision per agent (each reference source + consensus),
  // choosing that agent's best side by NET return.
  const agents = [...R.map(s => s.id), "consensus"];
  const candidates = [];
  for (const agentId of agents) {
    let best = null;
    for (const sd of sides) {
      const k = kalshi[sd.key];
      const c = cons[sd.key];
      const modelProb = agentId === "consensus" ? c.consensus : reads[agentId]?.[sd.key];
      if (!Number.isFinite(modelProb) || !k || !(k.ask > 0)) continue;
      const dec = buildDecision({ fight, mk, sd, sides, agentId, modelProb, cons: c, kalshi: k, stale });
      if (!best || (dec.netReturn ?? -Infinity) > (best.netReturn ?? -Infinity)) best = dec;
    }
    if (best) candidates.push(best);
  }
  return { market: mk, sides, reads, cons, kalshi, staleness: stale, candidates };
}

// Compose the full decision record for one (agent, side) — this is the object
// stored on the trade so the WHY is reproducible (brief §15).
function buildDecision({ fight, mk, sd, sides, agentId, modelProb, cons, kalshi, stale }) {
  const execPrice = kalshi.ask;
  const consensusProb = cons.consensus;
  const divergence = agentId === "consensus" ? 0 : divergenceOf(modelProb, consensusProb);
  const u = calcUncertainty({ dispersion: cons.dispersion, nBooks: cons.nBooks, divergence });
  const conservativeProb = conservativeProbability(modelProb, u);
  const feePc = feePerContract(execPrice);
  const slipPc = slippagePerContract({ bid: kalshi.bid, ask: execPrice, volume: kalshi.volume, contracts: 0 });
  const ev = expectedValue({ modelProb, conservativeProb, execPrice, feePc, slipPc });
  const reliability = reliabilityOf(cons.contributions.map(c => c.weight));
  const sq = signalQuality({
    dispersion: cons.dispersion, reliability, netReturn: ev.netReturn,
    volume: kalshi.volume, staleness: stale.score, divergence,
  });
  const tags = correlationTags(fight, mk, sd.key);
  const oppName = sides.filter(x => x.key !== sd.key).map(x => x.name).join(" / ");

  return {
    agentId, fixtureId: fight.id, fixtureName: fight.name, league: fight.league, sport: fight.sport,
    slot: fight.slot, commenceTime: fight.commenceTime ?? null,
    marketKey: mk.key, marketLabel: mk.label, marketType: mk.type, marketFamily: tags.marketFamily, line: mk.line ?? null,
    side: sd.key, sideName: sd.name, oppName,
    backedTeam: tags.backedTeam, opposingTeam: tags.opposingTeam, direction: tags.direction,
    // probabilities
    execPrice: r4(execPrice), kalshiBid: r4(kalshi.bid), kalshiProb: r4(execPrice),
    consensusProb: r4(consensusProb), modelProb: r4(modelProb),
    dispersion: r4(cons.dispersion), nBooks: cons.nBooks, contributions: cons.contributions,
    divergence: r4(divergence),
    uncertainty: r4(u), conservativeProb: r4(conservativeProb),
    // costs + EV
    feePerContract: r4(feePc), slipPerContract: r4(slipPc), costPerContract: r4(ev.costPerContract),
    probEdgePts: r4(ev.probEdgePts), grossReturn: r4(ev.grossReturn),
    netEdgePts: r4(ev.netEdgePts), netReturn: r4(ev.netReturn),
    // quality + market health
    signalQuality: sq.score, signalFactors: sq.factors, divergencePenalty: sq.divergencePenalty,
    staleness: r4(stale.score), staleDetail: stale,
    volume: kalshi.volume, spread: r4(Math.max(0, execPrice - kalshi.bid)),
    // filled by the gate:
    decision: null, rejectReason: null, rejectCode: null,
  };
}

// ---- the trade gate (brief §1, §4, §13) -------------------------------------
// Returns the decision with decision/rejectReason set. Net EV on the conservative
// probability is decisive; a book/Kalshi gap alone never qualifies.
function applyGate(d) {
  const set = (code) => { d.decision = "NO_TRADE"; d.rejectCode = code; d.rejectReason = REJECT[code]; return d; };
  if (!(d.execPrice > 0)) return set("NO_KALSHI");
  if (!(d.nBooks >= 1) || !Number.isFinite(d.consensusProb)) return set("DATA_QUALITY");
  if (d.spread > GATE.maxSpread) return set("SPREAD_TOO_WIDE");
  if (d.volume < GATE.minLiquidityVolume) return set("LIQUIDITY_INSUFFICIENT");
  if (d.probEdgePts < GATE.minProbEdgePts) return set("EDGE_TOO_SMALL");
  if (d.dispersion > GATE.maxDispersion) return set("BOOK_DISAGREEMENT");
  if (Math.abs(d.divergence) > DIVERGENCE.hardCap) return set("EXCESSIVE_DIVERGENCE");
  if (d.uncertainty >= GATE.maxUncertainty) return set("UNCERTAINTY_TOO_HIGH");
  if (d.netReturn < GATE.minNetEv || d.netEdgePts < GATE.minConservativeEdgePts) return set("NET_EV_BELOW_THRESHOLD");
  if (d.signalQuality < SIGNAL.gate) return set("SIGNAL_QUALITY_LOW");
  d.decision = "TRADE"; return d;
}

// ---- card-level orchestration ----
const analyzeFight = (f, ph, now) => ({ fight: f, markets: f.markets.map(mk => analyzeMarket(f, mk, ph, now)) });
export const analyzeCard = (c, priceHistory = {}, now = Date.now()) =>
  ({ ...c, fights: c.fights.map(f => analyzeFight(f, priceHistory, now)) });

export function confirmCard(an) {
  const candidates = [];
  an.fights.forEach(fa => fa.markets.forEach(am => am.candidates.forEach(d => candidates.push(applyGate({ ...d })))));
  candidates.sort((x, y) =>
    (y.decision === "TRADE") - (x.decision === "TRADE") ||
    y.signalQuality - x.signalQuality || (y.netReturn ?? -1) - (x.netReturn ?? -1));
  const confirmed = candidates.filter(d => d.decision === "TRADE");
  // Consensus-only slices power the dashboard's TRADE / NO-TRADE views.
  const consensus = candidates.filter(d => d.agentId === "consensus");
  return { all: candidates, confirmed, candidates: consensus,
    confirmedConsensus: consensus.filter(d => d.decision === "TRADE"),
    rejectedConsensus: consensus.filter(d => d.decision === "NO_TRADE") };
}

// ---- ledger ----
export function initLedger(ids = agentIds(), st = START) {
  const agents = {};
  ids.forEach(id => (agents[id] = { bankroll: st, staked: 0, openCount: 0, settledCount: 0, wins: 0, losses: 0 }));
  return {
    startingBankroll: st, createdAt: new Date().toISOString(), agents,
    positions: [], results: {}, risk: RISK_DEFAULT(), logs: [], reports: [],
    bankrollHistory: [], snapshots: {}, fixtures: {}, priceHistory: {},
    candidates: [], rejections: [], schemaVersion: 2,
  };
}

// Sum of open CONSENSUS stakes matching a predicate.
const openStake = (st, f) => st.positions
  .filter(p => p.agentId === "consensus" && p.status === "open" && f(p))
  .reduce((s, p) => s + p.stake, 0);

// Portfolio risk + correlation caps → final stake, or a rejection (brief §11,§12).
function sizeConsensus(st, d) {
  const R = st.risk || RISK_DEFAULT();
  const bk = st.agents.consensus.bankroll;
  const cost = d.costPerContract;
  const desired = R.mode === "fixed" ? bk * R.unitPct : bk * Math.min(R.kellyFraction * kellyStar(d.conservativeProb, cost), R.maxSinglePct);

  const caps = [
    { room: bk * R.maxSinglePct, code: "RISK_LIMIT" },
    { room: bk * R.maxEventPct - openStake(st, p => p.fixtureId === d.fixtureId), code: "RISK_LIMIT" },
    { room: bk * R.maxSportPct - openStake(st, p => p.sport === d.sport), code: "RISK_LIMIT" },
    { room: bk * R.maxDailyPct - openStake(st, p => p.placedAt?.slice(0, 10) === new Date().toISOString().slice(0, 10)), code: "RISK_LIMIT" },
    { room: bk, code: "RISK_LIMIT" },
  ];
  if (d.backedTeam) {
    caps.push({ room: bk * R.maxTeamPct - openStake(st, p => p.backedTeam === d.backedTeam), code: "CORRELATED_EXPOSURE" });
    caps.push({ room: bk * R.maxCorrelatedPct - openStake(st, p => p.direction === d.direction), code: "CORRELATED_EXPOSURE" });
  } else {
    caps.push({ room: bk * R.maxCorrelatedPct - openStake(st, p => p.direction === d.direction), code: "CORRELATED_EXPOSURE" });
  }

  let stake = desired, binding = null;
  for (const c of caps) if (c.room < stake) { stake = c.room; binding = c.code; }
  if (stake < R.minStake) return { stake: 0, reject: stake <= 0 ? (binding || "RISK_LIMIT") : "STAKE_TOO_SMALL" };
  return { stake, reject: null };
}

const buildReason = d =>
  `${d.sideName}: conservative ${(d.conservativeProb * 100).toFixed(1)}% (fair ${(d.modelProb * 100).toFixed(1)}% ±${(d.uncertainty * 100).toFixed(1)}) ` +
  `vs cost ${(d.costPerContract * 100).toFixed(1)}¢ → net EV ${(d.netReturn * 100).toFixed(1)}%, ` +
  `${d.nBooks} books (disp ${(d.dispersion * 100).toFixed(1)}pts), signal ${d.signalQuality}/100.`;

// Place a CONSENSUS bet from a confirmed decision. Returns {status, pos?, reason?}.
export function tryPlace(st, d) {
  if (d.agentId !== "consensus") {
    // Shadow agents (per-book comparators) size on their own bankroll, no caps.
    return placeShadow(st, d);
  }
  const a = st.agents.consensus;
  if (st.positions.find(p => p.agentId === "consensus" && p.fixtureId === d.fixtureId && p.marketKey === d.marketKey))
    return { status: "skip", reason: REJECT.ALREADY_BET, code: "ALREADY_BET" };
  const { stake, reject } = sizeConsensus(st, d);
  if (reject) return { status: "reject", reason: REJECT[reject], code: reject };
  const pos = commit(st, a, d, stake);
  return { status: "placed", pos };
}

function placeShadow(st, d) {
  const a = st.agents[d.agentId]; if (!a) return { status: "skip" };
  if (st.positions.find(p => p.agentId === d.agentId && p.fixtureId === d.fixtureId && p.marketKey === d.marketKey))
    return { status: "skip" };
  const R = st.risk || RISK_DEFAULT();
  const stake = Math.min(a.bankroll * Math.min(R.kellyFraction * kellyStar(d.conservativeProb, d.costPerContract), R.maxSinglePct), a.bankroll);
  if (stake < R.minStake) return { status: "skip" };
  const pos = commit(st, a, d, stake);
  return { status: "placed", pos };
}

function commit(st, a, d, stake) {
  const contracts = stake / d.execPrice;
  const fees = kalshiFeeTotal(contracts, d.execPrice);
  const slipCost = d.slipPerContract * contracts;
  const pos = {
    id: uid(), agentId: d.agentId, sport: d.sport, league: d.league || d.sport,
    fixtureId: d.fixtureId, fightId: d.fixtureId, /* fightId kept for back-compat */
    fixtureName: d.fixtureName, fightName: d.fixtureName,
    eventId: d.fixtureId, backedTeam: d.backedTeam, opposingTeam: d.opposingTeam,
    marketKey: d.marketKey, marketLabel: d.marketLabel, marketType: d.marketType, marketFamily: d.marketFamily,
    line: d.line, side: d.side, sideName: d.sideName, direction: d.direction,
    stake: r2(stake), contracts: r2(contracts),
    price: r4(d.execPrice), actualFillPrice: r4(d.execPrice + d.slipPerContract),
    fees: r2(fees), estimatedSlippage: r2(slipCost),
    // decision snapshot (immutable record of WHY) —
    kalshiProb: r4(d.execPrice), consensusProb: r4(d.consensusProb), modelProb: r4(d.modelProb),
    uncertainty: r4(d.uncertainty), conservativeProb: r4(d.conservativeProb),
    probEdge: r4(d.probEdgePts), grossEv: r4(d.grossReturn), netEv: r4(d.netReturn),
    signalQuality: d.signalQuality, liquidity: d.volume, spread: r4(d.spread),
    staleness: r4(d.staleness), marketDivergence: r4(d.divergence),
    dispersion: r4(d.dispersion), nBooks: d.nBooks,
    modelVersion: MODEL_VERSION, consensusVersion: CONSENSUS_VERSION, confirmationVersion: CONFIRM_VERSION,
    fairProb: r4(d.modelProb), closingProb: r4(d.execPrice), edgeRoi: r4(d.grossReturn), // legacy aliases
    reason: buildReason(d), notes: "",
    status: "open", placedAt: new Date().toISOString(), result: null, grade: null, pnl: 0, clv: null,
  };
  a.bankroll = r2(a.bankroll - stake); a.staked = r2(a.staked + stake); a.openCount++;
  st.positions.push(pos);
  return pos;
}

// Back-compat shim: old callers used placeBet(st, e) expecting pos|null.
export function placeBet(st, d) { const r = tryPlace(st, d); return r.status === "placed" ? r.pos : null; }

export const MODEL_VERSION = "consensus-1.0";     // fair prob == weighted book consensus (no separate model yet)
export const CONSENSUS_VERSION = "sharp-weighted-fallback-1.0";
export const CONFIRM_VERSION = "netEV-conservative-1.0";

// ---- CLV: snapshot the closing line, restamp settled bets (brief §9) --------
export function snapshotClose(st, fixtureId, marketKey, closingProb) {
  st.snapshots = st.snapshots || {};
  st.snapshots[`${fixtureId}:${marketKey}`] = { closingProb: r4(closingProb), at: new Date().toISOString() };
  st.positions.forEach(p => {
    if ((p.fixtureId || p.fightId) === fixtureId && p.marketKey === marketKey) {
      p.closingProb = r4(closingProb);
      p.clv = r4(closingProb - p.price); // CLV independent of the eventual result
    }
  });
}

// ---- settlement (brief §9: CLV recorded independently of the result) --------
function resolveSide(mk, res) {
  if (!res) return null;
  if (mk.type === "winner") return res.winner || null;
  if (mk.type === "match3") return res.result || null;
  if (mk.type === "btts") return res.btts == null ? null : res.btts ? "a" : "b";
  if (mk.type === "finish") return res.method ? (res.method === "dec" ? "b" : "a") : null;
  if (mk.type === "rounds") return res.method ? (res.method === "dec" || res.endRound > Math.floor(mk.line) ? "a" : "b") : null;
  if (mk.type === "goals_ou") return res.totalGoals == null ? null : res.totalGoals > mk.line ? "a" : "b";
  if (mk.type === "runs_ou") return res.totalRuns == null ? null : res.totalRuns > mk.line ? "a" : "b";
  if (mk.type === "runline") { if (!res.winner || res.margin == null) return null; return res.winner === mk.favSide && res.margin >= 2 ? "a" : "b"; }
  return null;
}
export function settleMarket(st, fid, mkey, win) {
  st.positions.forEach(p => {
    if ((p.fixtureId || p.fightId) !== fid || p.marketKey !== mkey || p.status !== "open") return;
    const a = st.agents[p.agentId], won = p.side === win;
    const payout = won ? p.contracts : 0;
    p.result = won ? "win" : "loss"; p.grade = p.result;
    p.pnl = r2(payout - p.stake - (p.fees || 0)); // net of Kalshi fees
    p.status = "settled"; p.settledAt = new Date().toISOString();
    if (p.closingProb != null && p.clv == null) p.clv = r4(p.closingProb - p.price);
    a.bankroll = r2(a.bankroll + payout); a.openCount = Math.max(0, a.openCount - 1); a.settledCount++;
    won ? a.wins++ : a.losses++;
  });
}
export function applyResult(st, fight, res) {
  st.results[fight.id] = res;
  fight.markets.forEach(mk => { const w = resolveSide(mk, res); if (w) settleMarket(st, fight.id, mk.key, w); });
}

// ---- stats + reporting ----
export function accountStats(st) {
  const R = st.risk || RISK_DEFAULT(), a = st.agents.consensus || { bankroll: st.startingBankroll };
  const mine = st.positions.filter(p => p.agentId === "consensus"), settled = mine.filter(p => p.status === "settled");
  const dec = settled.filter(p => p.grade === "win" || p.grade === "loss");
  const wins = dec.filter(p => p.grade === "win").length, losses = dec.length - wins;
  const profit = r2(settled.reduce((s, p) => s + p.pnl, 0)), staked = r2(dec.reduce((s, p) => s + p.stake, 0));
  const clvA = dec.map(p => (p.clv != null ? p.clv : (p.closingProb - p.price))).filter(Number.isFinite);
  const open = mine.filter(p => p.status === "open");
  return {
    start: st.startingBankroll, bankroll: r2(a.bankroll), unit: r2(a.bankroll * R.unitPct),
    profit, roi: staked > 0 ? r2(profit / staked * 100) : 0, staked, wins, losses,
    winPct: dec.length ? r2(wins / dec.length * 100) : null,
    clv: clvA.length ? r2(mean(clvA) * 100) : null,
    avgNetEv: dec.length ? r2(mean(dec.map(p => p.netEv).filter(Number.isFinite)) * 100) : null,
    openCount: open.length, exposure: r2(open.reduce((s, p) => s + p.stake, 0)),
  };
}
export function snapshotBankroll(st) {
  const today = new Date().toISOString().slice(0, 10), bk = r2((st.agents.consensus || {}).bankroll || st.startingBankroll);
  if (!st.bankrollHistory || !st.bankrollHistory.length) { st.bankrollHistory = [{ d: today, bk }]; return; }
  const last = st.bankrollHistory[st.bankrollHistory.length - 1];
  if (last.d === today) last.bk = bk; else st.bankrollHistory.push({ d: today, bk });
}
export function logAuto(st, msg, kind = "info") {
  (st.logs = st.logs || []).unshift({ ts: new Date().toISOString(), kind, msg });
  if (st.logs.length > 400) st.logs.length = 400;
}
export function pushReport(st, { graded = 0, w = 0, l = 0, dayPnl = 0, newPlays = 0 } = {}) {
  const s = accountStats(st);
  (st.reports = st.reports || []).unshift({ date: new Date().toISOString().slice(0, 10), ts: new Date().toISOString(),
    settled: graded, w, l, push: 0, void: 0, dayPnl: r2(dayPnl), bankroll: s.bankroll, newPlays });
  if (st.reports.length > 120) st.reports.length = 120;
}

// Append this run's book-consensus + Kalshi price per market to the rolling
// history that staleness detection reads next run (brief §8). One representative
// side per market keeps it light.
export function recordPriceHistory(st, an, now = Date.now()) {
  st.priceHistory = st.priceHistory || {};
  for (const fa of an.fights) for (const am of fa.markets) {
    const sd = am.sides[0]; if (!sd) continue;
    const bookP = am.cons[sd.key]?.consensus;
    const kP = am.kalshi[sd.key]?.ask;
    if (!Number.isFinite(bookP) && !Number.isFinite(kP)) continue;
    const key = `${fa.fight.id}:${am.market.key}`;
    const h = st.priceHistory[key] || { book: [], kalshi: [] };
    if (Number.isFinite(bookP)) h.book.push({ t: now, p: r4(bookP) });
    if (Number.isFinite(kP)) h.kalshi.push({ t: now, p: r4(kP) });
    if (h.book.length > STALENESS.historyCap) h.book = h.book.slice(-STALENESS.historyCap);
    if (h.kalshi.length > STALENESS.historyCap) h.kalshi = h.kalshi.slice(-STALENESS.historyCap);
    st.priceHistory[key] = h;
  }
}

// Record the latest run's candidate decisions so the dashboard can explain WHY
// (both trades and rejections). Capped.
export function recordCandidates(st, consensusCandidates) {
  st.candidates = consensusCandidates.slice(0, 120);
  const rej = consensusCandidates.filter(d => d.decision === "NO_TRADE");
  st.rejections = [...rej.map(d => ({ ...d, at: new Date().toISOString() })), ...(st.rejections || [])].slice(0, 300);
}

// ---- migration (never breaks old state; brief §15) --------------------------
export const migrate = s => {
  if (!s || !s.agents) return initLedger();
  s.snapshots = s.snapshots || {}; s.logs = s.logs || []; s.reports = s.reports || [];
  s.bankrollHistory = s.bankrollHistory || []; s.fixtures = s.fixtures || {};
  s.priceHistory = s.priceHistory || {}; s.candidates = s.candidates || []; s.rejections = s.rejections || [];
  s.risk = { ...RISK_DEFAULT(), ...(s.risk || {}) };
  for (const id of agentIds()) if (!s.agents[id]) s.agents[id] = { bankroll: START, staked: 0, openCount: 0, settledCount: 0, wins: 0, losses: 0 };
  // Backfill new position fields on legacy bets so the UI never sees undefined.
  for (const p of s.positions || []) {
    p.fixtureId = p.fixtureId || p.fightId;
    p.fixtureName = p.fixtureName || p.fightName;
    p.eventId = p.eventId || p.fixtureId;
    p.marketFamily = p.marketFamily || "other";
    if (p.clv == null && p.closingProb != null && p.price != null) p.clv = r4(p.closingProb - p.price);
    if (p.netEv == null) p.netEv = p.edgeRoi ?? null;
    if (p.modelProb == null) p.modelProb = p.fairProb ?? null;
  }
  s.schemaVersion = 2;
  return s;
};
