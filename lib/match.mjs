// ============================================================================
// match.mjs — pair an Odds API game to Kalshi markets by TEAM NAME + DATE,
// independent of Kalshi's ticker scheme.
//
// Why token/date matching (not ticker parsing): Kalshi's sports ticker formats
// vary by series and have changed before, but the human-readable team names in
// `title` / `yes_sub_title` are stable, and the game date is a strong
// disambiguator. Matching on those is robust and — crucially — only ever pairs
// games that ACTUALLY EXIST in the live Kalshi feed, which is the whole point of
// the "tighten up on the matches" discipline.
//
// Pure + tested. Thresholds are conservative: when in doubt, return no match
// (a missed pairing is a skipped bet; a false pairing is a wrong bet).
// ============================================================================

// Tokens we ignore when comparing team names (cities/qualifiers add noise).
const STOP = new Set([
  "fc", "sc", "afc", "cf", "club", "the", "of", "city", "town", "united", "utd",
  "real", "atletico", "athletic", "deportivo", "sporting", "ac", "as", "us",
]);

// Normalize a name to a set of significant lowercase tokens.
export function tokens(name) {
  return new Set(
    String(name || "")
      .toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "") // strip accents
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter(t => t.length > 1 && !STOP.has(t)),
  );
}

// Overlap of significant tokens between two names (0+). We also count a match
// when one name's token set is a subset of the other (handles "Dodgers" ⊂
// "Los Angeles Dodgers").
export function overlap(a, b) {
  const A = a instanceof Set ? a : tokens(a);
  const B = b instanceof Set ? b : tokens(b);
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n;
}

// Score how well `text` names `team` (0+). Used to decide which side a Kalshi
// market's YES represents.
export const nameScore = (team, text) => overlap(tokens(team), tokens(text));

// All the human-readable text a Kalshi market/event carries about its teams.
export function kalshiText(m) {
  return [m.title, m.yes_sub_title, m.no_sub_title, m.subtitle, m.sub_title, m.event_ticker]
    .filter(Boolean).join(" · ");
}

const ms = t => (t ? new Date(t).getTime() : NaN);

// Does a Kalshi market belong to this game? Requires BOTH teams to be
// recognizable in the market/event text (so we never pair a lookalike), and,
// when both carry timestamps, the Kalshi close within `dateWindowMs` of kickoff.
export function marketMatchesGame(game, market, { dateWindowMs = 36 * 3600 * 1000 } = {}) {
  const text = kalshiText(market);
  const home = nameScore(game.home_team, text);
  const away = nameScore(game.away_team, text);
  if (home < 1 || away < 1) return false; // both teams must appear
  const gt = ms(game.commence_time), kt = ms(market.close_time);
  if (Number.isFinite(gt) && Number.isFinite(kt) && Math.abs(kt - gt) > dateWindowMs) return false;
  return true;
}

// Which of the game's two teams does this market's YES pay out on?
// Prefer the explicit yes_sub_title; fall back to whole-text scoring.
export function yesTeamOf(game, market) {
  const yesText = market.yes_sub_title || market.title || kalshiText(market);
  const home = nameScore(game.home_team, yesText);
  const away = nameScore(game.away_team, yesText);
  if (home === away) return null;      // ambiguous → caller skips
  return home > away ? "home" : "away";
}

// Cents (0–100 integer) → normalized orderbook block (0–1 probabilities).
export const centsBlock = m => ({
  ask: (m.yes_ask ?? m.last_price) / 100,
  bid: (m.yes_bid ?? m.yes_ask ?? m.last_price) / 100,
  last: (m.last_price ?? m.yes_ask) / 100,
  volume: +m.volume || 0,
});

// Find the moneyline/winner Kalshi market for a game and return the YES
// orderbook plus which team it maps to. Picks the highest-volume valid match.
// Returns { yes, yesTeam, market } or null.
export function matchMoneyline(game, markets, opts = {}) {
  const cands = (markets || [])
    .filter(m => marketMatchesGame(game, m, opts))
    .map(m => ({ m, yesTeam: yesTeamOf(game, m) }))
    .filter(x => x.yesTeam);
  if (!cands.length) return null;
  cands.sort((a, b) => (+b.m.volume || 0) - (+a.m.volume || 0));
  const best = cands[0];
  return { yes: centsBlock(best.m), yesTeam: best.yesTeam, market: best.m, matched: cands.length };
}

// Given the full Odds slate and the full Kalshi market list, return the subset
// of games that have a confident Kalshi moneyline pairing, with the mapping
// attached. Sport builders consume this to assemble normalized fixtures.
export function pairSlate(oddsGames, kalshiMarkets, opts = {}) {
  const pairs = [];
  for (const game of oddsGames || []) {
    const ml = matchMoneyline(game, kalshiMarkets, opts);
    if (ml) pairs.push({ game, ml });
  }
  return pairs;
}
