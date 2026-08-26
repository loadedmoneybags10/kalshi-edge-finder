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
  const id = `mlb:${slug(away)}-${slug(home)}`;
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

// NOTE — Soccer (three-way 1X2 + goals O/U + BTTS) and UFC (winner + method +
// rounds) normalizers follow the same pattern: three-way markets carry a
// `sides:[{key:"home"},{key:"draw"},{key:"away"}]` block and de-vig across all
// three. They plug in here once their Odds API markets + Kalshi tickers are mapped.
