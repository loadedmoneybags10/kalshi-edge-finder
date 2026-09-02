// ============================================================================
// Provider clients — the live data feeds.
//
// MOCK mode (default) makes the whole multi-sport pipeline work with zero keys:
// realistic MLB, soccer (EPL) and UFC slates, shaped exactly like the real API
// responses so the normalizers are exercised the same way in mock and live.
//   - Reference books (Pinnacle / DraftKings / FanDuel): The Odds API
//   - Kalshi (the market we hunt edges against): Kalshi Trade API v2
//
// Real Kalshi wiring is pending series-ticker discovery (see /api/discover);
// until confirmed, live non-MLB Kalshi fetches throw a clear error and the mock
// path is what runs.
// ============================================================================

import { oddsSportFor, COMPETITIONS } from "./competitions.mjs";
import { pairSlate } from "./match.mjs";

// Feed mode:
//   mock — everything simulated (no keys needed).
//   sim  — REAL book odds + REAL scores (The Odds API) + SIMULATED Kalshi price
//          (lib/simkalshi.mjs). Paper plays on real games, graded on real results.
//   live — REAL books + REAL Kalshi (pending series-ticker discovery).
// Back-compat: USE_MOCK=0 with no FEED set means "sim".
export const FEED = (process.env.FEED || (process.env.USE_MOCK === "0" ? "sim" : "mock")).toLowerCase();
export const feedMode = () => FEED;
const MOCK = FEED === "mock";

const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const KALSHI_BASE = process.env.KALSHI_BASE || "https://api.elections.kalshi.com/trade-api/v2";

// Engine bucket (mlb | mls | ufc) for a competition key.
export const bucketOf = key => COMPETITIONS[key]?.sport || key;

// ---- The Odds API — https://the-odds-api.com/liveapi/guides/v4/ ----
export async function fetchBookOdds(compKey) {
  if (MOCK) return mockOdds(compKey);
  if (!ODDS_API_KEY) throw new Error("ODDS_API_KEY missing (set it, or USE_MOCK=1)");
  const url =
    `https://api.the-odds-api.com/v4/sports/${oddsSportFor(compKey)}/odds` +
    `?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h,totals,spreads` +
    `&oddsFormat=american&dateFormat=iso`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Odds API ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---- Kalshi Trade API v2 (public market data; unauthenticated GET) ----
export async function fetchKalshiMarkets(compKey) {
  if (MOCK) return mockKalshi(compKey);
  const series = COMPETITIONS[compKey]?.kalshiSeries;
  if (!series) throw new Error(`Kalshi series for '${compKey}' not configured yet (run /api/discover, then set kalshiSeries in competitions.mjs)`);
  const url = `${KALSHI_BASE}/markets?series_ticker=${encodeURIComponent(series)}&status=open&limit=200`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kalshi ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---- Final scores (for grading) — The Odds API scores endpoint ----
export async function fetchScores(compKey) {
  if (MOCK) return mockScores(compKey);
  if (!ODDS_API_KEY) throw new Error("ODDS_API_KEY missing (set it, or USE_MOCK=1)");
  const url = `https://api.the-odds-api.com/v4/sports/${oddsSportFor(compKey)}/scores?apiKey=${ODDS_API_KEY}&daysFrom=1&dateFormat=iso`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Odds API scores ${res.status}: ${await res.text()}`);
  return res.json();
}

// Re-export the generic matcher so the poller can pair real slates later.
export { pairSlate };

// ============================ MOCK DISPATCH ============================
function mockOdds(compKey) {
  const b = bucketOf(compKey);
  if (b === "mlb") return mockMlbOdds();
  if (b === "mls") return compKey === "epl" ? mockSoccerOdds() : []; // one league carries the mock slate
  if (b === "ufc") return mockUfcOdds();
  return [];
}
function mockKalshi(compKey) {
  const b = bucketOf(compKey);
  if (b === "mlb") return mockMlbKalshi();
  if (b === "mls") return compKey === "epl" ? mockSoccerKalshi() : { markets: [] };
  if (b === "ufc") return mockUfcKalshi();
  return { markets: [] };
}
function mockScores(compKey) {
  const b = bucketOf(compKey);
  if (b === "mlb") return mockMlbScores();
  if (b === "mls") return compKey === "epl" ? mockSoccerScores() : [];
  if (b === "ufc") return mockUfcScores();
  return [];
}

// ============================ MLB MOCK ============================
function mockMlbOdds() {
  const book = (key, h2h, totalPoint, totals, spreadPoint, spreads) => ({
    key,
    markets: [
      { key: "h2h", outcomes: h2h },
      { key: "totals", outcomes: [{ name: "Over", price: totals[0], point: totalPoint }, { name: "Under", price: totals[1], point: totalPoint }] },
      { key: "spreads", outcomes: [{ name: spreads.favName, price: spreads.fav, point: -spreadPoint }, { name: spreads.dogName, price: spreads.dog, point: spreadPoint }] },
    ],
  });
  return [
    {
      id: "evt_lad_atl", commence_time: "2026-08-26T23:15:00Z", home_team: "Atlanta Braves", away_team: "Los Angeles Dodgers",
      bookmakers: [
        book("pinnacle", [{ name: "Los Angeles Dodgers", price: -155 }, { name: "Atlanta Braves", price: 132 }], 8.5, [-105, -115], 1.5, { favName: "Los Angeles Dodgers", fav: 130, dogName: "Atlanta Braves", dog: -155 }),
        book("draftkings", [{ name: "Los Angeles Dodgers", price: -152 }, { name: "Atlanta Braves", price: 128 }], 8.5, [-108, -112], 1.5, { favName: "Los Angeles Dodgers", fav: 128, dogName: "Atlanta Braves", dog: -152 }),
        book("fanduel", [{ name: "Los Angeles Dodgers", price: -158 }, { name: "Atlanta Braves", price: 134 }], 8.5, [-110, -108], 1.5, { favName: "Los Angeles Dodgers", fav: 132, dogName: "Atlanta Braves", dog: -158 }),
      ],
    },
    {
      id: "evt_phi_sea", commence_time: "2026-08-27T02:10:00Z", home_team: "Seattle Mariners", away_team: "Philadelphia Phillies",
      bookmakers: [
        book("pinnacle", [{ name: "Philadelphia Phillies", price: 108 }, { name: "Seattle Mariners", price: -128 }], 7.5, [120, -145], 1.5, { favName: "Seattle Mariners", fav: 130, dogName: "Philadelphia Phillies", dog: -155 }),
        book("draftkings", [{ name: "Philadelphia Phillies", price: 105 }, { name: "Seattle Mariners", price: -125 }], 7.5, [118, -142], 1.5, { favName: "Seattle Mariners", fav: 128, dogName: "Philadelphia Phillies", dog: -152 }),
        book("fanduel", [{ name: "Philadelphia Phillies", price: 110 }, { name: "Seattle Mariners", price: -130 }], 7.5, [122, -148], 1.5, { favName: "Seattle Mariners", fav: 132, dogName: "Philadelphia Phillies", dog: -158 }),
      ],
    },
    {
      id: "evt_nyy_hou", commence_time: "2026-08-27T00:05:00Z", home_team: "Houston Astros", away_team: "New York Yankees",
      bookmakers: [
        book("pinnacle", [{ name: "New York Yankees", price: -118 }, { name: "Houston Astros", price: 100 }], 8.5, [-110, -110], 1.5, { favName: "New York Yankees", fav: 145, dogName: "Houston Astros", dog: -170 }),
        book("draftkings", [{ name: "New York Yankees", price: -120 }, { name: "Houston Astros", price: 102 }], 8.5, [-112, -108], 1.5, { favName: "New York Yankees", fav: 148, dogName: "Houston Astros", dog: -172 }),
        book("fanduel", [{ name: "New York Yankees", price: -116 }, { name: "Houston Astros", price: 98 }], 8.5, [-108, -112], 1.5, { favName: "New York Yankees", fav: 142, dogName: "Houston Astros", dog: -168 }),
      ],
    },
  ];
}
function mockMlbKalshi() {
  const m = (ticker, yes_bid, yes_ask, last, volume) => ({ ticker, yes_bid, yes_ask, last_price: last, volume });
  return {
    markets: [
      // Dodgers @ Braves — Kalshi badly underprices the road favorite (a real edge that clears the gate).
      m("MLB-26AUG-LADATL-ML-LAD", 45, 47, 46, 18000),
      m("MLB-26AUG-LADATL-OU85-OVER", 50, 53, 52, 9000),
      m("MLB-26AUG-LADATL-RL-LAD", 40, 43, 42, 3000),
      // Phillies @ Mariners — thin/fair (mostly NO_TRADE examples).
      m("MLB-26AUG-PHISEA-ML-PHI", 46, 49, 48, 9000),
      m("MLB-26AUG-PHISEA-OU75-UNDER", 49, 52, 51, 9000),
      m("MLB-26AUG-PHISEA-RL-SEA", 40, 43, 42, 3000),
      // Yankees @ Astros — Kalshi underprices the Yankees (a second edge).
      m("MLB-26AUG-NYYHOU-ML-NYY", 45, 47, 46, 14000),
      m("MLB-26AUG-NYYHOU-OU85-UNDER", 50, 53, 52, 8000),
      m("MLB-26AUG-NYYHOU-RL-NYY", 41, 44, 43, 3500),
    ],
  };
}
function mockMlbScores() {
  const g = (id, away, home, as, hs) => ({ id, completed: true, home_team: home, away_team: away, scores: [{ name: away, score: String(as) }, { name: home, score: String(hs) }] });
  return [
    g("evt_lad_atl", "Los Angeles Dodgers", "Atlanta Braves", 6, 3),    // Dodgers win
    g("evt_phi_sea", "Philadelphia Phillies", "Seattle Mariners", 2, 4), // Mariners win, Under
    g("evt_nyy_hou", "New York Yankees", "Houston Astros", 5, 2),        // Yankees win
  ];
}

// ============================ SOCCER (EPL) MOCK ============================
function mockSoccerOdds() {
  const book = (key, h2h, totalPoint, totals) => ({
    key,
    markets: [
      { key: "h2h", outcomes: h2h },
      { key: "totals", outcomes: [{ name: "Over", price: totals[0], point: totalPoint }, { name: "Under", price: totals[1], point: totalPoint }] },
    ],
  });
  const three = (home, hp, dp, away, ap) => [{ name: home, price: hp }, { name: "Draw", price: dp }, { name: away, price: ap }];
  return [
    {
      id: "evt_ars_che", commence_time: "2026-08-29T16:30:00Z", home_team: "Arsenal", away_team: "Chelsea",
      bookmakers: [
        book("pinnacle", three("Arsenal", -140, 260, "Chelsea", 380), 2.5, [-120, 100]),
        book("draftkings", three("Arsenal", -138, 255, "Chelsea", 375), 2.5, [-122, 102]),
        book("fanduel", three("Arsenal", -142, 265, "Chelsea", 385), 2.5, [-118, 98]),
      ],
    },
    {
      id: "evt_liv_mci", commence_time: "2026-08-29T19:00:00Z", home_team: "Liverpool", away_team: "Manchester City",
      bookmakers: [
        book("pinnacle", three("Liverpool", 145, 250, "Manchester City", 175), 3.5, [-135, 112]),
        book("draftkings", three("Liverpool", 148, 245, "Manchester City", 172), 3.5, [-138, 115]),
        book("fanduel", three("Liverpool", 142, 255, "Manchester City", 178), 3.5, [-132, 110]),
      ],
    },
  ];
}
function mockSoccerKalshi() {
  const m = (ticker, yes_bid, yes_ask, last, volume) => ({ ticker, yes_bid, yes_ask, last_price: last, volume });
  return {
    markets: [
      // Arsenal v Chelsea — Kalshi underprices Arsenal (home) → an edge.
      m("EPL-26AUG29-ARSCHE-1X2-HOME", 43, 45, 44, 12000),
      m("EPL-26AUG29-ARSCHE-1X2-DRAW", 24, 27, 26, 6000),
      m("EPL-26AUG29-ARSCHE-1X2-AWAY", 18, 21, 20, 6000),
      m("EPL-26AUG29-ARSCHE-OU25-OVER", 52, 55, 54, 7000),
      m("EPL-26AUG29-ARSCHE-BTTS-YES", 50, 53, 52, 4000),
      // Liverpool v Man City — roughly fair (NO_TRADE examples).
      m("EPL-26AUG29-LIVMCI-1X2-HOME", 38, 41, 40, 9000),
      m("EPL-26AUG29-LIVMCI-1X2-DRAW", 25, 28, 27, 5000),
      m("EPL-26AUG29-LIVMCI-1X2-AWAY", 33, 36, 35, 9000),
      m("EPL-26AUG29-LIVMCI-OU35-OVER", 49, 52, 51, 6000),
      m("EPL-26AUG29-LIVMCI-BTTS-YES", 58, 61, 60, 4000),
    ],
  };
}
function mockSoccerScores() {
  const g = (id, home, away, hs, as) => ({ id, completed: true, home_team: home, away_team: away, scores: [{ name: home, score: String(hs) }, { name: away, score: String(as) }] });
  return [
    g("evt_ars_che", "Arsenal", "Chelsea", 2, 1),        // Arsenal win, 3 goals (Over 2.5), BTTS yes
    g("evt_liv_mci", "Liverpool", "Manchester City", 1, 1), // Draw, 2 goals
  ];
}

// ============================ UFC MOCK ============================
function mockUfcOdds() {
  const book = (key, h2h, rndPoint, rnds) => ({
    key,
    markets: [
      { key: "h2h", outcomes: h2h },
      { key: "totals", outcomes: [{ name: "Over", price: rnds[0], point: rndPoint }, { name: "Under", price: rnds[1], point: rndPoint }] },
    ],
  });
  return [
    {
      id: "evt_ufc_a", commence_time: "2026-08-29T22:00:00Z", home_team: "Song Yadong", away_team: "Umar Nurmagomedov",
      bookmakers: [
        book("pinnacle", [{ name: "Umar Nurmagomedov", price: -180 }, { name: "Song Yadong", price: 155 }], 2.5, [-150, 120]),
        book("draftkings", [{ name: "Umar Nurmagomedov", price: -175 }, { name: "Song Yadong", price: 150 }], 2.5, [-148, 118]),
        book("fanduel", [{ name: "Umar Nurmagomedov", price: -185 }, { name: "Song Yadong", price: 158 }], 2.5, [-152, 122]),
      ],
    },
    {
      id: "evt_ufc_b", commence_time: "2026-08-29T21:30:00Z", home_team: "Kai Asakura", away_team: "Aoriqileng",
      bookmakers: [
        book("pinnacle", [{ name: "Aoriqileng", price: 110 }, { name: "Kai Asakura", price: -130 }], 1.5, [-140, 115]),
        book("draftkings", [{ name: "Aoriqileng", price: 108 }, { name: "Kai Asakura", price: -128 }], 1.5, [-138, 112]),
        book("fanduel", [{ name: "Aoriqileng", price: 112 }, { name: "Kai Asakura", price: -132 }], 1.5, [-142, 118]),
      ],
    },
  ];
}
function mockUfcKalshi() {
  const m = (ticker, yes_bid, yes_ask, last, volume) => ({ ticker, yes_bid, yes_ask, last_price: last, volume });
  return {
    markets: [
      // Umar underpriced by Kalshi → an edge on the favorite.
      m("UFC-26AUG29-UMARSONG-ML-UMAR", 49, 51, 50, 11000),
      m("UFC-26AUG29-UMARSONG-OU25-UNDER", 50, 53, 52, 4000),
      // Asakura v Aoriqileng — roughly fair.
      m("UFC-26AUG29-ASAAORI-ML-ASA", 52, 55, 54, 7000),
      m("UFC-26AUG29-ASAAORI-OU15-OVER", 48, 51, 50, 3000),
    ],
  };
}
function mockUfcScores() {
  const g = (id, away, home, aw) => ({ id, completed: true, home_team: home, away_team: away, scores: [{ name: away, score: String(aw ? 1 : 0) }, { name: home, score: String(aw ? 0 : 1) }] });
  return [
    g("evt_ufc_a", "Umar Nurmagomedov", "Song Yadong", true),  // Umar (away) wins
    g("evt_ufc_b", "Aoriqileng", "Kai Asakura", false),        // Asakura (home) wins
  ];
}
