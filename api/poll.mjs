// ============================================================================
// /api/poll — Phase 1 ingestion endpoint.
//
// Fetches reference-book odds (The Odds API) + Kalshi market prices, matches
// them up, and returns a normalized card in the exact shape the edge engine
// consumes. Runs in MOCK mode with no keys (USE_MOCK defaults on).
//
//   Local:   node api/poll.mjs --sport=mlb
//   HTTP:    GET /api/poll?sport=mlb        (on Vercel)
//
// Phase 2 will persist the placed paper bets; Phase 3's cron will call this on
// a schedule. For now it proves the feed end-to-end.
// ============================================================================

import { fetchBookOdds, fetchKalshiMarkets } from "../lib/providers.mjs";
import { buildMlbFixture } from "../lib/normalize.mjs";

// Minimal team abbreviation map for pairing Kalshi tickers with book events.
// (Real deploy: derive from Kalshi's series/event metadata rather than a static map.)
const ABBR = {
  "Los Angeles Dodgers": "LAD", "Atlanta Braves": "ATL",
  "Philadelphia Phillies": "PHI", "Seattle Mariners": "SEA",
};
const codeFor = e => (ABBR[e.away_team] || "") + (ABBR[e.home_team] || "");

// Parse a mock Kalshi ticker: MLB-26AUG-<CODE>-<TYPE...>-<SIDE>
function parseTicker(t) {
  const p = t.split("-");
  const gameCode = p[2], typeRaw = p[3], sideTok = p[4];
  if (typeRaw.startsWith("OU")) return { gameCode, type: "ou", line: +typeRaw.slice(2) / 10, sideTok };
  if (typeRaw.startsWith("RL")) return { gameCode, type: "rl", sideTok };
  return { gameCode, type: "ml", sideTok };
}
const cents = m => ({ ask: m.yes_ask / 100, bid: m.yes_bid / 100, last: m.last_price / 100, volume: m.volume });

export async function pollMlb() {
  const [events, kalshi] = await Promise.all([
    fetchBookOdds("mlb"),
    fetchKalshiMarkets("KXMLBGAME"),
  ]);
  const byCode = new Map(events.map(e => [codeFor(e), e]));

  // Group matched Kalshi markets per game.
  const grouped = new Map(); // code -> { ml, ou, rl }
  for (const mk of kalshi.markets || []) {
    const pk = parseTicker(mk.ticker);
    const e = byCode.get(pk.gameCode);
    if (!e) continue;
    const g = grouped.get(pk.gameCode) || {};
    const yes = cents(mk);
    if (pk.type === "ml") {
      const yesTeam = expand(pk.sideTok);
      g.ml = { yes, yesSide: yesTeam === e.away_team ? "a" : "b" };
    } else if (pk.type === "ou") {
      g.ou = { yes, line: pk.line, yesSide: pk.sideTok === "OVER" ? "a" : "b" };
    } else if (pk.type === "rl") {
      const favTeam = expand(pk.sideTok);
      g.rl = { yes, yesSide: "a", favSide: favTeam === e.away_team ? "a" : "b" };
    }
    grouped.set(pk.gameCode, g);
  }

  const fights = [];
  for (const [code, k] of grouped) {
    if (!k.ml || !k.ou || !k.rl) continue; // need all three markets to normalize
    fights.push(buildMlbFixture(byCode.get(code), k));
  }
  return {
    sport: "mlb",
    label: "MLB — live poll",
    date: new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    source: process.env.USE_MOCK !== "0" ? "mock" : "live",
    fights,
  };
}
const expand = tok => Object.keys(ABBR).find(name => ABBR[name] === tok) || tok;

// ---- Vercel serverless handler ----
export default async function handler(req, res) {
  try {
    const sport = (req.query?.sport || "mlb").toLowerCase();
    if (sport !== "mlb") {
      res.status(400).json({ error: `sport '${sport}' not wired yet (mlb only in Phase 1)` });
      return;
    }
    const card = await pollMlb();
    res.status(200).json(card);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
}

// ---- Local CLI: `node api/poll.mjs --sport=mlb` ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const card = await pollMlb();
  console.log(`\n${card.label}  (source: ${card.source})  ${card.date}`);
  for (const f of card.fights) {
    console.log(`\n  ${f.name}  [${f.slot}]`);
    for (const m of f.markets) {
      const ka = m.kalshi.a.ask, kb = m.kalshi.b.ask;
      const cons = consensusFair(m); // illustrative de-vig, not the full engine
      const flag = cons && cons.a - ka >= 0.02 ? "  <-- Kalshi cheap on A" :
                   cons && cons.b - kb >= 0.02 ? "  <-- Kalshi cheap on B" : "";
      console.log(
        `    ${m.label.padEnd(16)} Kalshi a/b ${(ka * 100).toFixed(0)}¢/${(kb * 100).toFixed(0)}¢` +
        (cons ? `  fair ${(cons.a * 100).toFixed(0)}%/${(cons.b * 100).toFixed(0)}%` : "") + flag
      );
    }
  }
  console.log(`\n  ${card.fights.length} game(s) normalized. This card is the exact input the edge engine scores.\n`);
}

// Illustrative two-way de-vig of the book consensus (sanity readout only; the
// authoritative sharpness-weighted version lives in the dashboard engine).
function consensusFair(m) {
  const toImp = a => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
  const books = Object.values(m.books);
  if (!books.length) return null;
  const avg = side => books.reduce((s, b) => s + toImp(b[side]), 0) / books.length;
  let a = avg("a"), b = avg("b"), sum = a + b;
  return sum > 0 ? { a: a / sum, b: b / sum } : null;
}
