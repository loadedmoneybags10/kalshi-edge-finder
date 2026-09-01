// Pure-math tests for lib/quant.mjs — deterministic, no I/O.
import test from "node:test";
import assert from "node:assert/strict";
import {
  clamp01, weightedMean, weightedStdev, americanToImplied, devig,
  buildConsensus, uncertainty, conservativeProbability, divergenceOf,
  feePerContract, kalshiFeeTotal, slippagePerContract, expectedValue,
  kellyStar, stalenessScore, signalQuality, reliabilityOf,
} from "../lib/quant.mjs";
import { UNCERTAINTY, STALENESS } from "../lib/config.mjs";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test("americanToImplied: favorite and underdog", () => {
  near(americanToImplied(-155), 155 / 255);
  near(americanToImplied(132), 100 / 232);
  near(americanToImplied(100), 0.5);
  assert.ok(Number.isNaN(americanToImplied(0)));
});

test("devig: 2-way removes the vig so fair sums to 1", () => {
  const raw = { a: americanToImplied(-155), b: americanToImplied(132) };
  const fair = devig(raw);
  near(fair.a + fair.b, 1);
  assert.ok(fair.a > fair.b); // favorite has higher fair prob
});

test("devig: 3-way (1X2) sums to 1", () => {
  const raw = { home: 0.5, draw: 0.3, away: 0.28 }; // overround 1.08
  const fair = devig(raw);
  near(fair.home + fair.draw + fair.away, 1);
  near(fair.home, 0.5 / 1.08);
});

test("weightedMean / weightedStdev", () => {
  near(weightedMean([0.6, 0.6, 0.6], [1, 1, 1]), 0.6);
  near(weightedStdev([0.6, 0.6, 0.6], [1, 1, 1]), 0); // perfect agreement → 0
  const mu = weightedMean([0.5, 0.7], [1, 1]);
  near(mu, 0.6);
  near(weightedStdev([0.5, 0.7], [1, 1], mu), 0.1);
});

test("buildConsensus: tight vs dispersed sets differ in dispersion", () => {
  const tight = buildConsensus([
    { id: "pinnacle", weight: 0.95, prob: 0.63 },
    { id: "draftkings", weight: 0.62, prob: 0.63 },
    { id: "fanduel", weight: 0.60, prob: 0.63 },
  ]);
  const dispersed = buildConsensus([
    { id: "pinnacle", weight: 0.95, prob: 0.63 },
    { id: "draftkings", weight: 0.62, prob: 0.70 },
    { id: "fanduel", weight: 0.60, prob: 0.56 },
  ]);
  near(tight.consensus, 0.63);
  near(tight.dispersion, 0);
  assert.ok(dispersed.dispersion > 0.02, "dispersed set has real spread");
  assert.equal(tight.nBooks, 3);
  assert.equal(tight.contributions[0].diffFromConsensus, 0);
});

test("uncertainty widens with dispersion, few books, and divergence", () => {
  const u0 = uncertainty({ dispersion: 0, nBooks: 3, divergence: 0 });
  const uDisp = uncertainty({ dispersion: 0.05, nBooks: 3, divergence: 0 });
  const uFew = uncertainty({ dispersion: 0, nBooks: 1, divergence: 0 });
  const uDiv = uncertainty({ dispersion: 0, nBooks: 3, divergence: 0.1 });
  assert.ok(uDisp > u0 && uFew > u0 && uDiv > u0);
  assert.ok(u0 >= UNCERTAINTY.min && uDisp <= UNCERTAINTY.max);
});

test("conservativeProbability haircuts downward and clamps", () => {
  near(conservativeProbability(0.682, 0.037), 0.645);
  assert.equal(conservativeProbability(0.02, 0.05), 0); // clamps at 0
});

test("divergenceOf = model − consensus", () => {
  near(divergenceOf(0.62, 0.46), 0.16);
});

test("fees: per-contract and rounded-up total", () => {
  near(feePerContract(0.5), 0.07 * 0.25);
  // 100 contracts @ 0.5: 0.07*100*0.25 = 1.75 → ceil to 1.75
  near(kalshiFeeTotal(100, 0.5), 1.75);
  // ensure it rounds UP to the cent
  const f = kalshiFeeTotal(3, 0.5); // 0.07*3*0.25 = 0.0525 → 0.06
  near(f, 0.06);
  assert.equal(feePerContract(1), 0);
});

test("slippage: half-spread plus size impact, capped", () => {
  const s = slippagePerContract({ bid: 0.50, ask: 0.55, volume: 10000, contracts: 100 });
  assert.ok(s >= 0.025, "at least half the 5-pt spread");
  assert.ok(s <= 0.05, "capped");
  const zero = slippagePerContract({ bid: 0.55, ask: 0.55, volume: 10000, contracts: 0 });
  near(zero, 0);
});

test("expectedValue: gross vs net; costs erode a thin edge", () => {
  const ev = expectedValue({ modelProb: 0.60, conservativeProb: 0.57, execPrice: 0.55, feePc: feePerContract(0.55), slipPc: 0.01 });
  near(ev.probEdgePts, 0.05);
  near(ev.grossReturn, 0.60 / 0.55 - 1);
  assert.ok(ev.netReturn < ev.grossReturn, "net is worse than gross");
  assert.ok(ev.costPerContract > 0.55, "cost exceeds bare price");
  // A tiny edge should go net-negative after costs.
  const thin = expectedValue({ modelProb: 0.515, conservativeProb: 0.505, execPrice: 0.50, feePc: feePerContract(0.50), slipPc: 0.02 });
  assert.ok(thin.netReturn < 0, "thin edge disappears net");
});

test("kellyStar: positive only with genuine edge; 0 otherwise", () => {
  assert.ok(kellyStar(0.60, 0.50) > 0);
  assert.equal(kellyStar(0.50, 0.55), 0); // no edge
  assert.equal(kellyStar(0.50, 0.50), 0);
});

test("stalenessScore: flags book-moved / Kalshi-flat, 0 without history", () => {
  const none = stalenessScore(null, STALENESS);
  assert.equal(none.score, 0);
  assert.equal(none.reason, "insufficient-history");

  const now = 1_000_000_000_000;
  const hist = {
    book: [{ t: now - 60000, p: 0.60 }, { t: now - 1000, p: 0.68 }],   // +8 pts
    kalshi: [{ t: now - 60000, p: 0.55 }, { t: now - 1000, p: 0.55 }], // flat
  };
  const s = stalenessScore(hist, STALENESS, now);
  assert.ok(s.score > 0.5, "book moved, Kalshi flat → stale");
});

test("signalQuality: high for clean, penalized for divergence", () => {
  const clean = signalQuality({ dispersion: 0, reliability: 0.9, netReturn: 0.1, volume: 20000, staleness: 0, divergence: 0 });
  const diverged = signalQuality({ dispersion: 0, reliability: 0.9, netReturn: 0.1, volume: 20000, staleness: 0, divergence: 0.18 });
  assert.ok(clean.score > diverged.score, "divergence penalizes quality");
  assert.ok(clean.score >= 70);
  assert.ok(diverged.divergencePenalty < 1);
});

test("reliabilityOf scales toward 1 for sharp books", () => {
  assert.ok(reliabilityOf([0.95]) > reliabilityOf([0.6]));
  assert.ok(reliabilityOf([0.95]) <= 1);
});
