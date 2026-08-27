// ============================================================================
// Normalizer — turns raw provider payloads into the exact fixture/market shape
// the edge engine already consumes (see edge/dashboard-standalone.html: MB()).
//
// A two-way MLB fixture looks like:
//   { id, sport:"mlb", league:"mlb", name, sideA, sideB, markets:[ {
//       key, label, type, line?, favSide?, a, b,
//       kalshi:{ a:{ask,bid,last,volume}, b:{...} },   // probabilities 0–1
//       books:{ pinnacle:{a,b}, draftkings:{a,b}, fanduel:{a,b} } // American odds
//   } ] }
//
// The engine's a/b convention for MLB: a = away, b = home; for totals a = Over;
// for the run line a = favorite -1.5, b = underdog +1.5.
// ============================================================================

const r4 = x => Math.round((x + Number.EPSILON) * 1e4) / 1e4;
const BOOK_IDS = { pinnacle: "pinnacle", draftkings: "draftkings", fanduel: "fanduel" };

// Kalshi gives one YES orderbook per market (prices already converted to 0–1).
// Build both engine sides: the YES side, and the derived NO side
// (NO ask = 1 − YES bid, NO bid = 1 − YES ask). `yesSide` says which of a/b YES maps to.
export function twoWayKalshi(yes, yesSide) {
  const yesBlock = { ask: r4(yes.ask), bid: r4(yes.bid), last: r4(yes.last), volume: yes.volume };
  const noBlock = { ask: r4(1 - yes.bid), bid: r4(1 - yes.ask), last: r4(1 - yes.last), volume: yes.volume };
  return yesSide === "a" ? { a: yesBlock, b: noBlock } : { a: noBlock, b: yesBlock };
}

// Build { book: {a, b} } American-odds quotes from an Odds API event for one market.
// sideOf(outcome) -> "a" | "b" | null
function booksBlock(event, marketKey, sideOf) {
  const out = {};
  for (const bm of event.bookmakers || []) {
    const id = BOOK_IDS[bm.key];
    if (!id) continue;
    const mkt = (bm.markets || []).find(m => m.key === marketKey);
    if (!mkt) continue;
    const q = {};
    for (const oc of mkt.outcomes || []) {
      const side = sideOf(oc);
      if (side) q[side] = oc.price;
    }
    if (q.a != null && q.b != null) out[id] = q;
  }
  return out;
}

// Assemble a normalized MLB fixture. `k` carries the matched Kalshi orderbooks
// (each in 0–1 probabilities) and which engine side each YES maps to:
//   k = { ml:{yes, yesSide}, ou:{yes, yesSide, line}, rl:{yes, yesSide, favSide} }
export function buildMlbFixture(event, k) {
  const away = event.away_team, home = event.home_team;
  const id = mlbId(away, home);
  const totalLine = k.ou.line;
  const favName = k.rl.favSide === "a" ? away : home;
  const dogName = k.rl.favSide === "a" ? home : away;

  return {
    id,
    sport: "mlb",
    league: "mlb",
    name: `${away} vs. ${home}`,
    slot: `${event.commence_time?.slice(0, 10) || ""} · ${home}`,
    sideA: away,
    sideB: home,
    commenceTime: event.commence_time || null,
    markets: [
      {
        key: "ml", label: "Moneyline", type: "winner", a: away, b: home,
        kalshi: twoWayKalshi(k.ml.yes, k.ml.yesSide),
        books: booksBlock(event, "h2h", oc => (oc.name === away ? "a" : oc.name === home ? "b" : null)),
      },
      {
        key: "rl", label: "Run Line ±1.5", type: "runline", favSide: k.rl.favSide,
        a: `${favName} -1.5`, b: `${dogName} +1.5`,
        kalshi: twoWayKalshi(k.rl.yes, k.rl.yesSide),
        books: booksBlock(event, "spreads", oc => (oc.point < 0 ? "a" : oc.point > 0 ? "b" : null)),
      },
      {
        key: "ou", label: `Runs O/U ${totalLine}`, type: "runs_ou", line: totalLine,
        a: `Over ${totalLine}`, b: `Under ${totalLine}`,
        kalshi: twoWayKalshi(k.ou.yes, k.ou.yesSide),
        books: booksBlock(event, "totals", oc => (oc.name === "Over" ? "a" : oc.name === "Under" ? "b" : null)),
      },
    ],
  };
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 6);
}
export const mlbId = (away, home) => `mlb:${slug(away)}-${slug(home)}`;

// Map an Odds API scores event -> the `res` object the engine settles from:
// MLB result { winner:"a"|"b", margin, totalRuns } (a=away, b=home).
export function resultFromScore(ev) {
  const s = Object.fromEntries((ev.scores || []).map(x => [x.name, +x.score]));
  const as = s[ev.away_team], hs = s[ev.home_team];
  if (as == null || hs == null || Number.isNaN(as) || Number.isNaN(hs)) return null;
  return { winner: as > hs ? "a" : "b", margin: Math.abs(as - hs), totalRuns: as + hs };
}

// A Kalshi outcome's YES orderbook (already 0–1) as an engine side block.
const blk = yes => ({ ask: r4(yes.ask), bid: r4(yes.bid), last: r4(yes.last), volume: yes.volume });

// ============================ SOCCER (three-way) ============================
// Match result (1X2, de-vigged across home/draw/away) + goals O/U + BTTS.
export const soccerId = (league, home, away) => `${league}:${slug(home)}-${slug(away)}`;

function booksMatch3(event, home, away) {
  const out = {};
  for (const bm of event.bookmakers || []) {
    const id = BOOK_IDS[bm.key]; if (!id) continue;
    const mkt = (bm.markets || []).find(m => m.key === "h2h"); if (!mkt) continue;
    const q = {};
    for (const oc of mkt.outcomes || []) {
      if (oc.name === home) q.home = oc.price;
      else if (oc.name === away) q.away = oc.price;
      else if (/draw/i.test(oc.name)) q.draw = oc.price;
    }
    if (q.home != null && q.draw != null && q.away != null) out[id] = q;
  }
  return out;
}
// k = { match:{home,draw,away} (each a YES orderbook), ou:{yes,line}, btts:{yes} }
export function buildSoccerFixture(event, k, league = "mls") {
  const home = event.home_team, away = event.away_team, goalsLine = k.ou.line;
  return {
    id: soccerId(league, home, away), sport: "mls", league,
    name: `${home} vs. ${away}`, slot: `${event.commence_time?.slice(0, 10) || ""} · ${home}`,
    sideA: home, sideB: away, commenceTime: event.commence_time || null,
    markets: [
      { key: "match", label: "Match Result (1X2)", type: "match3",
        sides: [{ key: "home", name: home }, { key: "draw", name: "Draw" }, { key: "away", name: away }],
        kalshi: { home: blk(k.match.home), draw: blk(k.match.draw), away: blk(k.match.away) },
        books: booksMatch3(event, home, away) },
      { key: "ou", label: `Goals O/U ${goalsLine}`, type: "goals_ou", line: goalsLine,
        a: `Over ${goalsLine}`, b: `Under ${goalsLine}`,
        kalshi: twoWayKalshi(k.ou.yes, "a"),
        books: booksBlock(event, "totals", oc => (oc.name === "Over" ? "a" : oc.name === "Under" ? "b" : null)) },
      { key: "btts", label: "Both Teams to Score", type: "btts", a: "BTTS: Yes", b: "BTTS: No",
        kalshi: twoWayKalshi(k.btts.yes, "a"),
        books: booksBlock(event, "btts", oc => (/yes/i.test(oc.name) ? "a" : /no/i.test(oc.name) ? "b" : null)) },
    ],
  };
}
export function soccerResultFromScore(ev) {
  const s = Object.fromEntries((ev.scores || []).map(x => [x.name, +x.score]));
  const hs = s[ev.home_team], as = s[ev.away_team];
  if (hs == null || as == null || Number.isNaN(hs) || Number.isNaN(as)) return null;
  return { result: hs > as ? "home" : hs < as ? "away" : "draw", totalGoals: hs + as, btts: hs > 0 && as > 0 };
}

// ============================ UFC ============================
// Winner (h2h) + rounds O/U where the books offer it. Method/finish is a
// Kalshi-native market with no book consensus, so it isn't built from the feed
// (no reference odds to de-vig against); winner is the tradeable, gradeable one.
export const ufcId = (a, b) => `ufc:${slug(a)}-${slug(b)}`;
export function buildUfcFixture(event, k) {
  const a = event.away_team, b = event.home_team; // the two fighters
  const markets = [
    { key: "winner", label: "Winner", type: "winner", a, b,
      kalshi: twoWayKalshi(k.ml.yes, k.ml.yesSide),
      books: booksBlock(event, "h2h", oc => (oc.name === a ? "a" : oc.name === b ? "b" : null)) },
  ];
  if (k.ou) markets.push({ key: "ou", label: `Rounds O/U ${k.ou.line}`, type: "rounds", line: k.ou.line,
    a: `Over ${k.ou.line}`, b: `Under ${k.ou.line}`,
    kalshi: twoWayKalshi(k.ou.yes, k.ou.yesSide),
    books: booksBlock(event, "totals", oc => (oc.name === "Over" ? "a" : oc.name === "Under" ? "b" : null)) });
  return { id: ufcId(a, b), sport: "ufc", league: "ufc", name: `${a} vs. ${b}`,
    slot: `${event.commence_time?.slice(0, 10) || ""} · UFC`, sideA: a, sideB: b, rounds: k.rounds || 3,
    commenceTime: event.commence_time || null, markets };
}
export function ufcResultFromScore(ev) {
  const s = Object.fromEntries((ev.scores || []).map(x => [x.name, +x.score]));
  const a = s[ev.away_team], b = s[ev.home_team];
  const winner = a > b ? "a" : b > a ? "b" : null;
  // Scores feeds give the winner but not method/round, so only the winner market
  // auto-grades; rounds/finish need a specialized MMA result source.
  return winner ? { winner } : null;
}
