# Feed modes

The pipeline sources data in one of three modes, set by the `FEED` env var.

| `FEED` | Book odds | Final scores | Kalshi price | Use |
|---|---|---|---|---|
| `mock` | simulated | simulated | simulated | UI demo, tests, zero keys |
| **`sim`** | **REAL** (The Odds API) | **REAL** | **simulated** | **recommended now** — paper plays on real games, graded on real results |
| `live` | REAL | REAL | REAL (Kalshi) | pending series-ticker discovery |

Back-compat: `USE_MOCK=0` with no `FEED` set is treated as `sim`.

## SIM mode — what's real and what isn't

**Real:** the games and schedule, the book odds (Pinnacle/DraftKings/FanDuel via
The Odds API), the de-vigged fair probabilities, and the final results used for
grading.

**Simulated:** the Kalshi execution price. For each market we take the real book
consensus and offset one seed-chosen side downward by a modeled amount
(`SIM_EDGE` ± `SIM_WIDTH`), so a fraction of markets show a genuine, gradeable
edge and the rest don't. The offset is deterministic (seeded by
fixture+market+side+date), so a play is **stable across polls** on the same day
— it doesn't flicker in and out before the match.

**Therefore:**
- You see paper plays placed on **real upcoming games**, with the full decision
  breakdown (fair prob, uncertainty, conservative prob, net EV, signal quality…).
- After each game finishes, `/api/grade` settles it on the **real result**, so
  you see whether the play won or lost, with net-of-fees P&L.
- **CLV is not meaningful in SIM** (the sim price tracks the books; it doesn't
  drift like a real market). It becomes meaningful only in `live` mode.

SIM is best understood as a **forward-test of the fair-probability model and the
decision pipeline on live fixtures**, while real Kalshi is still pending. It is
paper only — no real money, and the Kalshi edges are modeled, not observed.

## Tuning SIM

- `SIM_EDGE` (default `0.07`) — mean modeled Kalshi underpricing on the chosen
  side, in probability points. Higher → more plays (more optimistic).
- `SIM_WIDTH` (default `0.09`) — spread of the offset distribution.

Lower `SIM_EDGE` toward `0.03–0.04` for a more conservative, sparser slate that
better resembles how often a real edge would actually appear.

## Enabling SIM on Vercel

1. Set env vars: `ODDS_API_KEY=<your key>`, `FEED=sim`, `STORE=kv`.
2. Redeploy.
3. Click **Reset** on the dashboard for a clean $1,000 slate.
4. Hit `/api/poll` (or wait for the daily cron) to place plays on today's real
   games. `/api/grade` settles them after they finish.
