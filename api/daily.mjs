// ============================================================================
// api/daily.mjs — the ONE command you run locally each day.
//
//   ODDS_API_KEY=your_key  node api/daily.mjs
//
// It uses your real Odds API key (FEED auto-selects "sim": real book odds +
// real final scores + a simulated Kalshi execution price), and STORE=file so
// the journal PERSISTS on your disk in ./data/state.json and ACCUMULATES day
// over day. Each run:
//   1) grades yesterday's finished games from real scores,
//   2) snapshots closing lines (for CLV),
//   3) places today's confirmed plays from real odds,
//   4) rebuilds  edge/dashboard-local.html  (self-contained — open it directly),
//   5) writes    edge/journal-export.json    (hand to Claude / push to update
//      the hosted artifact; same link).
//
// This is the REAL edge test: real odds, real outcomes, real CLV & calibration
// accumulating over weeks — unlike the demo seed, whose outcomes are modeled.
// ============================================================================

// Default to LIVE (real book odds vs REAL Kalshi prices). Override with
// FEED=sim to test the pipeline with a simulated Kalshi price instead.
if (!process.env.FEED) process.env.FEED = "live";

import { runPoll } from "./poll.mjs";
import { runClose } from "./close.mjs";
import { runGrade } from "./grade.mjs";
import { loadState } from "../lib/store.mjs";
import { feedMode } from "../lib/providers.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const step = m => process.stderr.write(`\n▶ ${m}…\n`);

export async function runDaily() {
  step("Grading finished games (real scores)");
  const grade = await runGrade("all");     // settle finished games (real scores)
  step("Snapshotting closing lines (CLV)");
  const close = await runClose({ scope: "all" }); // snapshot closing lines (CLV)
  step("Polling for today's plays (real odds + Kalshi)");
  const poll = await runPoll("all");       // place today's confirmed plays
  step("Writing dashboard + journal export");

  const state = await loadState();
  const { oddsCache, priceHistory, ...journal } = state; // drop heavy internal caches
  const json = JSON.stringify(journal);

  await mkdir("./edge", { recursive: true });
  await writeFile("./edge/journal-export.json", json);

  // Bake the journal into a self-contained dashboard you can open with no server.
  const tpl = await readFile("./edge/dashboard-standalone.html", "utf8");
  const html = tpl.replace(
    /var SEED_STATE=null; \/\*__JOURNAL_INJECT__\*\//,
    `var SEED_STATE=${json}; /*__JOURNAL_INJECT__*/`,
  );
  await writeFile("./edge/dashboard-local.html", html);

  return { feed: feedMode(), grade, close, poll, positions: state.positions.length, exportKB: Math.round(json.length / 1024) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await runDaily();
  const s = out.poll.stats, c = out.poll.credits || {};
  console.log(`\n✅ Daily run complete — feed: ${out.feed}`);
  if (out.feed === "mock") console.log("   ⚠ No ODDS_API_KEY — running on mock data. Set your key for real odds.");
  const k = out.poll.kalshi;
  if (k) {
    console.log(`   Kalshi: ${k.openMarkets} open markets · matched ${k.gamesMatched}/${k.gamesScanned} games to real Kalshi prices`);
    if (!k.gamesMatched) console.log("   ⚠ 0 games matched Kalshi. It may not list these sports right now — run `node api/kalshi-scan.mjs` and send Claude the output. (Or FEED=sim to test the logic.)");
  }
  const w = out.poll.window;
  if (w) console.log(`   Timing window: games kicking off within ${w.maxHours}h · skipped ${w.skipped} game(s) outside it (tune with TIMING_MAX_HOURS)`);
  console.log(`   Scanned ${out.poll.games} tradeable games · placed ${out.poll.newConsensusPlays.length} new plays · graded ${out.grade.gamesGraded}`);
  out.poll.newConsensusPlays.forEach(p => console.log("     + " + p));
  console.log(`   Bankroll $${s.bankroll} · ROI ${s.roi}% · record ${s.wins}-${s.losses} · CLV ${s.clv ?? "—"} pts`);
  if (c.remaining != null) console.log(`   Odds credits remaining: ${c.remaining}`);
  console.log(`\n   📈 Open  edge/dashboard-local.html  to view the journal (accumulates every run).`);
  console.log(`   📤 To update the hosted artifact: push edge/journal-export.json (or paste it to Claude).\n`);
}
