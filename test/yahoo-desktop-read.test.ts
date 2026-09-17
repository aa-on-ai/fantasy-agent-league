import test from "node:test";
import assert from "node:assert/strict";
import { readYahooDesktop, rankingsMatch } from "../src/platforms/yahoo/desktop-read.js";

const binding = { leagueId: "100", teamId: "2" };
// Sanitized from Safari's observed full-tree format; no account or player data.
const identity = (suffix = "") => `0 standard window Team | Yahoo! Sports
  4 HTML content Description: Team | Yahoo! Sports, URL: football.fantasysports.yahoo.com/f1/100/2${suffix}
    24 link My Team, Value: football.fantasysports.yahoo.com/f1/100/2\n`;
const ranks = identity("/prerank") + `  30 heading Your Rankings, Value: 3
  31 container
    32 container 1. Player One
    33 container 2. Player Two
  34 heading Exclude Ranking, Value: 3
  35 container
    36 container Player Three
  37 heading Instructions, Value: 2`;

test("extracts observed rankings and detects changed saved order and exclusions", () => {
  const read = readYahooDesktop(ranks, binding);
  assert.equal(read.kind, "rankings");
  if (read.kind !== "rankings") throw Error("expected rankings");
  assert.ok(rankingsMatch(read, { preferred: ["player one", "player two"], excluded: ["Player Three"] }));
  assert.ok(!rankingsMatch(read, { preferred: ["Player Two", "Player One"], excluded: ["Player Three"] }));
  assert.ok(!rankingsMatch(read, { preferred: read.preferred, excluded: [] }));
});
test("rejects wrong document, conflicting ownership and differential observations", () => {
  assert.throws(() => readYahooDesktop(ranks.replace("/100/2/prerank", "/100/3/prerank"), binding), /unexpected_page/);
  assert.throws(() => readYahooDesktop(ranks + "\n  50 link My Team, Value: football.fantasysports.yahoo.com/f1/100/3", binding), /wrong_team/);
  assert.throws(() => readYahooDesktop(ranks.replace("4 HTML", "+4 HTML"), binding), /full_observation_required/);
  assert.throws(() => readYahooDesktop(ranks.replace("football.fantasysports.yahoo.com/f1/100/2/prerank", "evil.example/f1/100/2/prerank"), binding), /unexpected_page/);
});
test("rejects truncated, skipped and ambiguous ranking rows", () => {
  assert.throws(() => readYahooDesktop(ranks.replace("heading Instructions", "heading Missing"), binding), /incomplete_rankings/);
  assert.throws(() => readYahooDesktop(ranks.replace("2. Player Two", "3. Player Two"), binding), /incomplete_rankings/);
  assert.throws(() => readYahooDesktop(ranks.replace("Player Three", "player one"), binding), /ambiguous_rankings/);
});
test("pre-draft and unseen season pages never become executable snapshots", () => {
  assert.deepEqual(readYahooDesktop(identity() + "  73 text Your team will include the following roster positions:", binding), { kind: "blocked", code: "pre_draft_roster" });
  assert.deepEqual(readYahooDesktop(identity(), binding), { kind: "blocked", code: "season_controls_unobserved" });
});
