// ============================================================================
// api/kalshi-explore.mjs — find Kalshi's single-GAME (moneyline) series.
//
//   node api/kalshi-explore.mjs
//
// /series?category=Sports returns ALL sports series (props, futures, and games).
// We filter that list to the major leagues and print each series' ticker+title,
// then slowly (rate-limit-safe) sample markets from the most game-like series to
// reveal the real ticker/team/price shape for moneyline markets.
// Paste the whole output back to Claude.
// ============================================================================

if (!process.env.FEED) process.env.FEED = "live";

import { kalshiGet } from "../lib/kalshi.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- pull the full sports series list ----
let series = [];
{
  const r = await kalshiGet("/series?category=Sports");
  series = r.json?.series || (Array.isArray(r.json) ? r.json : []);
  console.log(`Sports series total: ${series.length} (status ${r.status})`);
}
const tick = s => s.ticker || s.series_ticker || "";
const title = s => s.title || "";

// ---- A) league menus: every series ticker + title per league keyword ----
const LEAGUES = {
  MLB: /MLB|BASEBALL/i, NFL: /NFL|\bPRO ?FOOTBALL/i, NBA: /NBA|\bPRO ?BASKET/i,
  EPL: /EPL|PREMIER/i, MLS: /\bMLS\b/i, LALIGA: /LALIGA|LA ?LIGA/i,
  SERIEA: /SERIEA|SERIE ?A/i, BUNDES: /BUNDES/i, UCL: /UCL|CHAMPIONS ?LEAGUE/i, UEL: /UEL|EUROPA/i,
};
const gameLike = s => /(matchup|moneyline|money ?line|winner|to win|\bh2h\b|\bwin\b|game\b)/i.test(title(s)) && !/(1st half|2nd half|quarter|half |award|trophy|mvp|coach|draft|advance|treble|champion|season|record|next td|scorer|total|spread|btts|sellout)/i.test(title(s));

const gameCandidates = [];
for (const [lg, re] of Object.entries(LEAGUES)) {
  const hits = series.filter(s => re.test(tick(s)) || re.test(title(s)));
  console.log(`\n=== ${lg}: ${hits.length} series ===`);
  for (const s of hits) {
    const g = gameLike(s);
    console.log(`   ${g ? "★" : " "} ${tick(s)}  | ${title(s)}`);
    if (g) gameCandidates.push(tick(s));
  }
}

// ---- B) slowly sample markets from the ★ game-like series ----
console.log(`\n=== Sampling ${gameCandidates.length} game-like series (slow, to avoid 429) ===`);
for (const st of gameCandidates.slice(0, 14)) {
  await sleep(600);
  const r = await kalshiGet(`/markets?series_ticker=${encodeURIComponent(st)}&status=open&limit=4`);
  if (r.status === 429) { console.log(`\n   ${st}: 429 rate-limited (retrying once)`); await sleep(1500); }
  const r2 = r.status === 429 ? await kalshiGet(`/markets?series_ticker=${encodeURIComponent(st)}&status=open&limit=4`) : r;
  const mk = r2.json?.markets || [];
  console.log(`\n   ${st}: status ${r2.status}, ${mk.length} open market(s)`);
  for (const m of mk.slice(0, 3)) {
    console.log(`      • ${m.ticker}  close ${m.close_time}`);
    console.log(`          title : ${m.title}`);
    console.log(`          yes   : ${m.yes_sub_title}   no: ${m.no_sub_title}`);
    console.log(`          price : ask ${m.yes_ask_dollars} bid ${m.yes_bid_dollars} last ${m.last_price_dollars} vol ${m.volume_fp}`);
  }
}
console.log("\n=== end ===");
