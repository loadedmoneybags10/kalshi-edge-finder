// ============================================================================
// api/kalshi-scan.mjs — discover what Kalshi ACTUALLY offers for sports.
//
//   node api/kalshi-scan.mjs
//
// No API key needed (Kalshi market data is public). It pulls all open Kalshi
// markets, groups them by series, flags the sports-looking ones, and prints
// samples WITH prices. Paste the output back to Claude so the real-Kalshi
// matcher is built against reality — not guesses. Writes the full dump to
// ./data/kalshi-scan.json too.
// ============================================================================

import { listAllMarkets, listAllEvents, KALSHI_BASE } from "../lib/kalshi.mjs";
import { writeFile, mkdir } from "node:fs/promises";

const SPORTS_RE = /\b(beat|defeat|vs\.?|win|game|match|fight|moneyline|spread|cover|over\/under|total|runs|points|goals)\b/i;
const TEAMY = /(yankees|dodgers|mets|braves|red sox|cubs|astros|giants|eagles|chiefs|cowboys|bills|49ers|ravens|arsenal|chelsea|liverpool|madrid|barcelona|bayern|juventus|inter|milan|psg|manchester|tottenham)/i;

const text = m => [m.title, m.yes_sub_title, m.no_sub_title, m.subtitle, m.event_ticker, m.ticker].filter(Boolean).join(" · ");
const looksSporty = m => SPORTS_RE.test(text(m)) || TEAMY.test(text(m)) || /GAME|MLB|NFL|NBA|NHL|SOCCER|UFC|EPL|LALIGA|SERIEA|BUNDES|UCL|WNBA|CFB/i.test(m.series_ticker || m.ticker || "");

async function main() {
  const base = process.env.KALSHI_BASE || KALSHI_BASE;
  console.log(`Scanning Kalshi open markets @ ${base} …`);
  const { markets, pages } = await listAllMarkets(base, { maxPages: 20 });
  console.log(`Fetched ${markets.length} open markets across ${pages} page(s).\n`);

  // Series inventory.
  const bySeries = new Map();
  for (const m of markets) {
    const s = m.series_ticker || (m.ticker || "").split("-")[0] || "(none)";
    if (!bySeries.has(s)) bySeries.set(s, { count: 0, sample: m.title, sporty: 0 });
    const e = bySeries.get(s); e.count++; if (looksSporty(m)) e.sporty++;
  }
  const inv = [...bySeries.entries()].map(([series, v]) => ({ series, markets: v.count, sporty: v.sporty, sample: v.sample }))
    .sort((a, b) => b.sporty - a.sporty || b.markets - a.markets);

  const sporty = markets.filter(looksSporty);
  console.log(`Sports-looking markets: ${sporty.length} of ${markets.length}\n`);
  console.log("Top series (by sports-looking count):");
  inv.slice(0, 25).forEach(r => console.log(`  ${r.series.padEnd(22)} markets:${String(r.markets).padStart(4)}  sporty:${String(r.sporty).padStart(4)}  e.g. "${(r.sample || "").slice(0, 50)}"`));

  console.log("\nSample sports markets (with prices):");
  sporty.slice(0, 25).forEach(m => console.log(
    `  [${m.series_ticker || (m.ticker || "").split("-")[0]}] ${m.ticker}\n     title="${m.title}"  yes="${m.yes_sub_title || ""}"  bid/ask=${m.yes_bid}/${m.yes_ask}  last=${m.last_price}  vol=${m.volume}  close=${m.close_time || ""}`));

  await mkdir("./data", { recursive: true });
  await writeFile("./data/kalshi-scan.json", JSON.stringify({
    base, total: markets.length, sportyCount: sporty.length,
    seriesInventory: inv,
    sportySample: sporty.slice(0, 60).map(m => ({
      series: m.series_ticker, ticker: m.ticker, title: m.title, yes_sub: m.yes_sub_title, no_sub: m.no_sub_title,
      yes_bid: m.yes_bid, yes_ask: m.yes_ask, last: m.last_price, volume: m.volume, close: m.close_time,
    })),
  }, null, 2));
  console.log(`\nFull dump → ./data/kalshi-scan.json`);
  console.log(`\n👉 Paste this output (or that file) to Claude. If 'sports-looking markets' is ~0,`);
  console.log(`   Kalshi isn't listing these games right now and we'll adapt to what it DOES cover.`);
}
main().catch(e => { console.error("Kalshi scan failed:", e?.message || e); process.exit(1); });
