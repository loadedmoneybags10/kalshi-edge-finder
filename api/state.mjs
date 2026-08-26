// ============================================================================
// /api/state — the shared paper-ledger state (Phase 2).
//
//   GET  /api/state              -> current state (the dashboard reads this)
//   POST /api/state  { risk }    -> update risk settings (unit %, caps, mode)
//   POST /api/state  { reset:1 } -> reset the ledger to a fresh $1,000 bankroll
//
// Settlement/grading writes land here too in Phase 3. Bet PLACEMENT is done by
// the poller, not the client, so the client can't inflate the ledger.
// ============================================================================

import { loadState, saveState, storeKind } from "../lib/store.mjs";
import { initLedger, agentIds, RISK_DEFAULT } from "../lib/engine.mjs";

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const state = await loadState();
      res.status(200).json({ store: storeKind(), state });
      return;
    }
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      let state = await loadState();
      if (body.reset) state = initLedger(agentIds());
      if (body.risk) state.risk = { ...RISK_DEFAULT(), ...state.risk, ...body.risk };
      await saveState(state);
      res.status(200).json({ ok: true, store: storeKind() });
      return;
    }
    res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
}
