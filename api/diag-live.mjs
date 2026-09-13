// ============================================================================
// api/diag-live.mjs — deep trace of the LIVE decision pipeline for real games.
//
//   ODDS_API_KEY=your_key ODDS_MARKETS=h2h  node api/diag-live.mjs
//
// For the first few games that match a real Kalshi market, it prints EXACTLY
// what the engine sees and decides:
//   • which bookmakers the Odds API returned
//   • whether booksBlock captured any of them (EMPTY = the bug)
//   • the real Kalshi ask/bid per side
//   • the consensus probability + book count
//   • the final decision (TRADE / NO_TRADE + reason) — or why no candidate formed
// Paste the whole output back to Claude.
// ============================================================================

if (!process.env.FEED) process.env.FEED = "live";

import { fetchBookOdds, fetchKalshiOpenMarkets } from "../lib/providers.mjs";
import { matchMoneyline } from "../lib/match.mjs";
import { twoWayKalshi, booksBlock } from "../lib/normalize.mjs";
import { analyzeCard, confirmCard } from "../lib/engine.mjs";

const slug = n => String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 6);
const pct = x => (Number.isFinite(x) ? (x * 100).toFixed(1) + "%" : "—");

function liveFight(comp, e, ml) {
  const away = e.away_team, home = e.home_team;
  const yesSide = ml.yesTeam === "away" ? "a" : "b";
  return {
    id: `${comp}:${slug(away)}-${slug(home)}`, sport: comp, league: comp,
    name: `${away} vs. ${home}`, slot: "", sideA: away, sideB: home, commenceTime: e.commence_time || null,
    markets: [{
      key: "ml", label: "Moneyline", type: "winner", a: away, b: home,
      kalshi: twoWayKalshi(ml.yes, yesSide),
      books: booksBlock(e, "h2h", oc => (oc.name === away ? "a" : oc.name === home ? "b" : null)),
    }],
  };
}

console.log("=== LIVE pipeline deep trace ===");
const kMarkets = await fetchKalshiOpenMarkets();
console.log("Kalshi open markets loaded:", kMarkets.length);

for (const comp of ["mlb", "nfl"]) {
  let events = [];
  try { events = await fetchBookOdds(comp); }
  catch (e) { console.log(`\n===== ${comp}: fetchBookOdds THREW: ${String(e?.message || e).slice(0, 200)}`); continue; }
  console.log(`\n===== ${comp}: ${events.length} games from Odds API =====`);
  if (events[0]) console.log("First game raw bookmaker keys:", (events[0].bookmakers || []).map(b => b.key).join(", ") || "(none)");

  let shown = 0;
  for (const e of events) {
    const ml = matchMoneyline(e, kMarkets, { dateWindowMs: 36 * 3600 * 1000 });
    if (!ml) continue;
    const f = liveFight(comp, e, ml);
    const mk = f.markets[0];
    console.log(`\n• ${f.name}  (${e.commence_time})`);
    console.log("   bookmakers returned:", (e.bookmakers || []).map(b => b.key).join(", ") || "(none)");
    console.log("   booksBlock captured :", Object.keys(mk.books).join(", ") || "(EMPTY  ← this is the bug)");
    console.log("   kalshi  a.ask/b.ask :", mk.kalshi.a?.ask, "/", mk.kalshi.b?.ask, " vol", mk.kalshi.a?.volume);
    const an = analyzeCard({ sport: comp, fights: [f] });
    const am = an.fights[0].markets[0];
    console.log("   consensus a/b       :", pct(am.cons.a?.consensus), "/", pct(am.cons.b?.consensus), " nBooks(a):", am.cons.a?.nBooks ?? 0);
    const { candidates } = confirmCard(an);
    console.log("   consensus candidates:", candidates.length || "0  (no decision formed → likely no book reads)");
    for (const d of candidates)
      console.log(`     -> ${d.sideName}: ${d.decision}${d.rejectReason ? " — " + d.rejectReason : ""}  (edge ${pct(d.probEdgePts)}, netEV ${pct(d.netReturn)}, sig ${d.signalQuality}/100)`);
    if (++shown >= 3) break;
  }
  if (!shown) console.log("   (no games matched a Kalshi market)");
}
console.log("\n=== end ===");
