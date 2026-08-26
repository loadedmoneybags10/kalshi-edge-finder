// ============================================================================
// Engine (server-side, authoritative) — odds math + edge/confidence + paper
// ledger + settlement + CLV. Ported from edge/dashboard-standalone.html so the
// pipeline (api/poll.mjs) scores and places the same way the UI does.
//
// SYNC NOTE: the dashboard still carries its own inline copy for standalone use.
// Once the dashboard reads state from /api/state, its engine becomes a pure
// renderer and this module is the single source of truth. Keep them in step
// until then (the math below must match the HTML's).
// ============================================================================

export const START = 1000, KF = 0.25, MAXF = 0.05, MINS = 1, GATE = 85;
export const WEIGHTS = { agreement: 0.32, sharpness: 0.2, magnitude: 0.18, liquidity: 0.15, stability: 0.15 };
export const SOURCES = {
  kalshi:     { id: "kalshi",     name: "Kalshi",     kind: "prediction-market", sharpness: 0.72, isTarget: true },
  polymarket: { id: "polymarket", name: "Polymarket", kind: "prediction-market", sharpness: 0.8 },
  pinnacle:   { id: "pinnacle",   name: "Pinnacle",   kind: "sportsbook",        sharpness: 0.95 },
  draftkings: { id: "draftkings", name: "DraftKings", kind: "sportsbook",        sharpness: 0.62 },
  fanduel:    { id: "fanduel",    name: "FanDuel",    kind: "sportsbook",        sharpness: 0.6 },
};
const refs = () => Object.values(SOURCES).filter(s => !s.isTarget);
const srcById = id => SOURCES[id] || { id, name: id, sharpness: 0.5, kind: "" };
export const agentIds = () => [...Object.keys(SOURCES).filter(i => i !== "kalshi"), "consensus"];

const r2 = x => Math.round((+x + Number.EPSILON) * 100) / 100;
const r4 = x => Math.round((+x + Number.EPSILON) * 1e4) / 1e4;
const uid = () => "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clamp01 = x => Math.max(0, Math.min(1, x));
const mean = v => { const x = v.filter(isFinite); return x.length ? x.reduce((s, n) => s + n, 0) / x.length : NaN; };
const stdev = v => { const x = v.filter(isFinite); if (x.length < 2) return 0; const m = mean(x); return Math.sqrt(x.reduce((s, n) => s + (n - m) ** 2, 0) / x.length); };
const wmean = (vals, ws) => { let n = 0, d = 0; for (let i = 0; i < vals.length; i++) { const v = vals[i], w = ws[i] ?? 1; if (isFinite(v) && isFinite(w) && w > 0) { n += v * w; d += w; } } return d > 0 ? n / d : NaN; };
export const americanToImplied = a => { a = +a; if (!isFinite(a) || a === 0) return NaN; return a > 0 ? 100 / (a + 100) : -a / (-a + 100); };

const marketSides = mk => mk.sides ? mk.sides : [{ key: "a", name: mk.a }, { key: "b", name: mk.b }];
function fairFromQuote(src, quote, sides) {
  if (!quote) return null;
  const implied = sides.map(s => { const v = quote[s.key]; return src.kind === "sportsbook" ? americanToImplied(v) : Number(v); });
  const sum = implied.reduce((a, b) => a + (isFinite(b) ? b : 0), 0);
  if (!(sum > 0)) return null;
  const fair = {}; sides.forEach((s, i) => (fair[s.key] = implied[i] / sum));
  return fair;
}
function analyzeMarket(fight, mk, minEdge = 0.02) {
  const sides = marketSides(mk), R = refs(), reads = {};
  R.forEach(s => (reads[s.id] = fairFromQuote(s, mk.books?.[s.id], sides)));
  const consensus = {}, disp = {}, asks = {};
  sides.forEach(sd => {
    const vals = R.map(s => (reads[s.id] ? reads[s.id][sd.key] : NaN));
    const ws = R.map(s => (reads[s.id] && isFinite(reads[s.id][sd.key]) ? s.sharpness : 0));
    consensus[sd.key] = wmean(vals, ws);
    disp[sd.key] = stdev(vals.filter(isFinite));
    const q = mk.kalshi?.[sd.key]; asks[sd.key] = q ? (isFinite(q.ask) ? q.ask : +q.last) : NaN;
  });
  const volume = sides.reduce((t, sd) => t + (+(mk.kalshi?.[sd.key]?.volume || 0)), 0);
  const hasKalshi = sides.some(sd => isFinite(asks[sd.key]));
  const build = (id, fairMap, sh) => {
    if (!hasKalshi || !fairMap) return null;
    let best = null;
    sides.forEach(sd => { const fair = fairMap[sd.key], price = asks[sd.key];
      if (!isFinite(fair) || !(price > 0)) return; const roi = fair / price - 1;
      if (roi >= minEdge && (!best || roi > best.roi)) best = { sd, fair, price, roi }; });
    if (!best) return null;
    return { agentId: id, fightId: fight.id, fightName: fight.name, fightSlot: fight.slot, league: fight.league,
      marketKey: mk.key, marketLabel: mk.label, marketType: mk.type, line: mk.line ?? null,
      side: best.sd.key, sideName: best.sd.name, oppName: sides.filter(x => x.key !== best.sd.key).map(x => x.name).join(" / "),
      fairProb: best.fair, kalshiPrice: best.price, edgeRoi: best.roi, edgePts: best.fair - best.price,
      sharpness: sh, dispersion: disp[best.sd.key], volume };
  };
  const signals = [];
  R.forEach(s => { const x = build(s.id, reads[s.id], s.sharpness); if (x) signals.push(x); });
  const cs = build("consensus", consensus, 0.9); if (cs) signals.push(cs);
  return { market: mk, reads, asks, consensus, signals };
}
const analyzeFight = f => ({ fight: f, markets: f.markets.map(mk => analyzeMarket(f, mk)) });
export const analyzeCard = c => ({ ...c, fights: c.fights.map(analyzeFight) });

function scoreConf(sig, am) {
  const price = am.asks[sig.side];
  let agree = 0, tot = 0; const bf = [];
  for (const id in am.reads) { const r = am.reads[id]; if (!r) continue; const fs = r[sig.side]; if (!isFinite(fs)) continue; tot++; bf.push(fs); if (fs > price) agree++; }
  const agreement = tot ? agree / tot : 0;
  const sharpness = sig.agentId === "consensus" ? 0.9 : srcById(sig.agentId).sharpness;
  const roi = sig.edgeRoi; let magnitude;
  if (roi <= 0) magnitude = 0; else if (roi <= 0.12) magnitude = roi / 0.12; else if (roi <= 0.25) magnitude = 1; else magnitude = clamp01(1 - (roi - 0.25) / 0.35);
  const vol = +sig.volume || 0, liquidity = clamp01(Math.log10(vol + 1) / Math.log10(40000));
  const stability = clamp01(1 - sig.dispersion / 0.08);
  const factors = { agreement, sharpness, magnitude, liquidity, stability };
  let s = 0; for (const k in WEIGHTS) s += WEIGHTS[k] * factors[k];
  return { confidence: Math.round(s * 100), factors, detail: { booksAgreeing: agree, booksQuoting: tot, bookFairMean: mean(bf) } };
}
export function confirmCard(an) {
  const edges = [];
  an.fights.forEach(fa => fa.markets.forEach(am => am.signals.forEach(sg => edges.push({ ...sg, ...scoreConf(sg, am) }))));
  edges.sort((x, y) => y.confidence - x.confidence || y.edgeRoi - x.edgeRoi);
  return { all: edges, confirmed: edges.filter(e => e.confidence >= GATE) };
}

// ---- ledger ----
export const RISK_DEFAULT = () => ({ unitPct: 0.02, mode: "kelly", maxSinglePct: 0.05, maxSportPct: 0.25, maxDailyPct: 0.4 });
export function initLedger(ids = agentIds(), st = START) {
  const agents = {}; ids.forEach(id => (agents[id] = { bankroll: st, staked: 0, openCount: 0, settledCount: 0, wins: 0, losses: 0 }));
  return { startingBankroll: st, createdAt: new Date().toISOString(), agents, positions: [], results: {}, risk: RISK_DEFAULT(), logs: [], reports: [], bankrollHistory: [], snapshots: {} };
}
function kelly(bk, price, p) { if (!(price > 0 && price < 1) || !(p > 0 && p < 1)) return 0; const b = (1 - price) / price, f = (b * p - (1 - p)) / b; if (!(f > 0)) return 0; return Math.max(0, bk * Math.min(f * KF, MAXF)); }
function primaryStake(st, e) {
  const a = st.agents.consensus, R = st.risk || RISK_DEFAULT(), bk = a.bankroll;
  const desired = R.mode === "fixed" ? bk * R.unitPct : kelly(bk, e.kalshiPrice, e.fairProb);
  const openBy = f => st.positions.filter(p => p.agentId === "consensus" && p.status === "open" && f(p)).reduce((s, p) => s + p.stake, 0);
  return Math.max(0, Math.min(desired, bk * R.maxSinglePct, bk * R.maxSportPct - openBy(p => p.sport === e.sport), bk * R.maxDailyPct - openBy(() => true), bk));
}
const buildReason = e => `${e.sideName}: model fair ${(e.fairProb * 100).toFixed(1)}% vs Kalshi ${(e.kalshiPrice * 100).toFixed(1)}% — ${(e.edgeRoi * 100).toFixed(1)}% edge, ${e.detail?.booksAgreeing || 0}/${e.detail?.booksQuoting || 0} books agree, ${e.confidence || 0}% confidence.`;

export function placeBet(st, e) {
  const a = st.agents[e.agentId]; if (!a) return null;
  if (st.positions.find(p => p.agentId === e.agentId && p.fightId === e.fightId && p.marketKey === e.marketKey)) return null;
  const stake = e.agentId === "consensus" ? primaryStake(st, e) : Math.min(kelly(a.bankroll, e.kalshiPrice, e.fairProb), a.bankroll);
  if (stake < MINS) return null;
  const contracts = stake / e.kalshiPrice;
  const pos = { id: uid(), agentId: e.agentId, sport: e.sport, league: e.league || e.sport, fightId: e.fightId, fightName: e.fightName,
    marketKey: e.marketKey, marketLabel: e.marketLabel, marketType: e.marketType, line: e.line,
    side: e.side, sideName: e.sideName, stake: r2(stake), contracts: r2(contracts), price: r4(e.kalshiPrice),
    fairProb: r4(e.fairProb), closingProb: r4(e.fairProb), edgeRoi: r4(e.edgeRoi), confidence: e.confidence ?? null,
    reason: buildReason(e), notes: "", units: e.agentId === "consensus" && st.risk ? r2(stake / Math.max(1e-9, a.bankroll * st.risk.unitPct)) : null,
    finalScore: null, status: "open", placedAt: new Date().toISOString(), result: null, grade: null, pnl: 0 };
  a.bankroll = r2(a.bankroll - stake); a.staked = r2(a.staked + stake); a.openCount++; st.positions.push(pos); return pos;
}

// ---- CLV: snapshot the closing line at event start, restamp settled bets ----
export function snapshotClose(st, fightId, marketKey, closingProb) {
  st.snapshots = st.snapshots || {};
  st.snapshots[`${fightId}:${marketKey}`] = { closingProb: r4(closingProb), at: new Date().toISOString() };
  st.positions.forEach(p => { if (p.fightId === fightId && p.marketKey === marketKey) p.closingProb = r4(closingProb); });
}

// ---- settlement (for Phase 3 grading; included so the module is complete) ----
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
  st.positions.forEach(p => { if (p.fightId !== fid || p.marketKey !== mkey || p.status !== "open") return;
    const a = st.agents[p.agentId], won = p.side === win, payout = won ? p.contracts : 0;
    p.result = won ? "win" : "loss"; p.grade = p.result; p.pnl = r2(payout - p.stake); p.status = "settled"; p.settledAt = new Date().toISOString();
    a.bankroll = r2(a.bankroll + payout); a.openCount = Math.max(0, a.openCount - 1); a.settledCount++; won ? a.wins++ : a.losses++; });
}
export function applyResult(st, fight, res) {
  st.results[fight.id] = res;
  fight.markets.forEach(mk => { const w = resolveSide(mk, res); if (w) settleMarket(st, fight.id, mk.key, w); });
}

export function accountStats(st) {
  const R = st.risk || RISK_DEFAULT(), a = st.agents.consensus || { bankroll: st.startingBankroll };
  const mine = st.positions.filter(p => p.agentId === "consensus"), settled = mine.filter(p => p.status === "settled");
  const dec = settled.filter(p => p.grade === "win" || p.grade === "loss");
  const wins = dec.filter(p => p.grade === "win").length, losses = dec.length - wins;
  const profit = r2(settled.reduce((s, p) => s + p.pnl, 0)), staked = r2(dec.reduce((s, p) => s + p.stake, 0));
  const clvA = dec.map(p => p.closingProb - p.price).filter(isFinite);
  const open = mine.filter(p => p.status === "open");
  return { start: st.startingBankroll, bankroll: r2(a.bankroll), unit: r2(a.bankroll * R.unitPct),
    profit, roi: staked > 0 ? r2(profit / staked * 100) : 0, staked, wins, losses,
    winPct: dec.length ? r2(wins / dec.length * 100) : null, clv: clvA.length ? r2(mean(clvA) * 100) : null,
    openCount: open.length, exposure: r2(open.reduce((s, p) => s + p.stake, 0)) };
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

export const migrate = s => {
  if (!s || !s.agents) return initLedger();
  s.snapshots = s.snapshots || {}; s.logs = s.logs || []; s.reports = s.reports || []; s.bankrollHistory = s.bankrollHistory || [];
  for (const id of agentIds()) if (!s.agents[id]) s.agents[id] = { bankroll: START, staked: 0, openCount: 0, settledCount: 0, wins: 0, losses: 0 };
  return s;
};
