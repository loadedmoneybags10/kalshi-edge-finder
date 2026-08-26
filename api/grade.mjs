// ============================================================================
// /api/grade — settle decided games from a scores feed (Phase 3).
//
// Fetches final scores, maps each completed game to a result, settles its open
// paper bets, updates bankroll/records, and writes a daily report. Idempotent —
// a game already in state.results is skipped, so re-running never double-settles.
//
//   Local:  node api/grade.mjs
//   Cron:   GET /api/grade   (daily; see vercel.json)
// ============================================================================

import { fetchScores } from "../lib/providers.mjs";
import { resultFromScore } from "../lib/normalize.mjs";
import { applyResult, accountStats, snapshotBankroll, pushReport, logAuto } from "../lib/engine.mjs";
import { loadState, saveState, storeKind } from "../lib/store.mjs";

export async function runGrade(sport = "mlb") {
  const state = await loadState();
  const scores = await fetchScores(sport);
  const before = accountStats(state);
  const graded = [];

  for (const ev of scores) {
    if (!ev.completed) continue;
    const fix = state.fixtures?.[deriveId(ev)];
    if (!fix) continue;                       // no fixture def (never polled) → skip
    if (state.results[fix.id]) continue;      // already settled → idempotent skip
    const res = resultFromScore(ev);
    if (!res) continue;
    applyResult(state, fix, res);
    graded.push(fix.id);
  }

  if (graded.length) {
    const settledToday = state.positions.filter(p => p.agentId === "consensus" && p.status === "settled" &&
      graded.includes(p.fightId));
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

// The scores event's teams -> the fixture id the poller stored.
function deriveId(ev) {
  const slug = n => n.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 6);
  return `mlb:${slug(ev.away_team)}-${slug(ev.home_team)}`;
}

export default async function handler(req, res) {
  try { res.status(200).json(await runGrade((req.query?.sport || "mlb").toLowerCase())); }
  catch (err) { res.status(500).json({ error: String(err?.message || err) }); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await runGrade("mlb");
  console.log(`\nGrade (${out.store}) -> games graded: ${out.gamesGraded}`);
  console.log(`Bankroll ${out.bankroll}  |  record ${out.record}  |  ROI ${out.roi}%  |  CLV ${out.clv ?? "—"} pts\n`);
}
