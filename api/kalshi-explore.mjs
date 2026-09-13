// ============================================================================
// api/kalshi-explore.mjs — discover Kalshi's REAL sports-game market shape.
//
//   node api/kalshi-explore.mjs
//
// The bulk /markets feed mixes 20k markets (politics, novelty, parlays, sports).
// This prints:
//   A) the market "series" (ticker prefix) breakdown, so we can see which series
//      hold single-game sports markets (e.g. KXNFLGAME, KXMLBGAME),
//   B) for a few known teams, the actual markets that mention them WITH real
//      prices — revealing the true ticker/title format and price fields.
// Paste the whole output back to Claude to fix the matcher + price parser.
// ============================================================================

if (!process.env.FEED) process.env.FEED = "live";

import { fetchKalshiOpenMarkets } from "../lib/providers.mjs";

const markets = await fetchKalshiOpenMarkets();
console.log("Total open markets:", markets.length);

// ---- A) series (ticker prefix) histogram ----
const byPrefix = new Map();
for (const m of markets) {
  const p = String(m.ticker || "").split("-")[0];
  byPrefix.set(p, (byPrefix.get(p) || 0) + 1);
}
const sorted = [...byPrefix.entries()].sort((a, b) => b[1] - a[1]);
console.log("\n=== Top 40 series (ticker prefix) by market count ===");
for (const [p, n] of sorted.slice(0, 40)) console.log(`   ${String(n).padStart(6)}  ${p}`);

console.log("\n=== Series that look sports/game related ===");
const RE = /(NFL|MLB|NBA|NHL|MLS|SOCCER|EPL|LALIGA|SERIEA|BUNDES|UEFA|UCL|UEL|GAME|MATCH|WINNER|MONEYLINE|SPREAD|UFC|MMA)/i;
for (const [p, n] of sorted) if (RE.test(p)) console.log(`   ${String(n).padStart(6)}  ${p}`);

// ---- B) real markets for known teams, with prices ----
const priceFields = m => ({
  yes_ask_dollars: m.yes_ask_dollars, yes_bid_dollars: m.yes_bid_dollars,
  last_price_dollars: m.last_price_dollars, volume_fp: m.volume_fp,
  volume_24h_fp: m.volume_24h_fp, open_interest_fp: m.open_interest_fp, liquidity_dollars: m.liquidity_dollars,
});
const textOf = m => [m.title, m.yes_sub_title, m.no_sub_title, m.event_ticker, m.ticker].filter(Boolean).join(" · ").toLowerCase();

const KEYS = ["padres", "dodgers", "cowboys", "chiefs", "packers", "yankees"];
for (const key of KEYS) {
  const hits = markets.filter(m => textOf(m).includes(key));
  const priced = hits.filter(m => m.yes_ask_dollars != null || m.last_price_dollars != null);
  console.log(`\n=== "${key}": ${hits.length} markets mention it, ${priced.length} have a price (showing up to 6 priced, else 3 any) ===`);
  const show = (priced.length ? priced : hits).slice(0, priced.length ? 6 : 3);
  for (const m of show) {
    console.log(`   • ${m.ticker}`);
    console.log(`       title      : ${m.title}`);
    console.log(`       yes_sub    : ${m.yes_sub_title}   no_sub: ${m.no_sub_title}`);
    console.log(`       event      : ${m.event_ticker}   close: ${m.close_time}`);
    console.log(`       prices     : ${JSON.stringify(priceFields(m))}`);
  }
}
console.log("\n=== end ===");
