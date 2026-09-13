// ============================================================================
// api/kalshi-explore.mjs — discover Kalshi's REAL sports-game series.
//
//   node api/kalshi-explore.mjs
//
// The bulk /markets feed is flooded by the KXMVECROSSCATEGORY parlay series, so
// paging it never reaches game markets. This probes the RIGHT way:
//   A) /series?category=Sports  → the sports series tickers + titles
//   B) walk /events (higher-level than markets) → series histogram + any event
//      whose title looks like a single game (has "at"/"@"/"vs" or a team name)
//   C) for each candidate sports series, pull a few markets WITH prices to reveal
//      the true ticker/title/price-field shape.
// Paste the whole output back to Claude.
// ============================================================================

if (!process.env.FEED) process.env.FEED = "live";

import { kalshiGet } from "../lib/kalshi.mjs";

const candidates = new Set();

// ---- A) series list, Sports category ----
console.log("=== A) series endpoints ===");
for (const path of ["/series?category=Sports", "/series/?category=Sports", "/series?category=sports", "/series"]) {
  const r = await kalshiGet(path);
  console.log(`\nGET ${path} -> status ${r.status} ok ${r.ok}`);
  if (!r.json) { console.log("   body:", (r.textSample || "").slice(0, 200)); continue; }
  const arr = r.json.series || r.json.data || (Array.isArray(r.json) ? r.json : []);
  console.log("   top-level keys:", Object.keys(r.json).join(", "), "| series count:", Array.isArray(arr) ? arr.length : "n/a");
  for (const s of (Array.isArray(arr) ? arr.slice(0, 60) : [])) {
    const t = s.ticker || s.series_ticker;
    console.log(`      ${t}  | category: ${s.category || ""} | ${s.title || ""}`);
    if (t) candidates.add(t);
  }
  if (Array.isArray(arr) && arr.length) break; // first working form is enough
}

// ---- B) walk events, histogram series, find game-like titles ----
console.log("\n=== B) events feed (series histogram + game-like titles) ===");
const hist = new Map();
const gamey = [];
const RE_GAME = /\b(at|@|vs\.?|v)\b|padres|dodgers|giants|cowboys|packers|yankees|chiefs|jets|bills|ravens|browns/i;
let cursor = "", pages = 0;
for (; pages < 12; pages++) {
  const r = await kalshiGet(`/events?status=open&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  if (!r.json) { console.log("   events fetch failed:", r.status, (r.textSample || "").slice(0, 150)); break; }
  for (const e of r.json.events || []) {
    const sp = e.series_ticker || String(e.event_ticker || "").split("-")[0];
    hist.set(sp, (hist.get(sp) || 0) + 1);
    const text = `${e.title || ""} ${e.sub_title || ""}`;
    if (RE_GAME.test(text) && !/KXMVE/i.test(sp)) { gamey.push({ sp, et: e.event_ticker, title: e.title, sub: e.sub_title }); if (sp) candidates.add(sp); }
  }
  cursor = r.json.cursor || ""; if (!cursor) break;
}
const hs = [...hist.entries()].sort((a, b) => b[1] - a[1]);
console.log(`   walked ${pages + 1} event page(s). Top 30 event series:`);
for (const [s, n] of hs.slice(0, 30)) console.log(`      ${String(n).padStart(5)}  ${s}`);
console.log(`\n   game-like events found: ${gamey.length} (showing up to 25)`);
for (const g of gamey.slice(0, 25)) console.log(`      ${g.sp} | ${g.et} | ${g.title} | ${g.sub || ""}`);

// ---- C) probe markets for each candidate sports series ----
console.log("\n=== C) markets for candidate sports series (with prices) ===");
const sportsish = [...candidates].filter(t => /(NFL|MLB|NBA|NHL|MLS|SOCCER|EPL|LALIGA|SERIEA|BUNDES|UEFA|UCL|UEL|GAME|MATCH|WINNER|MONEYLINE|SPREAD|UFC|MMA|TENNIS|GOLF)/i.test(t));
console.log("   candidate sports series:", sportsish.join(", ") || "(none found — see A/B above)");
for (const series of sportsish.slice(0, 12)) {
  const r = await kalshiGet(`/markets?series_ticker=${encodeURIComponent(series)}&status=open&limit=4`);
  const mk = r.json?.markets || [];
  console.log(`\n   ${series}: status ${r.status}, ${mk.length} market(s)`);
  for (const m of mk.slice(0, 3)) {
    console.log(`      • ${m.ticker}`);
    console.log(`          title: ${m.title}  | yes_sub: ${m.yes_sub_title}`);
    console.log(`          prices: ${JSON.stringify({ yes_ask_dollars: m.yes_ask_dollars, yes_bid_dollars: m.yes_bid_dollars, last_price_dollars: m.last_price_dollars, volume_fp: m.volume_fp, close_time: m.close_time })}`);
  }
}
console.log("\n=== end ===");
