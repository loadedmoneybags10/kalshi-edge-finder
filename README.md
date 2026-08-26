# Kalshi Edge Finder

A self-contained, paper-trading **sports-betting edge finder** for Kalshi. It compares Kalshi's prices against a consensus of reference books (Pinnacle, DraftKings, FanDuel, Polymarket), de-vigs each market, scores every candidate on a 0–100 confidence scale, and only "buys" plays that clear an **85% confidence gate** — all on a $1,000 paper bankroll with full risk management.

> **Paper only — no real money.** Odds are representative pre-match snapshots; a live deploy would run the same engine on real-time quotes.

## Sports & markets (one engine, per-league logic)

| Sport | Markets | Leagues |
|-------|---------|---------|
| **UFC** | Winner · Method (finish/distance) · Rounds O/U | UFC |
| **Soccer** | Match result (1X2, three-way) · Goals O/U · BTTS | MLS · EPL · La Liga · Serie A · Bundesliga |
| **MLB** | Moneyline · Run line (±1.5) · Runs O/U | MLB |

Soccer is one "sport" bucket (so bankroll sizing and the max-sport exposure cap behave consistently), with each fixture tagged by league so the Profile and Analytics views break out per-competition.

## How it works

- **Odds math** — American ↔ implied probability; n-way multiplicative de-vig; sharpness-weighted consensus fair line.
- **Edge & confidence** — per-agent +EV signals scored on agreement, sharpness, magnitude, liquidity, and stability; a confirmation agent gates at 85%.
- **Paper ledger** — the funded "consensus" (Kalshi) account plus shadow book agents, each with a $1,000 bankroll and total P&L. Unit staking (¼ Kelly or fixed) capped by risk limits: max single 5%, max sport 25%, max daily 40%.
- **Two data layers** — *Active Bets* (open only) and an immutable *Profile* archive of every settled wager, with combinable filters (time, book, sport, league, bet type, confidence, result, odds, units).
- **Daily automation** — idempotent grade → recompute bankroll/ROI/records/streaks → archive → regenerate slate → daily report → logs.

## Files

- **`edge/dashboard-standalone.html`** — the dashboard. Open it in any browser; state persists in `localStorage`. No build, no server, no external dependencies.
- **`edge/dashboard-demo.html`** — the same dashboard seeded with a simulated three-week history so results are visible without waiting for live slates (marked with a "Demo · simulated" badge).

## Status

The instrument is complete and validated mechanically. Before any real-money use it needs live-data paper trading — real Kalshi prices settling against real outcomes — with **positive closing-line value (CLV) measured out-of-sample** as the bar for a genuine edge.
