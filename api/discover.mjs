// ============================================================================
// /api/discover — reconnaissance for wiring the real feeds.
//
// I can't reach Kalshi/The Odds API from the dev sandbox, so this endpoint (run
// on Vercel, where they ARE reachable) dumps the REAL shapes of both feeds. Paste
// its JSON back and I build the matcher against reality instead of guessing.
//
// KALSHI (free): walks the full events feed (paginated) to find which series
// actually carry sports game markets, and probes a candidate list of sports
// tickers directly. This is the part we're still discovering, so it's the
// default focus.
//
// THE ODDS API (paid, ~1 credit/call at h2h only): confirmed working, so it's
// OFF by default now to conserve credits. Add &odds=1 to include a fresh sample.
//
//   Find sports series:    /api/discover
//   Inspect one series:    /api/discover?series=KXMLBGAME
//   Search event titles:   /api/discover?q=Yankees
//   Include an odds sample: /api/discover?odds=1&sport=mlb
//   Try another host:      /api/discover?base=https://api.kalshi.com/trade-api/v2
// ============================================================================

import { oddsSportFor } from "../lib/competitions.mjs";
import {
  listAllEvents, getMarkets, getSeriesEvents, KALSHI_BASE,
} from "../lib/kalshi.mjs";

// Candidate sports series tickers to probe directly (best guesses — the probe
// reports which actually exist so we stop guessing).
const CANDIDATE_SERIES = [
  "KXMLBGAME", "KXMLB", "KXMLBSERIES",
  "KXNFLGAME", "KXNFL", "KXNBAGAME", "KXNBA", "KXNHLGAME", "KXNHL",
  "KXWNBAGAME", "KXWNBA", "KXCFBGAME", "KXCFB", "KXCBBGAME",
  "KXUFCFIGHT", "KXUFC", "KXBOXING",
  "KXEPLGAME", "KXEPL", "KXMLSGAME", "KXMLS",
  "KXLALIGA", "KXSERIEA", "KXBUNDESLIGA", "KXUCL", "KXUEL",
  "KXTENNIS", "KXATP", "KXWTA",
];

// Heuristic: does a title/subtitle look like a single sporting event?
const SPORTS_RE = /\b(beat|defeat|vs\.?|win against|game|match|fight|bout|series|moneyline|cover the spread|first pitch|kickoff|tip-?off)\b/i;
const looksSporty = (ev) => {
  const st = `${ev.series_ticker || ""}`.toUpperCase();
  if (/MLB|NFL|NBA|NHL|WNBA|UFC|EPL|MLS|LALIGA|SERIEA|BUNDES|UCL|UEL|CFB|CBB|SOCCER|TENNIS|ATP|WTA|BOXING/.test(st)) return true;
  return SPORTS_RE.test(`${ev.title || ""} ${ev.sub_title || ""}`);
};

const trimMarket = (x) => ({
  ticker: x.ticker, title: x.title, yes_sub: x.yes_sub_title, no_sub: x.no_sub_title,
  yes_bid: x.yes_bid, yes_ask: x.yes_ask, no_bid: x.no_bid, no_ask: x.no_ask,
  last: x.last_price, volume: x.volume, open: x.open_time, close: x.close_time, status: x.status,
});

export default async function handler(req, res) {
  const q = req.query || {};
  const base = q.base || KALSHI_BASE;
  const out = {
    ranAt: new Date().toISOString(),
    kalshiBase: base,
    note: "Discovery probe of the REAL feeds — paste this whole JSON back.",
  };

  // ---- The Odds API (books) — OFF unless ?odds=1 (saves credits) ----
  if (q.odds === "1" || q.odds === "true") {
    try {
      const key = process.env.ODDS_API_KEY;
      if (!key) throw new Error("ODDS_API_KEY not set");
      const sport = (q.sport || "mlb").toLowerCase();
      const url = `https://api.the-odds-api.com/v4/sports/${oddsSportFor(sport)}/odds` +
        `?apiKey=${key}&regions=us&markets=h2h&oddsFormat=american&dateFormat=iso`;
      const r = await fetch(url);
      const ev = r.ok ? await r.json() : [];
      out.oddsApi = {
        sport, status: r.status, creditsRemaining: r.headers.get("x-requests-remaining"),
        games: Array.isArray(ev) ? ev.length : 0,
        sample: (Array.isArray(ev) ? ev : []).slice(0, 2).map(e => ({
          home: e.home_team, away: e.away_team, commence: e.commence_time,
          books: (e.bookmakers || []).map(b => b.key).slice(0, 6),
          exampleOutcomes: (e.bookmakers?.[0]?.markets?.[0]?.outcomes || []).slice(0, 4),
        })),
      };
    } catch (e) { out.oddsApiError = String(e?.message || e); }
  } else {
    out.oddsApi = "skipped (confirmed working — add &odds=1 to sample)";
  }

  // ---- Kalshi — the part we're still discovering ----
  try {
    // Mode A: inspect one series' markets directly.
    if (q.series) {
      const m = await getMarkets(q.series, base, { status: "" });
      const ev = await getSeriesEvents(q.series, base);
      out.kalshiSeries = {
        series: q.series,
        markets: {
          status: m.status, count: m.json?.markets?.length ?? null,
          sample: (m.json?.markets || []).slice(0, 12).map(trimMarket),
          raw: m.textSample,
        },
        events: {
          status: ev.status, count: ev.json?.events?.length ?? null,
          sample: (ev.json?.events || []).slice(0, 6).map(e => ({
            event: e.event_ticker, title: e.title, sub: e.sub_title,
            nestedMarkets: (e.markets || []).slice(0, 4).map(trimMarket),
          })),
        },
      };
      return res.status(200).json(out);
    }

    // Walk the whole open-events feed once; reuse for search + discovery.
    const all = await listAllEvents(base, { maxPages: 8, pageSize: 200 });
    const events = all.events;

    // Mode B: search titles across the FULL set.
    if (q.q) {
      const needle = String(q.q).toLowerCase();
      const hits = events.filter(ev =>
        `${ev.title || ""} ${ev.sub_title || ""} ${ev.series_ticker || ""}`.toLowerCase().includes(needle));
      out.kalshiSearch = {
        scanned: events.length, pages: all.pages, matches: hits.length,
        sample: hits.slice(0, 20).map(ev => ({
          series: ev.series_ticker, event: ev.event_ticker, title: ev.title, sub: ev.sub_title,
        })),
      };
      return res.status(200).json(out);
    }

    // Mode C (default): full inventory + sports hunt.
    const bySeries = new Map();
    for (const ev of events) {
      const s = ev.series_ticker || "(none)";
      if (!bySeries.has(s)) bySeries.set(s, { count: 0, sampleTitle: ev.title });
      bySeries.get(s).count++;
    }
    const seriesInventory = [...bySeries.entries()]
      .map(([series, v]) => ({ series, events: v.count, sampleTitle: v.sampleTitle }))
      .sort((a, b) => a.series.localeCompare(b.series));

    const sportyEvents = events.filter(looksSporty).slice(0, 25).map(ev => ({
      series: ev.series_ticker, event: ev.event_ticker, title: ev.title, sub: ev.sub_title,
    }));

    // Probe candidate sports tickers directly (some game markets never appear in
    // the generic open-events feed until close to game time).
    const probes = await Promise.all(CANDIDATE_SERIES.map(async (s) => {
      const m = await getMarkets(s, base, { limit: 5, status: "" });
      return {
        series: s, status: m.status, markets: m.json?.markets?.length ?? 0,
        firstTicker: m.json?.markets?.[0]?.ticker, firstTitle: m.json?.markets?.[0]?.title,
      };
    }));

    out.kalshi = {
      scannedEvents: events.length, pages: all.pages,
      totalSeries: seriesInventory.length,
      seriesInventory,
      sportsLikeEvents: sportyEvents,
      candidateSeriesHits: probes.filter(p => p.markets > 0),
      candidateSeriesTried: probes.map(p => `${p.series}:${p.status}/${p.markets}`),
    };
  } catch (e) { out.kalshiError = String(e?.message || e); }

  res.status(200).json(out);
}
