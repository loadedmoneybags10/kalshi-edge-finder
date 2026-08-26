# Phase 1 — Live data ingestion

Goal: replace the hand-authored odds in the dashboard with **real** Kalshi prices
and reference-book odds, normalized into the shape the edge engine already scores.

Runs in **mock mode** today (no keys, no network) so the pipeline is testable
end-to-end. Flip to live by setting `USE_MOCK=0` and providing keys.

## Scan model (the operating cadence)

Defined in `lib/competitions.mjs`. One daily cron scans every enabled competition;
what differs is how often each *has* games:

| Cadence | Competitions | Behavior |
|---------|--------------|----------|
| `daily` | **MLB** (NBA later) | Games nearly every day — the driver. |
| `matchday` | **MLS, EPL, La Liga, Serie A, Bundesliga, EFL Cup, FA Cup** | Poll runs daily as an **odds-checker**; most days no open markets → finds nothing; fires on match days. |
| `event` | **UFC** | Scanned when a fight card is scheduled. |

Notes: **FA Cup** is registered but its marquee rounds (Premier League clubs) are
January+ — the daily check picks it up when live. The current midweek English cup
is the **EFL (Carabao) Cup**. **NBA** is registered `enabled:false` until tip-off.

## What's here

| File | Role |
|------|------|
| `lib/competitions.mjs` | Competition registry + scan cadence (odds-sport keys, sport bucket, enabled). |
| `lib/providers.mjs` | Feed clients: The Odds API (books) + Kalshi Trade API v2. Mock + real paths. |
| `lib/normalize.mjs` | Pure transform: raw payloads → engine fixture/market shape (`buildMlbFixture`). |
| `api/poll.mjs` | Orchestrates fetch → match → normalize. Vercel function **and** local CLI. |
| `vercel.json` | Function config; placeholder for the Phase-3 cron. |

## Run it

```bash
node api/poll.mjs --sport=mlb      # mock feed, prints a normalized card + edge sanity flags
```

## Go live

1. **Keys** (env vars):
   - `ODDS_API_KEY` — from https://the-odds-api.com (free tier to start).
   - Kalshi market data is a public GET; no key needed for prices. (Real *orders* would need signed auth — not used for paper.)
   - `USE_MOCK=0` to leave mock mode.
2. **Matcher** — `api/poll.mjs` pairs Kalshi tickers to book events via a small
   abbreviation map today. Live, resolve pairs from Kalshi's series/event metadata
   (team names + commence time) instead of the static `ABBR` table.
3. **The engine is unchanged** — `pollMlb()` returns exactly the `{kalshi, books}`
   fixture blocks the dashboard's `analyzeCard`/`confirmCard` already consume.

## Data shapes (reference)

- **The Odds API** event: `{ home_team, away_team, commence_time, bookmakers:[{ key, markets:[{ key:"h2h|totals|spreads", outcomes:[{ name, price, point }] }] }] }`
- **Kalshi** market: `{ ticker, yes_bid, yes_ask, last_price, volume }` — integer cents (0–100), converted to 0–1 probabilities on ingest. The NO side is derived (`NO ask = 1 − YES bid`).

## Next

- **Phase 2** — persist positions/bankroll to a shared store (Vercel KV or Postgres) so the pipeline and the dashboard read the same state, and add a market-snapshots table for CLV.
- **Phase 3** — Vercel cron calls `/api/poll` every few minutes (edge-triggered entry), an event-start job snapshots the closing line, and a post-event job grades from a scores feed.
- **Soccer / UFC** normalizers follow the MLB pattern (three-way de-vig for 1X2; method/rounds for UFC).
