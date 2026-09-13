// ============================================================================
// api/diag.mjs — why did the LIVE poll find 0 games?
//
//   ODDS_API_KEY=your_key  node api/diag.mjs
//
// Zero-guesswork diagnosis of the Odds API side of the pipeline:
//   1) Is the key even valid?           (FREE /sports self-test, 0 credits)
//   2) Which sports are "active" now?    (does the credit-saver see baseball_mlb?)
//   3) Do real games actually come back? (direct odds probe: MLB + NFL)
// Paste the whole output back to Claude.
// ============================================================================

if (!process.env.FEED) process.env.FEED = "live";

import { feedMode, oddsSelfTest, fetchActiveSports, fetchBookOdds, oddsCredits, oddsConfig } from "../lib/providers.mjs";
import { enabledCompetitions } from "../lib/competitions.mjs";

const key = process.env.ODDS_API_KEY || "";
console.log("=== Odds API diagnosis ===");
console.log("Feed mode      :", feedMode());
console.log("ODDS_API_KEY   :", key ? `present — ${key.length} chars, starts "${key.slice(0, 4)}…", ends "…${key.slice(-4)}"` : "MISSING");

// 1) Key validity (free).
const self = await oddsSelfTest();
console.log("\n[1] /sports self-test (free):");
console.log("   " + JSON.stringify(self));

// 2) Active-sports gate — the credit-saver filter that the poll uses.
const active = await fetchActiveSports();
console.log("\n[2] fetchActiveSports():", active ? `${active.size} active sport keys returned` : "null (poll would scan ALL leagues)");
if (active) {
  const wanted = [...new Set(enabledCompetitions().map(c => c.oddsSport))];
  console.log("   Does the active set include each enabled league's oddsSport?");
  for (const w of wanted) console.log(`     ${active.has(w) ? "✅ active" : "❌ NOT in active set"}  ${w}`);
}

// 3) Direct odds probe (costs a few credits): do real games come back right now?
for (const ck of ["mlb", "nfl"]) {
  try {
    const events = await fetchBookOdds(ck);
    const n = Array.isArray(events) ? events.length : 0;
    console.log(`\n[3] fetchBookOdds("${ck}") -> ${n} games`);
    if (n) {
      const e = events[0];
      console.log(`     e.g. ${e.away_team} @ ${e.home_team} — ${e.commence_time} — ${e.bookmakers?.length || 0} books`);
    }
  } catch (e) {
    console.log(`\n[3] fetchBookOdds("${ck}") THREW:`);
    console.log("     " + String(e?.message || e).slice(0, 400));
  }
}

const c = oddsCredits();
console.log(`\nCredits — remaining: ${c.remaining ?? "—"}  used: ${c.used ?? "—"}  (each odds call = ${oddsConfig().creditsPerCall} credits: ${oddsConfig().markets})`);
console.log("\n=== end ===");
