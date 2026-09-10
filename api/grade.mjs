// ============================================================================
// /api/grade — settle decided games from scores feeds (multi-sport).
//
// Scans every enabled competition, fetches final scores, matches each completed
// game to a stored fixture by team-name tokens (sport-scoped), settles its open
// paper bets with the sport's result mapper, updates bankroll/records, and
// writes a daily report. Idempotent — a game already in state.results is skipped.
//
//   Local:  node api/grade.mjs            (all sports)
//   Cron:   GET /api/grade                 (daily; see vercel.json)
// ============================================================================

import { fetchScores } from "../lib/providers.mjs";
import { resultFromScore, soccerResultFromScore, ufcResultFromScore, nflResultFromScore } from "../lib/normalize.mjs";
import { applyResult, accountStats, snapshotBankroll, pushReport, logAuto } from "../lib/engine.mjs";
import { loadState, saveState, storeKind } from "../lib/store.mjs";
import { pickComps } from "./poll.mjs";
import { overlap } from "../lib/match.mjs";

const RESULT_OF = { mlb: resultFromScore, nfl: nflResultFromScore, mls: soccerResultFromScore, ufc: ufcResultFromScore };

// Find the stored fixture for a completed score event: same sport, and both of
// the event's teams recognizable in the fixture's two sides.
function matchFixture(state, sport, ev) {
  const fixtures = Object.values(state.fixtures || {}).filter(f => f.sport === sport && !state.results[f.id]);
  for (const f of fixtures) {
    const text = `${f.sideA || ""} ${f.sideB || ""} ${f.name || ""}`;
    if (overlap(ev.home_team, text) >= 1 && overlap(ev.away_team, text) >= 1) return f;
  }
  return null;
}

export async function runGrade(scope = "all") {
  const state = await loadState();
  const before = accountStats(state);
  const graded = [];

  // Credit-saver: only fetch scores for leagues that actually have OPEN bets to
  // settle. Grading a league with nothing open would just waste scores credits.
  const openLeagues = new Set((state.positions || []).filter(p => p.status === "open").map(p => p.league));
  const comps = pickComps(scope).filter(c => openLeagues.has(c.key) || openLeagues.has(c.sport));
  for (const comp of comps) {
    let scores;
    try { scores = await fetchScores(comp.key); } catch { continue; }
    const mapper = RESULT_OF[comp.sport];
    if (!mapper) continue;
    for (const ev of scores) {
      if (!ev.completed) continue;
      const fix = matchFixture(state, comp.sport, ev);
      if (!fix || state.results[fix.id]) continue;
      const res = mapper(ev);
      if (!res) continue;
      applyResult(state, fix, res);
      graded.push(fix.id);
    }
  }

  if (graded.length) {
    const settledToday = state.positions.filter(p => p.agentId === "consensus" && p.status === "settled" &&
      graded.includes(p.fixtureId || p.fightId));
    const w = settledToday.filter(p => p.grade === "win").length, l = settledToday.filter(p => p.grade === "loss").length;
    const dayPnl = settledToday.reduce((s, p) => s + p.pnl, 0);
    snapshotBankroll(state);
    pushReport(state, { graded: settledToday.length, w, l, dayPnl });
    logAuto(state, `Graded ${graded.length} game(s): ${w}W-${l}L, day P/L ${dayPnl >= 0 ? "+" : ""}$${dayPnl.toFixed(2)}.`, "grade");
    await saveState(state);
  }

  const after = accountStats(state);
  return { store: storeKind(), gamesGraded: graded.length,
    bankroll: `$${before.bankroll} -> $${after.bankroll}`,
    record: `${after.wins}-${after.losses}`, roi: after.roi, clv: after.clv };
}

export default async function handler(req, res) {
  try { res.status(200).json(await runGrade((req.query?.sport || "all").toLowerCase())); }
  catch (err) { res.status(500).json({ error: String(err?.message || err) }); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv.find(a => a.startsWith("--sport="));
  const out = await runGrade(arg ? arg.split("=")[1] : "all");
  console.log(`\nGrade (${out.store}) -> games graded: ${out.gamesGraded}`);
  console.log(`Bankroll ${out.bankroll}  |  record ${out.record}  |  ROI ${out.roi}%  |  CLV ${out.clv ?? "—"} pts\n`);
}
