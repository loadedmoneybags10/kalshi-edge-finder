// Tests for lib/match.mjs — synthetic Kalshi/Odds shapes modeled on the real
// discovery output (Odds: home_team/away_team/commence_time; Kalshi markets:
// title/yes_sub_title/yes_bid/yes_ask/volume/close_time in cents).
import test from "node:test";
import assert from "node:assert/strict";
import {
  tokens, overlap, nameScore, marketMatchesGame, yesTeamOf, matchMoneyline, pairSlate,
  dollarsBlock, matchGameTwoSided,
} from "../lib/match.mjs";

// ---- current Kalshi shape (KXMLBGAME): two "<Team> wins" YES markets/game,
// prices as *_dollars STRINGS (0–1), volume as *_fp. Modeled on real output. ----
test("dollarsBlock parses *_dollars strings and *_fp volume", () => {
  const b = dollarsBlock({ yes_ask_dollars: "0.4500", yes_bid_dollars: "0.4200", last_price_dollars: "0.4500", volume_fp: "14.20" });
  assert.equal(b.ask, 0.45); assert.equal(b.bid, 0.42); assert.equal(b.last, 0.45); assert.equal(b.volume, 14.2);
});

test("matchGameTwoSided pairs the two team markets by ticker-date and reads both real prices", () => {
  // Game date lives in the ticker (26SEP15), NOT close_time (padded to Sep 19).
  const g = { away_team: "Miami Marlins", home_team: "Arizona Diamondbacks", commence_time: "2026-09-15T21:40:00Z" };
  const markets = [
    { ticker: "KXMLBGAME-26SEP152140MIAAZ-MIA", event_ticker: "KXMLBGAME-26SEP152140MIAAZ",
      title: "Miami wins", yes_sub_title: "Miami", yes_ask_dollars: "0.4500", yes_bid_dollars: "0.4200", last_price_dollars: "0.4500", volume_fp: "14.20", close_time: "2026-09-19T01:40:00Z" },
    { ticker: "KXMLBGAME-26SEP152140MIAAZ-AZ", event_ticker: "KXMLBGAME-26SEP152140MIAAZ",
      title: "Arizona wins", yes_sub_title: "Arizona", yes_ask_dollars: "0.5900", yes_bid_dollars: "0.5400", last_price_dollars: "0.5400", volume_fp: "3.00", close_time: "2026-09-19T01:40:00Z" },
    // an unrelated game that must NOT match
    { ticker: "KXMLBGAME-26SEP152138SEALAA-SEA", event_ticker: "KXMLBGAME-26SEP152138SEALAA",
      title: "Seattle wins", yes_sub_title: "Seattle", yes_ask_dollars: "0.5400", close_time: "2026-09-19T01:38:00Z" },
  ];
  const r = matchGameTwoSided(g, markets);
  assert.ok(r, "should match");
  assert.equal(r.away.ask, 0.45); // Miami (away)
  assert.equal(r.home.ask, 0.59); // Arizona (home)
  assert.equal(r.dayGap, 0);
});

test("matchGameTwoSided prefers the closest game date across a series", () => {
  const g = { away_team: "Colorado Rockies", home_team: "Detroit Tigers", commence_time: "2026-09-15T23:10:00Z" };
  const mk = (date, team, ask) => ({ ticker: `KXMLBGAME-${date}COLDET-${team}`, event_ticker: `KXMLBGAME-${date}COLDET`, yes_sub_title: team === "COL" ? "Colorado" : "Detroit", yes_ask_dollars: ask });
  const markets = [ // same matchup on three series days; Sep 15 is the right one
    mk("26SEP13", "COL", "0.40"), mk("26SEP13", "DET", "0.64"),
    mk("26SEP15", "COL", "0.44"), mk("26SEP15", "DET", "0.60"),
    mk("26SEP17", "COL", "0.42"), mk("26SEP17", "DET", "0.62"),
  ];
  const r = matchGameTwoSided(g, markets);
  assert.ok(r); assert.equal(r.away.ask, 0.44); assert.equal(r.dayGap, 0); // picked Sep 15
});

test("matchGameTwoSided returns null when a side is missing or too far in date", () => {
  const g = { away_team: "Miami Marlins", home_team: "Arizona Diamondbacks", commence_time: "2026-09-15T21:40:00Z" };
  const onlyOne = [{ ticker: "KXMLBGAME-26SEP15X-MIA", event_ticker: "E1", yes_sub_title: "Miami", yes_ask_dollars: "0.45" }];
  assert.equal(matchGameTwoSided(g, onlyOne), null);
  const wrongDate = [
    { ticker: "KXMLBGAME-26OCT01X-MIA", event_ticker: "E2", yes_sub_title: "Miami", yes_ask_dollars: "0.45" },
    { ticker: "KXMLBGAME-26OCT01X-AZ", event_ticker: "E2", yes_sub_title: "Arizona", yes_ask_dollars: "0.59" },
  ];
  assert.equal(matchGameTwoSided(g, wrongDate), null); // Oct 1 vs Sep 15 → gap ≫ 1 day
});

const game = {
  home_team: "Cincinnati Reds", away_team: "San Diego Padres",
  commence_time: "2026-09-01T22:41:00Z",
};
// A Kalshi moneyline market whose YES pays if the Padres win.
const padresMkt = {
  ticker: "KXMLBGAME-26SEP01CINSD-SD", event_ticker: "KXMLBGAME-26SEP01CINSD",
  title: "San Diego Padres at Cincinnati Reds", yes_sub_title: "San Diego Padres",
  no_sub_title: "Cincinnati Reds", yes_bid: 52, yes_ask: 55, last_price: 54,
  volume: 12000, close_time: "2026-09-01T22:41:00Z",
};

test("tokens/overlap ignore stop-words and cities", () => {
  assert.ok(!tokens("Manchester United FC").has("fc"));
  assert.equal(overlap("Padres", "San Diego Padres"), 1);
  assert.equal(nameScore("San Diego Padres", "San Diego Padres"), 3); // san, diego, padres
});

test("marketMatchesGame requires BOTH teams present", () => {
  assert.ok(marketMatchesGame(game, padresMkt));
  const lookalike = { title: "San Diego Padres at Los Angeles Dodgers", yes_sub_title: "San Diego Padres", close_time: game.commence_time };
  assert.ok(!marketMatchesGame(game, lookalike), "wrong opponent → no match");
});

test("marketMatchesGame enforces the date window", () => {
  const wrongDay = { ...padresMkt, close_time: "2026-09-20T22:41:00Z" };
  assert.ok(!marketMatchesGame(game, wrongDay), "close 19 days off → no match");
  const noDate = { ...padresMkt, close_time: undefined };
  assert.ok(marketMatchesGame(game, noDate), "missing timestamps → allowed on names alone");
});

test("yesTeamOf maps YES to the correct side", () => {
  assert.equal(yesTeamOf(game, padresMkt), "away"); // Padres are the away team
  const redsMkt = { ...padresMkt, yes_sub_title: "Cincinnati Reds" };
  assert.equal(yesTeamOf(game, redsMkt), "home");
});

test("matchMoneyline returns normalized YES block + side, prefers volume", () => {
  const thin = { ...padresMkt, ticker: "thin", volume: 300, yes_ask: 60, yes_bid: 57 };
  const r = matchMoneyline(game, [thin, padresMkt]);
  assert.ok(r);
  assert.equal(r.yesTeam, "away");
  assert.equal(r.yes.ask, 0.55);       // picked the higher-volume market
  assert.equal(r.yes.bid, 0.52);
  assert.equal(r.yes.volume, 12000);
  assert.equal(r.matched, 2);
});

test("matchMoneyline returns null when no market names both teams", () => {
  const other = { title: "New York Yankees at Boston Red Sox", yes_sub_title: "New York Yankees", yes_ask: 50, yes_bid: 48, volume: 9000 };
  assert.equal(matchMoneyline(game, [other]), null);
});

test("pairSlate keeps only confidently matched games", () => {
  const games = [game, { home_team: "Team A", away_team: "Team B", commence_time: game.commence_time }];
  const pairs = pairSlate(games, [padresMkt]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].game.home_team, "Cincinnati Reds");
  assert.equal(pairs[0].ml.yesTeam, "away");
});
