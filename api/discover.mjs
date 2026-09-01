// ============================================================================
// /api/discover — one-time reconnaissance for wiring the real feeds.
//
// I can't reach Kalshi/The Odds API from the dev sandbox, so this endpoint (run
// on Vercel, where they ARE reachable) dumps the REAL shapes of both feeds. Paste
// its JSON back and I build the matcher against reality instead of guessing.
//
// It always hits the REAL feeds (independent of USE_MOCK). The Odds call uses
// regions=us only, so it costs just a few credits.
//
//   Find sports series:   /api/discover?sport=mlb
//   Inspect one series:   /api/discover?sport=mlb&series=KXMLBGAME
//   Try another host:     /api/discover?sport=mlb&base=https://api.kalshi.com/trade-api/v2
//   Search event titles:  /api/discover?q=Yankees
// ============================================================================

import { oddsSportFor } from "../lib/competitions.mjs";
import { listEvents, getMarkets, kalshiGet, KALSHI_BASE } from "../lib/kalshi.mjs";

export default async function handler(req, res) {
  const q = req.query || {};
  const sport = (q.sport || "mlb").toLowerCase();
  const base = q.base || KALSHI_BASE;
  const out = { sport, kalshiBase: base, note: "Discovery probe of the REAL feeds — paste this whole JSON back." };

  // ---- The Odds API (books) — real, regions=us only ----
  try {
    const key = process.env.ODDS_API_KEY;
    if (!key) throw new Error("ODDS_API_KEY not set");
    const url = `https://api.the-odds-api.com/v4/sports/${oddsSportFor(sport)}/odds` +
      `?apiKey=${key}&regions=us&markets=h2h,totals,spreads&oddsFormat=american&dateFormat=iso`;
    const r = await fetch(url);
    const remaining = r.headers.get("x-requests-remaining");
    const ev = r.ok ? await r.json() : [];
    out.oddsApi = {
      status: r.status, creditsRemaining: remaining, games: Array.isArray(ev) ? ev.length : 0,
      sample: (Array.isArray(ev) ? ev : []).slice(0, 2).map(e => ({
        home: e.home_team, away: e.away_team, commence: e.commence_time,
        books: (e.bookmakers || []).map(b => b.key).slice(0, 6),
        markets: [...new Set((e.bookmakers?.[0]?.markets || []).map(m => m.key))],
        exampleOutcomes: (e.bookmakers?.[0]?.markets?.[0]?.outcomes || []).slice(0, 4),
      })),
    };
    if (!r.ok) out.oddsApi.body = (await r.text?.()) || undefined;
  } catch (e) { out.oddsApiError = String(e?.message || e); }

  // ---- Kalshi (target market) ----
  try {
    if (q.series) {
      const m = await getMarkets(q.series, base);
      out.kalshiMarkets = {
        status: m.status, count: m.json?.markets?.length ?? null,
        sample: (m.json?.markets || []).slice(0, 10).map(x => ({
          ticker: x.ticker, title: x.title, yes_sub: x.yes_sub_title, no_sub: x.no_sub_title,
          yes_bid: x.yes_bid, yes_ask: x.yes_ask, last: x.last_price, volume: x.volume, close: x.close_time,
        })),
        raw: m.textSample,
      };
    } else if (q.q) {
      const e = await kalshiGet(`/events?status=open&limit=200`, base);
      const hits = (e.json?.events || []).filter(ev => (ev.title || "").toLowerCase().includes(String(q.q).toLowerCase()));
      out.kalshiSearch = { status: e.status, matches: hits.length,
        sample: hits.slice(0, 12).map(ev => ({ series: ev.series_ticker, event: ev.event_ticker, title: ev.title, sub: ev.sub_title })) };
    } else {
      const e = await listEvents(80, base);
      const events = e.json?.events || [];
      out.kalshiEvents = {
        status: e.status, count: events.length,
        seriesTickers: [...new Set(events.map(ev => ev.series_ticker))].sort(),
        sample: events.slice(0, 12).map(ev => ({ series: ev.series_ticker, event: ev.event_ticker, title: ev.title, sub: ev.sub_title })),
        raw: e.textSample,
      };
    }
  } catch (e) { out.kalshiError = String(e?.message || e); }

  res.status(200).json(out);
}
