// ============================================================================
// /api/health — one-shot, live diagnosis of the whole deployment.
//
// Hit this URL and read `verdict`: it live-tests feed mode, the Odds API key,
// and an actual KV write→read round-trip, and lists exactly what's wrong (if
// anything). No values are exposed — only which env var NAMES are present and
// whether each component works.
// ============================================================================

import { storeStatus, kvSelfTest, loadState } from "../lib/store.mjs";
import { feedMode, oddsSelfTest } from "../lib/providers.mjs";

export default async function handler(req, res) {
  const storageEnvVarNamesFound = Object.keys(process.env)
    .filter(k => /KV|REDIS|UPSTASH|STORAGE/i.test(k)).sort();

  const feed = feedMode();
  const env = {
    FEED: process.env.FEED || "(unset — auto: sim if ODDS_API_KEY present, else mock)",
    STORE: process.env.STORE || "(unset → defaults to 'file', NOT persistent on Vercel)",
    USE_MOCK: process.env.USE_MOCK || "(unset)",
    ODDS_MARKETS: process.env.ODDS_MARKETS || "(default h2h,totals,spreads)",
    ODDS_API_KEY: process.env.ODDS_API_KEY ? "present" : "MISSING",
  };

  const [kvTest, oddsTest] = await Promise.all([kvSelfTest(), oddsSelfTest()]);
  const store = storeStatus();

  // What's ACTUALLY persisted right now (reads through the real store).
  let currentState;
  try {
    const st = await loadState();
    const cons = (st.positions || []).filter(p => p.agentId === "consensus");
    const bySport = {};
    for (const p of cons) if (p.status === "open") bySport[p.sport] = (bySport[p.sport] || 0) + 1;
    currentState = {
      totalPositions: (st.positions || []).length,
      openConsensus: cons.filter(p => p.status === "open").length,
      openBySport: bySport, candidates: (st.candidates || []).length,
      bankroll: st.agents?.consensus?.bankroll,
    };
  } catch (e) { currentState = { error: String(e?.message || e) }; }

  const problems = [];
  if (feed === "mock") problems.push("Feed is MOCK — set ODDS_API_KEY (auto-enables real odds) or FEED=sim, then redeploy.");
  if ((process.env.STORE || "file") !== "kv") problems.push("STORE is not 'kv' — set STORE=kv (env change needs a redeploy).");
  if (!kvTest.configured) problems.push("KV credentials NOT FOUND — no URL/TOKEN under any known name. Connect the store to THIS project + redeploy. Names present: " + (storageEnvVarNamesFound.join(", ") || "none"));
  else if (!kvTest.ok) problems.push("KV configured but the write→read test FAILED at '" + kvTest.stage + "': " + (kvTest.error || kvTest.status || "mismatch") + ". Check the token/URL match the same store.");
  if (!oddsTest.keyPresent) problems.push("ODDS_API_KEY missing — real odds can't load.");
  else if (!oddsTest.ok) problems.push("Odds API call FAILED (" + (oddsTest.status || oddsTest.error) + ") — key invalid or out of credits.");

  res.status(200).json({
    now: new Date().toISOString(),
    verdict: problems.length ? problems : ["✅ All systems go — feed=sim, KV read/write OK, Odds API OK. Run /api/poll to place today's plays."],
    feed, env, storageEnvVarNamesFound, store, kvTest, oddsTest, currentState,
  });
}
