# Phase 2.5 + 3 — Dashboard on the shared store, and the automated pipeline

## Phase 2.5 — dashboard reads the shared ledger

The board now hydrates from `GET /api/state` when it's **served over HTTP**, and
falls back to `localStorage` on `file://` (so the standalone artifact is
unchanged). In server mode:

- placement/automation is **not** done client-side — the poller/cron owns it
  (the dashboard skips `rescanAll`/`autoDaily`);
- `save()` is a no-op (the server store is authoritative);
- **Reset** and **Run daily automation** call the server (`/api/state` reset,
  and `/api/poll` → `/api/close` → `/api/grade`) then re-hydrate.

Seam to finish later: the **Active Bets** edge list is still scored from the
dashboard's built-in `CARDS`. Full fidelity = the poller also serves the live
card, so the board scans exactly what the server placed. Ledger views
(Bankroll, Profile, Analytics, Reports) already read straight from the store.

## Phase 3 — the automated pipeline

Three jobs, all idempotent, all runnable locally with no keys:

| Job | File | Does |
|-----|------|------|
| **Poll** | `api/poll.mjs` | fetch odds → score → place confirmed bets → persist (edge-triggered entry) |
| **Close** | `api/close.mjs` | at/after start time, snapshot the final Kalshi price per market → CLV = closing − entry |
| **Grade** | `api/grade.mjs` | fetch final scores → settle decided games → update bankroll/records → write daily report |

```bash
node api/poll.mjs --sport=mlb     # place
node api/close.mjs --force        # CLV snapshot (force ignores start-time gating)
node api/grade.mjs                # settle from final scores
```

Proven end-to-end (mock): poll placed 2 → grade settled 2-0 → bankroll
$957.61 → $1037.17; a second grade settles 0 (idempotent).

## Scheduling (`vercel.json`)

Crons are set **daily** (Hobby-plan safe). The continuous edge-triggered model
wants frequent polling — on **Pro**, change `poll` to `*/10 * * * *` and `close`
to `0 * * * *`. Times are UTC.

## Go live checklist

1. `ODDS_API_KEY` (The Odds API) + `USE_MOCK=0`.
2. Add Vercel KV → sets `KV_REST_API_URL` / `KV_REST_API_TOKEN`; set `STORE=kv`.
3. Deploy. The crons run poll/close/grade; the dashboard reads `/api/state`.
4. Extend `lib/normalize.mjs` with the soccer (three-way) + UFC mappers so the
   feed covers all sports, not just MLB.
5. Let it run **paper** for a real sample and watch **out-of-sample CLV** — that's
   the go/no-go bar before any real money.
