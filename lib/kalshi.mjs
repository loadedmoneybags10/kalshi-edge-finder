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

// List open events (to discover which series carry sports markets).
export const listEvents = (limit = 60, base) => kalshiGet(`/events?status=open&limit=${limit}`, base);

// Markets for one series (the tradeable lines with prices).
export const getMarkets = (seriesTicker, base, limit = 40) =>
  kalshiGet(`/markets?series_ticker=${encodeURIComponent(seriesTicker)}&status=open&limit=${limit}`, base);
