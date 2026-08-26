// ============================================================================
// /api/poll — ingestion + paper-bet placement (Phases 1–2).
//
// Fetches book odds + Kalshi prices, normalizes to the engine's card shape,
// scores edges, and PLACES confirmed paper bets into the shared store. Idempotent
// per market (placeBet skips a market already bet). Runs in MOCK mode, no keys.
//
//   Local:   node api/poll.mjs --sport=mlb     (writes ./data/state.json)
//   HTTP:    GET /api/poll?sport=mlb            (on Vercel; writes the KV store)
//
// Phase 3's cron calls this on a schedule (edge-triggered entry).
// ============================================================================

import { fetchBookOdds, fetchKalshiMarkets } from "../lib/providers.mjs";
import { buildMlbFixture } from "../lib/normalize.mjs";
import { analyzeCard, confirmCard, placeBet, snapshotBankroll, accountStats } from "../lib/engine.mjs";
import { loadState, saveState, storeKind } from "../lib/store.mjs";

const ABBR = {
  "Los Angeles Dodgers": "LAD", "Atlanta Braves": "ATL",
  "Philadelphia Phillies": "PHI", "Seattle Mariners": "SEA",
};
const codeFor = e => (ABBR[e.away_team] || "") + (ABBR[e.home_team] || "");
const expand = tok => Object.keys(ABBR).find(name => ABBR[name] === tok) || tok;

function parseTicker(t) {
  const p = t.split("-");
  const gameCode = p[2], typeRaw = p[3], sideTok = p[4];
  if (typeRaw.startsWith("OU")) return { gameCode, type: "ou", line: +typeRaw.slice(2) / 10, sideTok };
  if (typeRaw.startsWith("RL")) return { gameCode, type: "rl", sideTok };
  return { gameCode, type: "ml", sideTok };
}
const cents = m => ({ ask: m.yes_ask / 100, bid: m.yes_bid / 100, last: m.last_price / 100, volume: m.volume });

// Fetch + match + normalize -> a card in the engine's shape.
export async function pollMlbCard() {
  const [events, kalshi] = await Promise.all([fetchBookOdds("mlb"), fetchKalshiMarkets("KXMLBGAME")]);
  const byCode = new Map(events.map(e => [codeFor(e), e]));
  const grouped = new Map();
  for (const mk of kalshi.markets || []) {
    const pk = parseTicker(mk.ticker);
    const e = byCode.get(pk.gameCode); if (!e) continue;
    const g = grouped.get(pk.gameCode) || {}; const yes = cents(mk);
    if (pk.type === "ml") { const t = expand(pk.sideTok); g.ml = { yes, yesSide: t === e.away_team ? "a" : "b" }; }
    else if (pk.type === "ou") g.ou = { yes, line: pk.line, yesSide: pk.sideTok === "OVER" ? "a" : "b" };
    else if (pk.type === "rl") { const t = expand(pk.sideTok); g.rl = { yes, yesSide: "a", favSide: t === e.away_team ? "a" : "b" }; }
    grouped.set(pk.gameCode, g);
  }
  const fights = [];
  for (const [code, k] of grouped) if (k.ml && k.ou && k.rl) fights.push(buildMlbFixture(byCode.get(code), k));
  return { sport: "mlb", label: "MLB — live poll", date: new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(), source: process.env.USE_MOCK !== "0" ? "mock" : "live", fights };
}

// Load state -> score card -> place confirmed bets (all agents) -> persist.
export async function runPoll(sport = "mlb") {
  const card = await pollMlbCard();               // (soccer/UFC cards land here once normalized)
  const state = await loadState();
  const { confirmed } = confirmCard(analyzeCard(card));
  const placed = [];
  for (const e of confirmed) {
    const pos = placeBet(state, { ...e, sport: card.sport });
    if (pos && pos.agentId === "consensus") placed.push(`${pos.fightName} — ${pos.sideName} @ ${(pos.price * 100).toFixed(0)}¢ ($${pos.stake})`);
  }
  snapshotBankroll(state);
  await saveState(state);
  return { store: storeKind(), source: card.source, games: card.fights.length,
    newConsensusPlays: placed, stats: accountStats(state) };
}

// ---- Vercel handler ----
export default async function handler(req, res) {
  try {
    const sport = (req.query?.sport || "mlb").toLowerCase();
    if (sport !== "mlb") { res.status(400).json({ error: `sport '${sport}' not wired yet (mlb only in Phase 1)` }); return; }
    res.status(200).json(await runPoll(sport));
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
}

// ---- Local CLI ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await runPoll("mlb");
  console.log(`\nPoll (${out.source}) -> store: ${out.store}   games: ${out.games}`);
  console.log(`New consensus plays this run: ${out.newConsensusPlays.length}`);
  out.newConsensusPlays.forEach(p => console.log(`  + ${p}`));
  const s = out.stats;
  console.log(`\nBankroll $${s.bankroll}  |  open plays ${s.openCount}  |  exposure $${s.exposure}  |  ROI ${s.roi}%\n`);
}
