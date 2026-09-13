// ============================================================================
// api/diag-live.mjs — deep trace of the LIVE decision pipeline for real games,
// using Kalshi's single-game series (KXMLBGAME / KXNFLGAME / …).
//
//   ODDS_API_KEY=your_key ODDS_MARKETS=h2h  node api/diag-live.mjs
//
// For the first few games that match a real Kalshi market it prints:
//   • the bookmakers the Odds API returned + whether booksBlock captured any
//   • the REAL Kalshi ask on BOTH sides (from the KX<SPORT>GAME series)
//   • the consensus probability, and the final decision (TRADE / NO_TRADE + why)
// Paste the whole output back to Claude.
// ============================================================================

if (!process.env.FEED) process.env.FEED = "live";

import { fetchBookOdds, fetchKalshiGameMarkets } from "../lib/providers.mjs";
import { matchGameTwoSided } from "../lib/match.mjs";
import { booksBlock } from "../lib/normalize.mjs";
import { analyzeCard, confirmCard } from "../lib/engine.mjs";
import { COMPETITIONS } from "../lib/competitions.mjs";

const slug = n => String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 6);
const pct = x => (Number.isFinite(x) ? (x * 100).toFixed(1) + "%" : "—");

function liveFight(comp, e, g) {
  const away = e.away_team, home = e.home_team;
  const blk = s => ({ ask: s.ask, bid: s.bid ?? s.ask, last: s.last ?? s.ask, volume: s.volume || 0 });
  return {
    id: `${comp}:${slug(away)}-${slug(home)}`, sport: comp, league: comp,
    name: `${away} vs. ${home}`, slot: "", sideA: away, sideB: home, commenceTime: e.commence_time || null,
    markets: [{
      key: "ml", label: "Moneyline", type: "winner", a: away, b: home,
      kalshi: { a: blk(g.away), b: blk(g.home) },
      books: booksBlock(e, "h2h", oc => (oc.name === away ? "a" : oc.name === home ? "b" : null)),
    }],
  };
}

console.log("=== LIVE pipeline deep trace (per-series Kalshi) ===");
for (const comp of ["mlb", "nfl"]) {
  const series = COMPETITIONS[comp]?.kalshiSeries;
  let events = [], gameMarkets = [];
  try { events = await fetchBookOdds(comp); }
  catch (e) { console.log(`\n===== ${comp}: fetchBookOdds THREW: ${String(e?.message || e).slice(0, 200)}`); continue; }
  gameMarkets = await fetchKalshiGameMarkets(comp);
  console.log(`\n===== ${comp}: ${events.length} Odds games · Kalshi ${series} has ${gameMarkets.length} open markets =====`);
  if (gameMarkets[0]) console.log(`  sample Kalshi market: ${gameMarkets[0].ticker} | ${gameMarkets[0].yes_sub_title} | ask ${gameMarkets[0].yes_ask_dollars}`);

  let shown = 0;
  for (const e of events) {
    const g = matchGameTwoSided(e, gameMarkets, { dateWindowMs: 36 * 3600 * 1000 });
    if (!g) continue;
    const f = liveFight(comp, e, g);
    const mk = f.markets[0];
    console.log(`\n• ${f.name}  (${e.commence_time})`);
    console.log("   books captured :", Object.keys(mk.books).join(", ") || "(EMPTY)");
    console.log("   kalshi ask a/b :", mk.kalshi.a.ask, "/", mk.kalshi.b.ask, " vol", mk.kalshi.a.volume, "/", mk.kalshi.b.volume);
    const an = analyzeCard({ sport: comp, fights: [f] });
    const am = an.fights[0].markets[0];
    console.log("   consensus a/b  :", pct(am.cons.a?.consensus), "/", pct(am.cons.b?.consensus), " nBooks(a):", am.cons.a?.nBooks ?? 0);
    const { candidates } = confirmCard(an);
    for (const d of candidates)
      console.log(`     -> ${d.sideName}: ${d.decision}${d.rejectReason ? " — " + d.rejectReason : ""}  (edge ${pct(d.probEdgePts)}, netEV ${pct(d.netReturn)}, sig ${d.signalQuality}/100)`);
    if (!candidates.length) console.log("     -> no decision formed");
    if (++shown >= 4) break;
  }
  if (!shown) console.log("   (no games matched the Kalshi game series)");
}
console.log("\n=== end ===");
