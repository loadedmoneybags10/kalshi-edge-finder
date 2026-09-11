// ============================================================================
// Kalshi market-data client (public GETs — no auth needed for prices).
//
// Base URL is configurable because Kalshi's host has moved before; override with
// KALSHI_BASE env or ?base= on the discovery endpoint while we confirm it.
// Prices are integer cents (0–100); callers convert to 0–1 probabilities.
// ============================================================================

export const KALSHI_BASE = process.env.KALSHI_BASE || "https://api.elections.kalshi.com/trade-api/v2";

export async function kalshiGet(path, base = KALSHI_BASE) {
  const url = base.replace(/\/$/, "") + path;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leave a text sample for debugging */ }
  return { ok: res.ok, status: res.status, json, textSample: json ? null : text.slice(0, 400), url };
}

// One page of events. status defaults to open; pass "" to include all statuses.
export const listEvents = (limit = 200, base, { cursor = "", status = "open" } = {}) =>
  kalshiGet(
    `/events?limit=${limit}` +
      (status ? `&status=${status}` : "") +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
    base,
  );

// Walk the events feed across pages, collecting every event. Bounded by
// maxPages so a serverless call can't run away (Kalshi has thousands of events).
export async function listAllEvents(base, { maxPages = 8, pageSize = 200, status = "open" } = {}) {
  const events = [];
  let cursor = "";
  let pages = 0;
  let lastStatus = 0;
  for (; pages < maxPages; pages++) {
    const r = await listEvents(pageSize, base, { cursor, status });
    lastStatus = r.status;
    if (!r.ok || !r.json) break;
    for (const e of r.json.events || []) events.push(e);
    cursor = r.json.cursor || "";
    if (!cursor) break;
  }
  return { events, pages: pages + 1, status: lastStatus };
}

// Markets for one series. Pass status="" to include markets that aren't in the
// "open" state yet (game lines often list before they start trading).
export const getMarkets = (seriesTicker, base, { limit = 100, status = "" } = {}) =>
  kalshiGet(
    `/markets?series_ticker=${encodeURIComponent(seriesTicker)}&limit=${limit}` +
      (status ? `&status=${status}` : ""),
    base,
  );

// Events for one series, optionally with their markets nested — the cleanest way
// to confirm a sports series carries per-game contracts.
export const getSeriesEvents = (seriesTicker, base, { limit = 100, nested = true } = {}) =>
  kalshiGet(
    `/events?series_ticker=${encodeURIComponent(seriesTicker)}&limit=${limit}` +
      (nested ? `&with_nested_markets=true` : ""),
    base,
  );

// One page of open markets across ALL series (for team-based matching).
export const listMarkets = (base, { cursor = "", limit = 1000, status = "open" } = {}) =>
  kalshiGet(
    `/markets?limit=${limit}` + (status ? `&status=${status}` : "") +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
    base,
  );

// Walk the whole open-markets feed. Bounded by maxPages. Returns every open
// market so the matcher can pair Odds games to Kalshi by team name.
export async function listAllMarkets(base, { maxPages = 12, pageSize = 1000, status = "open" } = {}) {
  const markets = [];
  let cursor = "", pages = 0, lastStatus = 0;
  for (; pages < maxPages; pages++) {
    const r = await listMarkets(base, { cursor, limit: pageSize, status });
    lastStatus = r.status;
    if (!r.ok || !r.json) break;
    for (const m of r.json.markets || []) markets.push(m);
    cursor = r.json.cursor || "";
    if (!cursor) break;
  }
  return { markets, pages: pages + 1, status: lastStatus };
}
