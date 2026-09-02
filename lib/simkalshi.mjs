// ============================================================================
// simkalshi.mjs — SIM feed: REAL book odds + a SIMULATED Kalshi execution price.
//
// Purpose (per the brief): run on real games and real book odds, place paper
// plays on UPCOMING matches, and grade them against REAL results — without a
// live Kalshi feed (still pending discovery). The Kalshi side is MODELED: for
// each market we take the real de-vigged book consensus and offset ONE seed-
// chosen side downward (a plausible Kalshi underpricing), so a fraction of
// markets show a genuine, gradeable edge and the rest don't.
//
// HONESTY: the edges here are SIMULATED, not real Kalshi mispricings. CLV is not
// meaningful in SIM (the sim price tracks the books). What IS real: the games,
// the book odds, the fair probabilities, and the final results — so SIM is a
// forward-test of the fair-prob model + the decision pipeline on live fixtures.
//
// Deterministic: the offset is seeded by fixture+market+side+date, so a play is
// STABLE across polls on the same day (it doesn't flicker in and out).
// ============================================================================

import { americanToImplied, devig, weightedMean, clamp, round } from "./quant.mjs";
import { SOURCES } from "./config.mjs";
import { buildMlbFixture, buildSoccerFixture, buildUfcFixture } from "./normalize.mjs";

const BOOK_IDS = new Set(["pinnacle", "draftkings", "fanduel"]);
const W = id => SOURCES[id]?.weight ?? 0.5;

// Mean underpricing applied to the chosen side, and the width of its spread.
// Tunable via env; defaults chosen so a reasonable fraction of markets trade.
const SIM_EDGE = clamp(+(process.env.SIM_EDGE ?? 0.07), 0, 0.15);
const SIM_WIDTH = clamp(+(process.env.SIM_WIDTH ?? 0.09), 0, 0.15);

// Deterministic [0,1) from a string (FNV-1a).
function seedFloat(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}
const pick2 = key => (seedFloat(key) > 0.5 ? "a" : "b");
const underpriceMag = key => clamp(SIM_EDGE + (seedFloat(key + ":m") - 0.5) * SIM_WIDTH, 0.003, 0.14);

// A simulated Kalshi YES orderbook (0–1) targeting mid price `mid`.
function simOB(mid, key) {
  const m = clamp(mid, 0.03, 0.97);
  const half = 0.01 + seedFloat(key + ":h") * 0.02;      // 1–3¢ half-spread
  const vol = 3000 + Math.floor(seedFloat(key + ":v") * 20000);
  return { ask: round(clamp(m + half, 0.02, 0.98)), bid: round(clamp(m - half, 0.02, 0.98)), last: round(m), volume: vol };
}

// Weighted book consensus (de-vigged) per side for one Odds market.
function consensus(event, marketKey, sideOf) {
  const acc = {};
  for (const bm of event.bookmakers || []) {
    if (!BOOK_IDS.has(bm.key)) continue;
    const mkt = (bm.markets || []).find(m => m.key === marketKey);
    if (!mkt) continue;
    const implied = {};
    for (const oc of mkt.outcomes || []) { const s = sideOf(oc); if (s) implied[s] = americanToImplied(oc.price); }
    const fair = devig(implied);
    if (!fair) continue;
    for (const s in fair) { (acc[s] ||= { v: [], w: [] }); acc[s].v.push(fair[s]); acc[s].w.push(W(bm.key)); }
  }
  const out = {};
  for (const s in acc) out[s] = weightedMean(acc[s].v, acc[s].w);
  return out;
}

const totalLine = event => {
  for (const bm of event.bookmakers || []) {
    const t = (bm.markets || []).find(m => m.key === "totals");
    if (t?.outcomes?.[0]?.point != null) return t.outcomes[0].point;
  }
  return 8.5; // fallback if no totals offered
};

// A 2-way sim block: underprice the seed-chosen side by `mag` (the other side
// is derived by the normalizer's twoWayKalshi, so it becomes correspondingly
// pricier — realistic).
function twoWaySim(cons, id, mkt) {
  const side = pick2(`${id}:${mkt}`);
  const mag = underpriceMag(`${id}:${mkt}`);
  const mid = clamp((cons[side] ?? 0.5) - mag, 0.03, 0.97);
  return { yes: simOB(mid, `${id}:${mkt}:${side}`), yesSide: side };
}

// ---- per-sport k builders (real books in, sim Kalshi out) ----
function simMlbK(event) {
  const away = event.away_team, home = event.home_team, id = `${away}@${home}`;
  const cML = consensus(event, "h2h", oc => (oc.name === away ? "a" : oc.name === home ? "b" : null));
  const cTot = consensus(event, "totals", oc => (oc.name === "Over" ? "a" : oc.name === "Under" ? "b" : null));
  const cSpr = consensus(event, "spreads", oc => (oc.point < 0 ? "a" : oc.point > 0 ? "b" : null));
  // favorite = the -1.5 side; map to away(a)/home(b) for grading.
  let favAway = "a";
  for (const bm of event.bookmakers || []) {
    const sp = (bm.markets || []).find(m => m.key === "spreads");
    const favOc = sp?.outcomes?.find(o => o.point < 0);
    if (favOc) { favAway = favOc.name === away ? "a" : "b"; break; }
  }
  if (!Number.isFinite(cML.a) || !Number.isFinite(cTot.a) || !Number.isFinite(cSpr.a)) return null;
  const ml = twoWaySim(cML, id, "ml");
  const ou = twoWaySim(cTot, id, "ou");
  const rl = twoWaySim(cSpr, id, "rl");
  return { ml, ou: { ...ou, line: totalLine(event) }, rl: { ...rl, favSide: favAway } };
}

function simSoccerK(event) {
  const home = event.home_team, away = event.away_team, id = `${home}v${away}`;
  const c = consensus(event, "h2h", oc => (oc.name === home ? "home" : /draw/i.test(oc.name) ? "draw" : oc.name === away ? "away" : null));
  const cTot = consensus(event, "totals", oc => (oc.name === "Over" ? "a" : oc.name === "Under" ? "b" : null));
  if (!Number.isFinite(c.home) || !Number.isFinite(c.draw) || !Number.isFinite(c.away)) return null;
  // Underprice ONE outcome; nudge the other two up so the 3-way stays coherent.
  const outs = ["home", "draw", "away"];
  const target = outs[Math.floor(seedFloat(id + ":m3") * 3) % 3];
  const mag = underpriceMag(`${id}:m3`);
  const mids = {};
  for (const o of outs) mids[o] = o === target ? c[o] - mag : c[o] + mag / 2;
  const match = { home: simOB(mids.home, `${id}:m3:home`), draw: simOB(mids.draw, `${id}:m3:draw`), away: simOB(mids.away, `${id}:m3:away`) };
  const k = { match };
  if (Number.isFinite(cTot.a)) {
    // OU is consumed as YES=Over; to underprice Under, make Over pricier instead.
    const overCheap = seedFloat(id + ":ou") > 0.5;
    const om = underpriceMag(`${id}:ou`);
    const mid = clamp(overCheap ? cTot.a - om : cTot.a + om, 0.03, 0.97);
    k.ou = { yes: simOB(mid, `${id}:ou`), line: totalLine(event) };
  } else {
    k.ou = { yes: simOB(0.5, `${id}:ou`), line: totalLine(event) };
  }
  return k;
}

function simUfcK(event) {
  const away = event.away_team, home = event.home_team, id = `${away}vs${home}`;
  const cML = consensus(event, "h2h", oc => (oc.name === away ? "a" : oc.name === home ? "b" : null));
  if (!Number.isFinite(cML.a)) return null;
  const k = { ml: twoWaySim(cML, id, "ml") };
  const cTot = consensus(event, "totals", oc => (oc.name === "Over" ? "a" : oc.name === "Under" ? "b" : null));
  if (Number.isFinite(cTot.a)) k.ou = { ...twoWaySim(cTot, id, "ou"), line: totalLine(event) };
  return k;
}

// Build a normalized fixture from a real Odds event with a simulated Kalshi book.
export function buildSimFixture(sport, event, league) {
  try {
    if (sport === "mlb") { const k = simMlbK(event); return k ? buildMlbFixture(event, k) : null; }
    if (sport === "mls") { const k = simSoccerK(event); return k ? buildSoccerFixture(event, k, league) : null; }
    if (sport === "ufc") { const k = simUfcK(event); return k ? buildUfcFixture(event, k) : null; }
  } catch { return null; }
  return null;
}

// Assemble a SIM card for one competition from real Odds events.
export function buildSimCard(comp, events) {
  const fights = (events || []).map(e => buildSimFixture(comp.sport, e, comp.key)).filter(Boolean);
  return {
    sport: comp.sport, label: `${comp.key.toUpperCase()} — SIM (real odds)`,
    date: new Date().toISOString().slice(0, 10), generatedAt: new Date().toISOString(),
    source: "sim", fights,
  };
}

export const simConfig = () => ({ SIM_EDGE, SIM_WIDTH });
