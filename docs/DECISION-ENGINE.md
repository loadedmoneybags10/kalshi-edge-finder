# Decision-Quality Upgrade — Technical Changelog

Goal of this pass: make the existing system answer *"is there a statistically
defensible, positive-EV trade after costs, uncertainty, and risk?"* — not
"where is the biggest Kalshi/book gap?" The bot is now **more conservative and
more quantitative**, optimized for decision quality and calibration, not trade
frequency. **No player props were added** (hard requirement — see below).

---

## 1. Files changed

**New**
- `lib/config.mjs` — every tunable in one place (weights, uncertainty, fees,
  slippage, staleness, signal-quality, the net-EV gate, risk caps).
- `lib/quant.mjs` — pure, side-effect-free decision math.
- `lib/analytics.mjs` — Brier / log-loss / calibration / CLV / source performance.
- `test/quant.test.mjs`, `test/analytics.test.mjs`, `test/engine.test.mjs` — 33 unit/integration tests.
- `docs/DECISION-ENGINE.md` — this document.

**Rewritten / extended**
- `lib/engine.mjs` — decision pipeline, net-EV gate, structured rejections,
  correlation-aware risk, richer position records, CLV, migration.
- `edge/dashboard-standalone.html` — decision breakdown per card, TRADE/NO-TRADE
  verdicts + reasons, "Below the gate" rejections, calibration/CLV analytics.
- `api/poll.mjs` — new pipeline (analyze → gate → place), price-history logging.
- `api/state.mjs` — returns `stats` + `analytics` for the dashboard.
- `api/close.mjs` — records CLV independently of the result.
- `lib/providers.mjs` — one mock market strengthened so a genuine edge clears the gate.
- `package.json` — `npm test`.

The seeded `edge/dashboard-demo.html` intentionally retains the **legacy** engine
as a frozen historical snapshot (not migrated).

---

## 2. What changed (by concept)

| Area | Before | After |
|---|---|---|
| Edge | `fair/price − 1` (gross) drove the gate | Gross **and** net EV; the gate uses **net EV on the conservative probability** |
| Confidence | "confidence" score read as a win probability, 85 gate | **Signal Quality** (opportunity quality, not win prob), separate from probability |
| Agreement | binary count of books above price | **weighted dispersion** (how tightly sources cluster) |
| Weights | hardcoded "sharpness", presented as fact | **labeled heuristic fallbacks**; per-source Brier tracked for future learned weights |
| Uncertainty | none | every fair prob carries **± uncertainty**; a **conservative** prob is used to decide |
| Divergence | none | **model − consensus** penalizes lone dissent; hard cap rejects |
| Costs | none | **Kalshi fees + estimated slippage**; a thin edge disappears net |
| Staleness | none | **staleness score** from book-vs-Kalshi movement (input, not a trigger) |
| Risk | Kelly on gross fair; single/sport/daily caps | **¼-Kelly on net EV**; single/event/team/sport/daily/**correlated** caps |
| Correlation | none | tags (event/team/market-family/direction); same-team markets share a budget |
| Rejections | silent | **structured reason** per candidate, stored |
| CLV | closing − entry | same, but **recorded independently of the result**, net-of-fees P&L |
| Calibration | none | Brier, log loss, ECE, reliability curve, process-vs-luck CLV |

---

## 3. Mathematical changes (the formulas in use)

Probabilities and prices are in `[0,1]` (dollars per $1 contract).

**Implied probability (American):** `p⁺ = 100/(a+100)` for `a>0`; `p⁻ = −a/(−a+100)` for `a<0`.

**De-vig (n-way, proportional):** `fairᵢ = impliedᵢ / Σ impliedⱼ`.

**Weighted consensus:** `C = Σ wᵢ pᵢ / Σ wᵢ` (wᵢ = source weight).

**Dispersion (weighted stdev):** `D = √( Σ wᵢ (pᵢ − C)² / Σ wᵢ )`.

**Divergence:** `Δ = modelProb − C` (0 for the consensus agent).

**Uncertainty (linear, clamped):**
`u = clamp( base + k_D·D + k_N/√n + k_Δ·|Δ|, u_min, u_max )`
with `base=0.015, k_D=1.0, k_N=0.03, k_Δ=0.5, u∈[0.01,0.15]`.

**Conservative probability:** `p_c = clamp01(modelProb − u)`  (we always buy the side, so haircut downward).

**Kalshi fee (per contract, $):** `f = coef·P·(1−P)`, `coef=0.07`.
Order total rounds up to the cent: `ceil(coef·C·P·(1−P)·100 − ε)/100`.

**Slippage (per contract, prob pts, provisional):**
`s = clamp( 0.5·(ask−bid) + k·(contracts/depthProxy), 0, 0.05 )`, `depthProxy = 0.10·volume`.

**Cost per contract:** `cost = ask + f + s`.

**Gross return:** `modelProb/ask − 1`.  **Net return:** `(p_c − cost)/cost`.  ← the gate.

**Kelly (on net EV):** effective price `= cost`, `p = p_c`,
`f* = p − (1−p)/b`, `b = (1−cost)/cost`; stake `= bankroll · min(¼·f*, maxSingle)`, then capped by event/team/sport/daily/correlated room.

**Signal Quality (0–100):**
`Σ wₖ·factorₖ × divergencePenalty × 100`, factors =
{agreement `1−D/D_ref`, reliability `mean(w)/0.95`, magnitude `netReturn/mag_ref`, liquidity `log₁₀(vol+1)/log₁₀(liq_ref)`, freshness `1−staleness`}.

**Staleness:** `max( lag, 0.5·age )` where `lag` = shortfall of Kalshi movement vs `0.35×` the book move (only when the book moved ≥ 2 pts), `age = min(1, quoteAge/30m)`.

**Calibration:** bucket by predicted prob; `ECE = Σ (nᵦ/N)·|meanPredᵦ − winRateᵦ|`.
**Brier** `= mean((p−o)²)`; **Log loss** `= −mean(o·ln p + (1−o)·ln(1−p))` (p clamped off {0,1}).

---

## 4. New database (position + state) fields

**Per position:** `fixtureId/eventId`, `backedTeam`, `opposingTeam`, `direction`,
`marketFamily`, `actualFillPrice`, `fees`, `estimatedSlippage`, `modelProb`,
`consensusProb`, `uncertainty`, `conservativeProb`, `probEdge`, `grossEv`,
`netEv`, `signalQuality`, `dispersion`, `nBooks`, `staleness`,
`marketDivergence`, `clv`, `modelVersion`, `consensusVersion`,
`confirmationVersion`. (Legacy `fairProb`, `edgeRoi`, `closingProb`, `confidence`
retained as aliases; `migrate()` backfills the new ones.)

**Per state:** `priceHistory` (for staleness), `candidates` (latest run's
consensus decisions), `rejections` (rolling), `schemaVersion: 2`.

---

## 5. New configuration values (`lib/config.mjs`)

`SOURCES[*].weight/provenance`, `WEIGHTS_LEARNING` (enabled, minSamples,
brierRef, floor), `UNCERTAINTY` (base, kDispersion, kFewBooks, kDivergence,
min, max), `DIVERGENCE` (softCap, hardCap), `FEES.kalshiCoef`, `SLIPPAGE`
(halfSpreadWeight, kSizeImpact, depthFromVolume, maxSlippage), `STALENESS`
(windowMs, moveThreshold, kalshiFollowRatio, maxAgeMs, historyCap), `SIGNAL`
(weights, refs, gate=70), `GATE` (minNetEv=0.03, minProbEdgePts=0.02,
minConservativeEdgePts=0.005, minLiquidityVolume=500, maxSpread=0.10,
maxUncertainty=0.12, maxDispersion=0.06), `RISK_DEFAULT`
(kellyFraction=0.25, maxSingle=0.03, maxEvent=0.05, maxTeam=0.06,
maxSport=0.20, maxDaily=0.30, maxCorrelated=0.05), `CALIBRATION`
(buckets=10, minBucketSamples=20, minTotalForAdjust=300).

---

## 6. Tests added (33 total, all passing)

- **quant (15):** American→implied, de-vig (2-way & 3-way), weighted mean/stdev,
  consensus/dispersion, uncertainty, conservative prob, divergence, fees
  (incl. a float-rounding bug this caught), slippage, gross/net EV, Kelly,
  staleness, signal quality, reliability.
- **analytics (8):** predictions extraction, Brier, log loss, calibration + ECE,
  CLV process-vs-luck, source performance fallback labeling, sample-threshold gating.
- **engine (10):** placement + single-cap sizing, ALREADY_BET, correlated/team cap
  rejection, event cap, settlement P&L net of fees, CLV independent of result,
  losing-trade-with-+CLV, shadow-agent sizing, recordCandidates, migration.

`npm test` → **33 pass, 0 fail.** Mock pipeline regression: 1 trade placed →
settled win → bankroll 1000 → 1028.55; analytics Brier 0.173, log loss 0.537.

---

## 7. Remaining assumptions (be honest)

- **Source weights are heuristic fallbacks**, not measured. Learned weights are
  wired but OFF until ≥200 graded predictions per source.
- **Slippage is estimated** — the public feed has no order-book depth, so we
  charge half-spread + a volume-proxy size impact. Conservative but unproven.
- **"Model" == book consensus** today (no separate predictive model), so the
  consensus agent's divergence is ~0; divergence currently disciplines
  single-book agents. The hooks exist for a real model later.
- **Fee coefficient (0.07)** is Kalshi's published general rate; verify per series.
- Staleness needs multiple polls of history to activate (0 on first sight, 0 in mock).

---

## 8. NOT implemented (by design)

- **Player props — NOT added.** No prop ingestion, prop models, player-stat
  modeling, or Monte-Carlo simulation. The probability/EV/risk/execution/
  settlement/analytics layers are all sport-agnostic so a future `prop-engine`
  can plug into them, but nothing prop-specific was built.
- No new sports or market types were added.
- Learned weights are scaffolded but not active (insufficient data).

---

## 9. Recommended next step (before props or real money)

1. **Get real data flowing** (the discovery probe → confirm Kalshi sports series
   → wire the matcher) so out-of-sample CLV and calibration are measured on
   live prices, not mock.
2. **Collect ≥300 graded consensus trades**, then read the calibration curve and
   ECE. If our 70%s don't win ~70%, the fair-prob model — not the plumbing — is
   the thing to fix.
3. **Validate CLV first, P&L second.** Positive mean CLV on a few hundred trades
   is the real green light; win rate on small samples is noise.
4. Only once calibration + CLV hold up, turn on **learned source weights**, then
   consider a separate prop engine.
