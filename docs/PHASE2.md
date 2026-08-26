# Phase 2 — Shared persistence + server-side ledger

Moves the paper ledger off the dashboard's per-browser `localStorage` onto a
**shared server-side store**, so the poller and the dashboard read the same
state. Adds CLV snapshotting. Runs with zero setup (a JSON file); swaps to
Vercel KV for production by setting env vars.

## What's here

| File | Role |
|------|------|
| `lib/engine.mjs` | Authoritative engine (odds math, edge/confidence, ledger, settlement, CLV) — ported from the dashboard so the server scores/places identically. |
| `lib/store.mjs` | Persistence with two adapters — `file` (dev) and `kv` (prod) — one interface: `loadState()` / `saveState()`. |
| `api/state.mjs` | `GET` current state (dashboard reads); `POST` risk settings / reset. |
| `api/poll.mjs` | Now loads state → scores → **places confirmed paper bets** → persists. Idempotent per market. |

## Run it

```bash
node api/poll.mjs --sport=mlb   # places bets into ./data/state.json
node api/poll.mjs --sport=mlb   # run again: 0 new plays (idempotent), bankroll unchanged
```

State lives in `./data/state.json` (gitignored). Delete it to reset.

## State shape

One JSON document — the exact shape the engine uses:
`{ startingBankroll, agents{ id -> {bankroll,staked,wins,losses,...} }, positions[], results{}, risk{}, logs[], reports[], bankrollHistory[], snapshots{} }`.
`snapshots` holds closing-line reads keyed `fightId:marketKey` for **CLV**
(`snapshotClose()` restamps each bet's `closingProb`; CLV = closing − entry price).

## Go to production (Vercel KV)

1. Add a KV / Upstash Redis store to the Vercel project → it injects
   `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
2. Set `STORE=kv`.
3. Everything else is unchanged — the store interface is identical.

## Placement is server-side by design

The **client never places bets** — only `api/poll.mjs` does. `api/state.mjs`
exposes reads and safe settings writes, so a browser can't inflate the ledger.

## Remaining wiring (Phase 2.5)

Point the dashboard at `GET /api/state` instead of `localStorage` (behind a
served-over-HTTP check, keeping the standalone file working via localStorage
fallback). That naturally turns the client into a **renderer** of server state —
at which point the dashboard's inline engine copy retires and `lib/engine.mjs`
is the single source of truth. Then **Phase 3**: cron calls `/api/poll` on a
schedule, an event-start job calls `snapshotClose()` for CLV, and a post-event
job grades from a scores feed.
