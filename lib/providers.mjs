// ============================================================================
// Provider clients — the live data feeds (Phase 1).
//
// Runs in MOCK mode by default so the whole pipeline works with zero keys.
// Flip to real data by setting USE_MOCK=0 and supplying the API keys below.
//   - Reference books (Pinnacle / DraftKings / FanDuel): The Odds API
//   - Kalshi (the market we hunt edges against): Kalshi Trade API v2
//
// The mock payloads are shaped like the real API responses, so the normalizer
// in lib/normalize.mjs is exercised the same way in mock and live.
// ============================================================================

import { oddsSportFor } from "./competitions.mjs";

const USE_MOCK = process.env.USE_MOCK !== "0";

// ---- The Odds API — https://the-odds-api.com/liveapi/guides/v4/ ----
// Sport keys come from the competition registry (lib/competitions.mjs).
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";

export async function fetchBookOdds(sportKey) {
  if (USE_MOCK) return mockOddsApi(sportKey);
  if (!ODDS_API_KEY) throw new Error("ODDS_API_KEY missing (set it, or USE_MOCK=1)");
  const sport = oddsSportFor(sportKey);
  const url =
    `https://api.the-odds-api.com/v4/sports/${sport}/odds` +
    `?apiKey=${ODDS_API_KEY}&regions=us,eu&markets=h2h,totals,spreads` +
    `&oddsFormat=american&dateFormat=iso`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Odds API ${res.status}: ${await res.text()}`);
  // Array of events: [{ id, commence_time, home_team, away_team,
  //   bookmakers:[{ key, markets:[{ key, outcomes:[{ name, price, point }] }] }] }]
  return res.json();
}

// ---- Kalshi Trade API v2 — https://trading-api.readme.io/reference ----
const KALSHI_BASE = process.env.KALSHI_BASE || "https://api.elections.kalshi.com/trade-api/v2";

// Public market data (orderbook / last / volume) is an unauthenticated GET.
// Placing real orders later needs RSA-signed KALSHI-ACCESS-* headers — that is a
// Phase 3 concern; paper trading never calls it.
export async function fetchKalshiMarkets(seriesTicker) {
  if (USE_MOCK) return mockKalshi(seriesTicker);
  const url = `${KALSHI_BASE}/markets?series_ticker=${encodeURIComponent(seriesTicker)}&status=open`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kalshi ${res.status}: ${await res.text()}`);
  // { markets: [{ ticker, title, yes_bid, yes_ask, last_price, volume, ... }] }
  // Prices are integer cents (0–100); the normalizer converts to 0–1 probabilities.
  return res.json();
}

// ---- Final scores (for grading) — The Odds API scores endpoint ----
// GET /v4/sports/{sport}/scores?apiKey=&daysFrom=1  -> events with completed + scores.
export async function fetchScores(sportKey) {
  if (USE_MOCK) return mockScores(sportKey);
  if (!ODDS_API_KEY) throw new Error("ODDS_API_KEY missing (set it, or USE_MOCK=1)");
  const sport = oddsSportFor(sportKey);
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/scores?apiKey=${ODDS_API_KEY}&daysFrom=1&dateFormat=iso`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Odds API scores ${res.status}: ${await res.text()}`);
  // [{ id, completed, home_team, away_team, scores:[{name, score}] }]
  return res.json();
}

// ============================ MOCKS ============================
// Two MLB games, shaped exactly like the real API responses, so `node
// api/poll.mjs --sport=mlb` produces a normalized card with no network/keys.

function mockOddsApi(sportKey) {
  if (sportKey !== "mlb") return []; // soccer/UFC mocks are a follow-up
  const book = (key, h2h, totalPoint, totals, spreadPoint, spreads) => ({
    key,
    markets: [
      { key: "h2h", outcomes: h2h },
      { key: "totals", outcomes: [
        { name: "Over", price: totals[0], point: totalPoint },
        { name: "Under", price: totals[1], point: totalPoint } ] },
      { key: "spreads", outcomes: [
        { name: spreads.favName, price: spreads.fav, point: -spreadPoint },
        { name: spreads.dogName, price: spreads.dog, point: spreadPoint } ] },
    ],
  });
  return [
    {
      id: "evt_lad_atl",
      commence_time: "2026-08-26T23:15:00Z",
      home_team: "Atlanta Braves",
      away_team: "Los Angeles Dodgers",
      bookmakers: [
        book("pinnacle",   [{ name: "Los Angeles Dodgers", price: -155 }, { name: "Atlanta Braves", price: 132 }], 8.5, [-105, -115], 1.5, { favName:"Los Angeles Dodgers", fav:130, dogName:"Atlanta Braves", dog:-155 }),
        book("draftkings", [{ name: "Los Angeles Dodgers", price: -152 }, { name: "Atlanta Braves", price: 128 }], 8.5, [-108, -112], 1.5, { favName:"Los Angeles Dodgers", fav:128, dogName:"Atlanta Braves", dog:-152 }),
        book("fanduel",    [{ name: "Los Angeles Dodgers", price: -158 }, { name: "Atlanta Braves", price: 134 }], 8.5, [-110, -108], 1.5, { favName:"Los Angeles Dodgers", fav:132, dogName:"Atlanta Braves", dog:-158 }),
      ],
    },
    {
      id: "evt_phi_sea",
      commence_time: "2026-08-27T02:10:00Z",
      home_team: "Seattle Mariners",
      away_team: "Philadelphia Phillies",
      bookmakers: [
        book("pinnacle",   [{ name: "Philadelphia Phillies", price: 108 }, { name: "Seattle Mariners", price: -128 }], 7.5, [120, -145], 1.5, { favName:"Seattle Mariners", fav:130, dogName:"Philadelphia Phillies", dog:-155 }),
        book("draftkings", [{ name: "Philadelphia Phillies", price: 105 }, { name: "Seattle Mariners", price: -125 }], 7.5, [118, -142], 1.5, { favName:"Seattle Mariners", fav:128, dogName:"Philadelphia Phillies", dog:-152 }),
        book("fanduel",    [{ name: "Philadelphia Phillies", price: 110 }, { name: "Seattle Mariners", price: -130 }], 7.5, [122, -148], 1.5, { favName:"Seattle Mariners", fav:132, dogName:"Philadelphia Phillies", dog:-158 }),
      ],
    },
  ];
}

// Completed mock scores for the two games (shaped like the Odds API scores API).
function mockScores(sportKey) {
  if (sportKey !== "mlb") return [];
  const g = (id, away, home, as, hs) => ({ id, completed: true, home_team: home, away_team: away,
    scores: [{ name: away, score: String(as) }, { name: home, score: String(hs) }] });
  return [
    g("evt_lad_atl", "Los Angeles Dodgers", "Atlanta Braves", 6, 3),   // Dodgers win by 3, total 9
    g("evt_phi_sea", "Philadelphia Phillies", "Seattle Mariners", 2, 4), // Mariners win, total 6 (Under 7.5)
  ];
}

// Kalshi returns integer-cent yes prices per market ticker. We key mock markets
// by matchup so the poller can pair them with the Odds API events.
function mockKalshi() {
  const m = (ticker, yes_bid, yes_ask, last, volume) => ({ ticker, yes_bid, yes_ask, last_price: last, volume });
  return {
    markets: [
      // Dodgers @ Braves — Kalshi badly underprices the road favorite (Dodgers):
      // ~58% fair vs a 47¢ ask. A real edge that survives fees+slippage+uncertainty,
      // so this one CLEARS the net-EV gate and demonstrates the TRADE path.
      m("MLB-26AUG-LADATL-ML-LAD", 45, 47, 46, 18000),
      m("MLB-26AUG-LADATL-OU85-OVER", 50, 53, 52, 9000),
      m("MLB-26AUG-LADATL-RL-LAD", 40, 43, 42, 3000),
      // Phillies @ Mariners — Kalshi underprices the UNDER.
      m("MLB-26AUG-PHISEA-ML-PHI", 46, 49, 48, 9000),
      m("MLB-26AUG-PHISEA-OU75-UNDER", 49, 52, 51, 9000),
      m("MLB-26AUG-PHISEA-RL-SEA", 40, 43, 42, 3000),
    ],
  };
}
