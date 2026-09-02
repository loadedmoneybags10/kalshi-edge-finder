// Tests for lib/match.mjs — synthetic Kalshi/Odds shapes modeled on the real
// discovery output (Odds: home_team/away_team/commence_time; Kalshi markets:
// title/yes_sub_title/yes_bid/yes_ask/volume/close_time in cents).
import test from "node:test";
import assert from "node:assert/strict";
import {
  tokens, overlap, nameScore, marketMatchesGame, yesTeamOf, matchMoneyline, pairSlate,
} from "../lib/match.mjs";

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
