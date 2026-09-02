// ============================================================================
// /api/cron — the once-daily pipeline (one cron, Hobby-plan safe).
//
// Runs grade -> close -> poll in sequence: settle finished games, snapshot
// closing lines for CLV, then place today's confirmed edges. Each step is
// idempotent. (On Pro you can split these back into separate, more frequent
// crons — see the individual /api/grade, /api/close, /api/poll endpoints.)
// ============================================================================

import { runPoll } from "./poll.mjs";
import { runClose } from "./close.mjs";
import { runGrade } from "./grade.mjs";

export default async function handler(req, res) {
  try {
    const scope = (req.query?.sport || "all").toLowerCase();
    const grade = await runGrade(scope);      // 1) settle games that finished
    const close = await runClose({ scope });  // 2) snapshot closing lines (CLV)
    const poll = await runPoll(scope);        // 3) place today's new edges
    res.status(200).json({ ok: true, ranAt: new Date().toISOString(), grade, close, poll });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
}
