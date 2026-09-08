// ============================================================================
// /api/poll — multi-sport ingestion + paper-bet placement.
//
// Scans every enabled competition (MLB daily + soccer matchday + UFC events),
// fetches book odds + Kalshi prices, normalizes to the engine's card shape,
// runs the net-EV decision pipeline, and PLACES confirmed paper bets into the
// shared store. Idempotent per market. Runs in MOCK mode with no keys.
//
//   Local:  node api/poll.mjs                (all sports)
//           node api/poll.mjs --sport=mlb    (one bucket)
//   HTTP:   GET /api/poll                     (all sports; writes the KV store)
//           GET /api/poll?sport=mlb           (one bucket)
// ============================================================================

import { fetchBookOdds, fetchKalshiMarkets, feedMode, fetchActiveSports, oddsCredits, oddsConfig } from "../lib/providers.mjs";
import { buildMlbFixture, buildSoccerFixture, buildUfcFixture } from "../lib/normalize.mjs";
import { buildSimCard } from "../lib/simkalshi.mjs";
import { enabledCompetitions, COMPETITIONS } from "../lib/competitions.mjs";
import {
  analyzeCard, confirmCard, tryPlace, recordCandidates, recordPriceHistory,
  snapshotBankroll, accountStats,
} from "../lib/engine.mjs";
import { loadState, saveState, storeKind, storeStatus } from "../lib/store.mjs";

const cents = m => ({ ask: m.yes_ask / 100, bid: m.yes_bid / 100, last: m.last_price / 100, volume: m.volume });
const iso = () => new Date().toISOString();

// ---------- MLB (mock ticker scheme) ----------
const MLB_ABBR = {
  "Los Angeles Dodgers": "LAD", "Atlanta Braves": "ATL", "Philadelphia Phillies": "PHI",
  "Seattle Mariners": "SEA", "New York Yankees": "NYY", "Houston Astros": "HOU",
};
const mlbCode = e => (MLB_ABBR[e.away_team] || "") + (MLB_ABBR[e.home_team] || "");
const mlbExpand = tok => Object.keys(MLB_ABBR).find(n => MLB_ABBR[n] === tok) || tok;
function parseMlb(t) {
  const p = t.split("-"), gameCode = p[2], typeRaw = p[3], sideTok = p[4];
  if (typeRaw.startsWith("OU")) return { gameCode, type: "ou", line: +typeRaw.slice(2) / 10, sideTok };
  if (typeRaw.startsWith("RL")) return { gameCode, type: "rl", sideTok };
  return { gameCode, type: "ml", sideTok };
}
export async function pollMlbCard() {
  const [events, kalshi] = await Promise.all([fetchBookOdds("mlb"), fetchKalshiMarkets("mlb")]);
  const byCode = new Map(events.map(e => [mlbCode(e), e]));
  const grouped = new Map();
  for (const mk of kalshi.markets || []) {
    const pk = parseMlb(mk.ticker), e = byCode.get(pk.gameCode); if (!e) continue;
    const g = grouped.get(pk.gameCode) || {}, yes = cents(mk);
    if (pk.type === "ml") g.ml = { yes, yesSide: mlbExpand(pk.sideTok) === e.away_team ? "a" : "b" };
    else if (pk.type === "ou") g.ou = { yes, line: pk.line, yesSide: pk.sideTok === "OVER" ? "a" : "b" };
    else if (pk.type === "rl") g.rl = { yes, yesSide: "a", favSide: mlbExpand(pk.sideTok) === e.away_team ? "a" : "b" };
    grouped.set(pk.gameCode, g);
  }
  const fights = [];
  for (const [code, k] of grouped) if (k.ml && k.ou && k.rl) fights.push(buildMlbFixture(byCode.get(code), k));
  return card("mlb", "MLB", fights);
}

// ---------- Soccer (mock ticker scheme) ----------
const SOCCER_CODE = { "Arsenal": "ARS", "Chelsea": "CHE", "Liverpool": "LIV", "Manchester City": "MCI" };
function parseSoccer(t) {
  const p = t.split("-"), code = p[2], mkt = p[3], side = (p[4] || "").toLowerCase();
  if (mkt === "1X2") return { code, type: "1x2", side };
  if (mkt.startsWith("OU")) return { code, type: "ou", line: +mkt.slice(2) / 10, side };
  if (mkt === "BTTS") return { code, type: "btts", side };
  return { code, type: "?" };
}
export async function pollSoccerCard(compKey) {
  const [events, kalshi] = await Promise.all([fetchBookOdds(compKey), fetchKalshiMarkets(compKey)]);
  const groups = new Map();
  for (const mk of kalshi.markets || []) {
    const pk = parseSoccer(mk.ticker), g = groups.get(pk.code) || {}, yes = cents(mk);
    if (pk.type === "1x2") g[pk.side] = yes;
    else if (pk.type === "ou") g.ou = { yes, line: pk.line };
    else if (pk.type === "btts") g.btts = { yes };
    groups.set(pk.code, g);
  }
  const fights = [];
  for (const e of events) {
    const ch = SOCCER_CODE[e.home_team], ca = SOCCER_CODE[e.away_team]; if (!ch || !ca) continue;
    let k = null;
    for (const [code, g] of groups) if (code.includes(ch) && code.includes(ca)) { k = g; break; }
    if (!k || !k.home || !k.draw || !k.away || !k.ou || !k.btts) continue;
    fights.push(buildSoccerFixture(e, { match: { home: k.home, draw: k.draw, away: k.away }, ou: k.ou, btts: k.btts }, compKey));
  }
  return card("mls", compKey.toUpperCase(), fights);
}

// ---------- UFC (mock ticker scheme) ----------
const UFC_CODE = { "Umar Nurmagomedov": "UMAR", "Song Yadong": "SONG", "Aoriqileng": "AORI", "Kai Asakura": "ASA" };
const ufcExpand = tok => Object.keys(UFC_CODE).find(n => UFC_CODE[n] === tok) || tok;
function parseUfc(t) {
  const p = t.split("-"), code = p[2], mkt = p[3], side = p[4];
  if (mkt === "ML") return { code, type: "ml", side };
  if (mkt.startsWith("OU")) return { code, type: "ou", line: +mkt.slice(2) / 10, side };
  return { code, type: "?" };
}
export async function pollUfcCard() {
  const [events, kalshi] = await Promise.all([fetchBookOdds("ufc"), fetchKalshiMarkets("ufc")]);
  const groups = new Map();
  for (const mk of kalshi.markets || []) {
    const pk = parseUfc(mk.ticker), g = groups.get(pk.code) || {}, yes = cents(mk);
    if (pk.type === "ml") { g.mlYes = yes; g.mlTok = pk.side; }
    else if (pk.type === "ou") g.ou = { yes, line: pk.line, sideTok: pk.side };
    groups.set(pk.code, g);
  }
  const fights = [];
  for (const e of events) {
    const ca = UFC_CODE[e.away_team], ch = UFC_CODE[e.home_team]; if (!ca || !ch) continue;
    let g = null;
    for (const [code, gg] of groups) if (code.includes(ca) && code.includes(ch)) { g = gg; break; }
    if (!g || !g.mlYes) continue;
    const k = { ml: { yes: g.mlYes, yesSide: ufcExpand(g.mlTok) === e.away_team ? "a" : "b" } };
    if (g.ou) k.ou = { yes: g.ou.yes, line: g.ou.line, yesSide: g.ou.sideTok === "OVER" ? "a" : "b" };
    fights.push(buildUfcFixture(e, k));
  }
  return card("ufc", "UFC", fights);
}

const card = (sport, label, fights) => ({
  sport, label: `${label} — ${feedMode()} poll`, date: iso().slice(0, 10), generatedAt: iso(),
  source: feedMode(), fights,
});

// Odds cache lives in state so the cron's close+poll (and repeat polls within a
// day) share ONE paid fetch per competition. TTL configurable via ODDS_TTL_MIN.
const ODDS_TTL_MS = (+(process.env.ODDS_TTL_MIN ?? 360)) * 60000;
async function getOddsCached(state, comp) {
  state.oddsCache = state.oddsCache || {};
  const c = state.oddsCache[comp.key];
  if (c && Date.now() - new Date(c.at).getTime() < ODDS_TTL_MS) return { events: c.events, cached: true };
  const events = await fetchBookOdds(comp.key);   // paid call
  state.oddsCache[comp.key] = { at: new Date().toISOString(), events };
  return { events, cached: false };
}

// Build the right card for a competition by its engine bucket + feed mode.
// In sim/live mode it uses the shared odds cache (and reports a paid fetch).
export async function buildCardFor(comp, state = {}) {
  if (feedMode() === "sim") {                    // REAL odds + SIMULATED Kalshi
    const { events, cached } = await getOddsCached(state, comp);
    const c = buildSimCard(comp, events); c.paidFetch = !cached; return c;
  }
  if (comp.sport === "mlb") return pollMlbCard(); // mock / live ticker-matched
  if (comp.sport === "mls") return pollSoccerCard(comp.key);
  if (comp.sport === "ufc") return pollUfcCard();
  return card(comp.sport, comp.key.toUpperCase(), []);
}

// Which competitions to scan for a scope: "all", a bucket ("mlb"), or a comp key.
export function pickComps(scope) {
  const all = enabledCompetitions();
  if (!scope || scope === "all") return all;
  if (COMPETITIONS[scope]) return all.filter(c => c.key === scope);
  return all.filter(c => c.sport === scope); // treat scope as a bucket
}

// Load state → scan competitions → score → place confirmed bets → persist.
export async function runPoll(scope = "all") {
  const state = await loadState();
  state.fixtures = state.fixtures || {};
  const now = Date.now();
  const placed = [], consensusCandidates = [], scanned = [];
  let games = 0, noTrade = 0, paidFetches = 0;

  // Credit-saver: skip out-of-season leagues using the FREE /sports check.
  const active = await fetchActiveSports(); // Set of active odds keys, or null (mock → scan all)
  const comps = pickComps(scope).filter(c => !active || active.has(c.oddsSport));
  const skippedOffSeason = active ? pickComps(scope).length - comps.length : 0;

  for (const comp of comps) {
    let c;
    try { c = await buildCardFor(comp, state); if (c.paidFetch) paidFetches++; }
    catch (e) { scanned.push({ comp: comp.key, error: String(e?.message || e) }); continue; }
    if (!c || !c.fights.length) { scanned.push({ comp: comp.key, games: 0 }); continue; }
    games += c.fights.length;
    scanned.push({ comp: comp.key, games: c.fights.length });

    for (const f of c.fights)
      state.fixtures[f.id] = {
        id: f.id, sport: f.sport, league: f.league, name: f.name, sideA: f.sideA, sideB: f.sideB,
        commenceTime: f.commenceTime,
        markets: f.markets.map(m => ({ key: m.key, type: m.type, line: m.line ?? null, favSide: m.favSide ?? null })),
      };

    const an = analyzeCard(c, state.priceHistory || {}, now);
    const { all, candidates } = confirmCard(an);
    consensusCandidates.push(...candidates);
    for (const d of all.filter(x => x.decision === "TRADE")) {
      const r = tryPlace(state, { ...d });
      if (r.status === "placed" && r.pos.agentId === "consensus")
        placed.push(`${r.pos.sport.toUpperCase()} · ${r.pos.fixtureName} — ${r.pos.sideName} @ ${(r.pos.price * 100).toFixed(0)}¢ ($${r.pos.stake})`);
    }
    noTrade += candidates.filter(d => d.decision === "NO_TRADE").length;
    recordPriceHistory(state, an, now);
  }

  recordCandidates(state, consensusCandidates);
  snapshotBankroll(state);
  await saveState(state);
  const credits = oddsCredits();
  return { store: storeKind(), storeStatus: storeStatus(), source: feedMode(),
    scanned, games, newConsensusPlays: placed, noTrade, stats: accountStats(state),
    credits: {
      leaguesScanned: comps.length, skippedOffSeason, paidFetches,
      creditsPerCall: oddsConfig().creditsPerCall,
      estCreditsThisRun: paidFetches * oddsConfig().creditsPerCall,
      remaining: credits.remaining, used: credits.used, markets: oddsConfig().markets,
    } };
}

// ---- Vercel handler ----
export default async function handler(req, res) {
  try {
    const scope = (req.query?.sport || "all").toLowerCase();
    res.status(200).json(await runPoll(scope));
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
}

// ---- Local CLI ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv.find(a => a.startsWith("--sport="));
  const out = await runPoll(arg ? arg.split("=")[1] : "all");
  console.log(`\nPoll (${out.source}) -> store: ${out.store}   games: ${out.games}   no-trade: ${out.noTrade}`);
  console.log(`New consensus plays: ${out.newConsensusPlays.length}`);
  out.newConsensusPlays.forEach(p => console.log(`  + ${p}`));
  const s = out.stats;
  console.log(`\nBankroll $${s.bankroll}  |  open ${s.openCount}  |  exposure $${s.exposure}  |  ROI ${s.roi}%\n`);
}
