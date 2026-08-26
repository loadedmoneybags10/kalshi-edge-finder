// ============================================================================
// /api/close — snapshot the closing line for CLV (Phase 3).
//
// At/after each game's start time, record the final Kalshi price per market and
// stamp it onto the bets on that market. CLV = closing price − entry price:
// positive CLV (the market moved toward our side after we bet) is the leading
// indicator of a real edge, more reliable than win rate on small samples.
//
//   Local:  node api/close.mjs --force   (force ignores start-time gating)
//   Cron:   GET /api/close   (hourly; see vercel.json)
// ============================================================================

import { pollMlbCard } from "./poll.mjs";
import { loadState, saveState, storeKind } from "../lib/store.mjs";

export async function runClose({ force = false } = {}) {
  const state = await loadState();
  const card = await pollMlbCard();
  const now = Date.now();
  let snapped = 0;

  for (const f of card.fights) {
    const started = force || (f.commenceTime && new Date(f.commenceTime).getTime() <= now);
    if (!started) continue;
    for (const m of f.markets) {
      const a = m.kalshi?.a?.ask ?? null, b = m.kalshi?.b?.ask ?? null;
      // Stamp each bet's closing price with the final ask on the side it holds.
      state.positions.forEach(p => {
        if (p.fightId !== f.id || p.marketKey !== m.key) return;
        const close = p.side === "a" ? a : b;
        if (close != null) p.closingProb = close;
      });
      state.snapshots = state.snapshots || {};
      state.snapshots[`${f.id}:${m.key}`] = { a, b, at: new Date().toISOString() };
      snapped++;
    }
  }

  await saveState(state);
  return { store: storeKind(), marketsSnapshotted: snapped,
    note: "closing line = final Kalshi ask; CLV = closing − entry (0 in mock — prices are static; real polling captures drift)" };
}

export default async function handler(req, res) {
  try { res.status(200).json(await runClose({ force: req.query?.force === "1" })); }
  catch (err) { res.status(500).json({ error: String(err?.message || err) }); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await runClose({ force: process.argv.includes("--force") });
  console.log(`\nClose (${out.store}) -> markets snapshotted: ${out.marketsSnapshotted}`);
  console.log(`  ${out.note}\n`);
}
