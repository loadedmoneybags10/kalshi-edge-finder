// ============================================================================
// Competition registry + scan cadence — the operating model.
//
//   daily     — games essentially every day; the daily driver (MLB; NBA later).
//   matchday  — games cluster on match days/rounds; the poller still runs DAILY
//               as an odds-checker, but most days there are no open markets so
//               it simply finds nothing (soccer leagues + cups).
//   event     — discrete events (fight cards); scan when a card is scheduled.
//
// `sport` is the engine bucket (ufc | mls | mlb) that decides market structure
// (mls = any three-way soccer competition). `oddsSport` is the The Odds API key
// — verify against https://api.the-odds-api.com/v4/sports before going live.
// `enabled:false` keeps a competition registered but out of the scan.
// ============================================================================

// NOTE: `kalshiSeries` is the LIVE Kalshi series ticker for a competition. It is
// intentionally absent until confirmed by /api/discover (the deepened probe
// returns candidateSeriesHits + a full series inventory). Once you paste that
// back, we set kalshiSeries per competition and the live Kalshi fetch turns on;
// until then providers.fetchKalshiMarkets throws a clear "not configured" error
// for real mode, and MOCK mode drives the whole pipeline.
export const COMPETITIONS = {
  // `kalshiSeries` is the LIVE Kalshi single-game (moneyline) series ticker — each
  // game lists one "<Team> wins" YES market per side (confirmed via kalshi-explore).
  // Comps without one can't trade live (SIM still covers them).
  // ---- daily driver ----
  mlb:        { sport: "mlb", league: "mlb",        oddsSport: "baseball_mlb",              cadence: "daily",    enabled: true, kalshiSeries: "KXMLBGAME" },

  // ---- NFL (moneyline · spread · points O/U) ----
  nfl:        { sport: "nfl", league: "nfl",        oddsSport: "americanfootball_nfl",      cadence: "matchday", enabled: true, kalshiSeries: "KXNFLGAME" },

  // ---- soccer: scanned per matchday, polled daily as an odds-checker ----
  mls:        { sport: "mls", league: "mls",        oddsSport: "soccer_usa_mls",            cadence: "matchday", enabled: true }, // no Kalshi single-game series
  epl:        { sport: "mls", league: "epl",        oddsSport: "soccer_epl",                cadence: "matchday", enabled: true, kalshiSeries: "KXEPLGAME" },
  laliga:     { sport: "mls", league: "laliga",     oddsSport: "soccer_spain_la_liga",      cadence: "matchday", enabled: true, kalshiSeries: "KXLALIGAGAME" },
  seriea:     { sport: "mls", league: "seriea",     oddsSport: "soccer_italy_serie_a",      cadence: "matchday", enabled: true, kalshiSeries: "KXSERIEAGAME" },
  bundesliga: { sport: "mls", league: "bundesliga", oddsSport: "soccer_germany_bundesliga", cadence: "matchday", enabled: true, kalshiSeries: "KXBUNDESLIGAGAME" },
  eflcup:     { sport: "mls", league: "eflcup",     oddsSport: "soccer_england_efl_cup",    cadence: "matchday", enabled: true },
  // FA Cup: registered but dormant — qualifying rounds now, marquee rounds (PL
  // clubs) from January. The daily odds-checker picks it up when rounds are live.
  facup:      { sport: "mls", league: "facup",      oddsSport: "soccer_fa_cup",             cadence: "matchday", enabled: true, note: "marquee rounds Jan+" },

  // ---- UEFA club competitions (three-way soccer; same engine/logic) ----
  ucl:        { sport: "mls", league: "ucl",        oddsSport: "soccer_uefa_champs_league",             cadence: "matchday", enabled: true, kalshiSeries: "KXUCLGAME", note: "league phase from mid-Sep" },
  uel:        { sport: "mls", league: "uel",        oddsSport: "soccer_uefa_europa_league",             cadence: "matchday", enabled: true, kalshiSeries: "KXUELGAME" },
  uecl:       { sport: "mls", league: "uecl",       oddsSport: "soccer_uefa_europa_conference_league",  cadence: "matchday", enabled: true },

  // ---- events ----
  ufc:        { sport: "ufc", league: "ufc",        oddsSport: "mma_mixed_martial_arts",    cadence: "event",    enabled: true },

  // ---- added when the season starts ----
  nba:        { sport: "nba", league: "nba",        oddsSport: "basketball_nba",            cadence: "daily",    enabled: false, kalshiSeries: "KXNBAGAME" },
};

export const enabledCompetitions = () =>
  Object.entries(COMPETITIONS).filter(([, c]) => c.enabled).map(([key, c]) => ({ key, ...c }));

// The daily cron scans every enabled competition; `daily` sports expect games,
// `matchday`/`event` sports usually return an empty card (no open markets) —
// that's the odds-checker doing its job, not an error.
export const oddsSportFor = key => COMPETITIONS[key]?.oddsSport || key;
