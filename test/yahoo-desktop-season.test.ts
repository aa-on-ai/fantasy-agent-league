import test from "node:test";
import assert from "node:assert/strict";
import { readDesktopRoster, readDesktopRules, readDesktopDrops, readDesktopPool, readDesktopTransactions, readDesktopPlayerDetails } from "../src/platforms/yahoo/desktop-season.js";
import { extractPostDraft } from "../src/platforms/yahoo/post-draft.js";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const time = "2026-09-09T03:00:00Z", now = new Date(time);
const binding = { leagueId: "100", teamId: "2", teamName: "Example", maxAgeMs: 60000 };
let index = 10;
const node = (depth: number, text: string) => `${"  ".repeat(depth)}${index++} ${text}\n`;
const identity = (path = "100/2") => `0 standard window Example\n  1 HTML content Description: Example | Yahoo! Sports, URL: football.fantasysports.yahoo.com/f1/${path}\n    2 link My Team, Value: football.fantasysports.yahoo.com/f1/100/2\n    3 text Example\n`;
const obs = (capture: string) => ({ capture, capturedAt: time });
const setting = (k: string, v: string) => node(3, "row (selectable)") + node(4, "cell (selectable) " + k) + node(4, "cell (selectable) " + v);
const rules = obs(identity("100/2/settings") + node(2, "table") + setting("League ID#:", "100") + setting("Waiver Type:", "Continual rolling list") +
  setting("Waiver Time:", "2 days") + setting("Weekly Waivers", "Game Time - Tuesday") + setting("Roster Positions:", "QB, W/R/T, K, DEF, BN, IR") + setting("Lock Benched Players:", "No"));
const detail = (name: string, position: string, injury = "") => `${name}\nOpen player notes for ${name}\nbutton, Description: ${name}\nOpen player notes for ${name}\nbutton, Value: ${name}\n${injury ? injury + "\n" : ""}Player Note\nABC - ${position}\nWed 8:20 pm vs XYZ`;
const row = (assignment: string, name: string, position: string, injury = "") => node(3, "row (selectable)") +
  ["Click here to edit " + assignment + " " + name, detail(name, position, injury), "7", "–", "12.34", "50%"].map(x => node(4, "cell (selectable) " + x)).join("");
const table = (kind: string) => node(2, `table Example's ${kind} roster for week 1.\n`) + node(3, "row (selectable) Description: Projected Points, Value: Pos\nOffense\nBye\nFan Pts\nProj Pts\n% Start");
const roster = obs(identity() + node(2, "text Waiver Priority: 6th") + table("Offense") + row("QB", "Player One", "QB") +
  row("W_R_T", "Player Two", "RB", "Q") + row("BN", "Player Three", "TE") + table("Kickers") + row("K", "Player Four", "K") +
  table("Defense/Special Teams") + row("DEF", "Example Defense", "DEF") + node(2, "text All game times are shown in EDT."));

const detailBinding = { key: 'ABC:Player One', name: 'Player One', season: 2026, period: '1' };
const playerModal = () => roster.capture + node(2, 'container') + node(3, 'image Photo of Player One') +
  node(3, 'link Player One, Value: sports.yahoo.com/nfl/players/12345') +
  node(3, 'link Example, Value: football.fantasysports.yahoo.com/f1/100/2') +
  node(3, 'container Game Log') + node(4, 'heading 2026 Season Game Log, Value: 3') + node(4, 'table') +
  node(5, 'row (selectable) Week\nOpp\nStatus\nProj\nFan Pts\nYds') +
  node(5, 'row (selectable)') + ['1', '@XYZ', 'Wed 8:20 PM', '12.34', '-'].map(x => node(6, 'cell (selectable) ' + x)).join('') +
  node(5, 'row (selectable)') + ['2', 'BYE', '-', '-', '-'].map(x => node(6, 'cell (selectable) ' + x)).join('') +
  node(3, 'heading Latest News, Value: 3') + node(4, 'text Latest News') +
  node(4, 'text There are no news updates for Player One in the last 10 days.');

test('player modal binds ownership, numeric identity and forecast columns while retaining unknown news dates', () => {
  const result = readDesktopPlayerDetails(obs(playerModal()), binding, detailBinding, now);
  assert.equal(result.yahooPlayerId, '12345');
  assert.deepEqual(result.games[0], { period: '1', opponent: '@XYZ', statusText: 'Wed 8:20 PM', projectedPoints: 12.34, fantasyPoints: null });
  assert.equal(result.games[1]!.projectedPoints, null);
  assert.equal(result.news.status, 'none_in_last_10_days');
  assert.equal(result.news.publicationDatesResolved, false);
  const excerpt = playerModal().replace('text There are no news updates for Player One in the last 10 days.',
    'text Thursday 1:41 PM  |  News provider\n' + node(4, 'heading Practice update, Value: 4') + node(4, 'text Player practiced.'));
  assert.equal(readDesktopPlayerDetails(obs(excerpt), binding, detailBinding, now).news.status, 'observed_excerpt');
});
test('player modal refuses wrong selected player, missing news, stale capture and ambiguous forecast columns', () => {
  for (const capture of [
    playerModal().replace('image Photo of Player One', 'image Photo of Someone Else'),
    playerModal().replace('link Example, Value: football.fantasysports.yahoo.com/f1/100/2', 'link Example, Value: football.fantasysports.yahoo.com/f1/100/3'),
    playerModal().replace('Week\nOpp\nStatus\nProj\nFan Pts', 'Week\nOpp\nStatus\nFan Pts\nProj'),
    playerModal().replace('text There are no news updates for Player One in the last 10 days.', 'text Loading'),
    playerModal().replace('heading 2026 Season Game Log', 'heading 2025 Season Game Log'),
  ]) assert.throws(() => readDesktopPlayerDetails(obs(capture), binding, detailBinding, now));
  assert.throws(() => readDesktopPlayerDetails({ capture: playerModal(), capturedAt: '2020-01-01' }, binding, detailBinding, now), /stale/);
});

test("normalizes multiline roster, explicit projection column, rules and legal filled lineup", () => {
  const r = readDesktopRoster(roster, rules, binding, now);
  assert.equal(r.players.length, 5);
  assert.equal(r.players[1]!.injuryLabel, "Q");
  assert.equal(r.players[1]!.slot, "W/R/T:1");
  assert.equal(r.players[0]!.yahooPlayerId, null);
  assert.equal(r.players[0]!.projectedPoints, 12.34);
  assert.deepEqual(r.legality, { complete: true, legal: true, gaps: [], issues: [] });
  assert.equal(readDesktopRules(rules, binding, now).lockBenchedPlayers, false);
});
test('rules accept the observed league settings route with exact independent team ownership', () => {
  const capture = rules.capture.replace('URL: football.fantasysports.yahoo.com/f1/100/2/settings', 'URL: football.fantasysports.yahoo.com/f1/100/settings');
  assert.equal(readDesktopRules(obs(capture), binding, now).rosterLimit, 5);
  assert.throws(() => readDesktopRules(obs(capture.replace('/100/settings', '/1000/settings')), binding, now));
  assert.throws(() => readDesktopRules(obs(capture.replace('link My Team, Value: football.fantasysports.yahoo.com/f1/100/2', 'link My Team, Value: football.fantasysports.yahoo.com/f1/100/3')), binding, now));
});
test("rejects conflicts among edit label, Description and Value instead of guessing", () => {
  for (const capture of [roster.capture.replace("Description: Player One", "Description: Someone Else"), roster.capture.replace("Value: Player One", "Value: Someone Else"), roster.capture.replace("edit QB Player One", "edit QB Someone Else")])
    assert.throws(() => readDesktopRoster(obs(capture), rules, binding, now), /identity_conflict/);
});
test("retains completed-game starters and combined waiver-priority text without inventing edit controls", () => {
  const capture = roster.capture.replace("Click here to edit W_R_T Player Two", "W/R/T")
    .replace(detail("Player Two", "RB", "Q"), detail("Player Two", "RB", "Q").replace("Wed 8:20 pm vs XYZ", "Final W 13-10 vs XYZ"))
    .replace("text Waiver Priority: 6th", "text You have used  0  of  2  IR positions on your roster. Waiver Priority: 6th");
  const result = readDesktopRoster(obs(capture), rules, binding, now);
  assert.equal(result.players.length, 5);
  assert.equal(result.players[1]!.slot, "W/R/T:1");
  assert.equal(result.players[1]!.gameText, "Final W 13-10 vs XYZ");
  assert.equal(result.players[1]!.editControlObserved, false);
  assert.equal(result.players[0]!.editControlObserved, true);
  assert.equal(result.waiverPriority, 6);
  assert.equal(result.legality.legal, true);
  assert.throws(() => readDesktopRoster(obs(capture.replace("Description: Player Two", "Description: Someone Else")), rules, binding, now), /identity_conflict/);
  assert.throws(() => readDesktopRoster(obs(capture.replace("Final W 13-10", "Unconfirmed")), rules, binding, now), /missing_game_time/);
});
test("retains live game text and both displayed projection values", () => {
  const capture = roster.capture.replace("Wed 8:20 pm vs XYZ", "Q4 6:28, 7-27 vs XYZ")
    .replace("cell (selectable) 12.34", "cell (selectable) 12.34\n0.54");
  const p = readDesktopRoster(obs(capture), rules, binding, now).players[0]!;
  assert.equal(p.projectedPoints, 12.34);
  assert.equal(p.secondaryProjectedPoints, 0.54);
  assert.equal(p.gameText, "Q4 6:28, 7-27 vs XYZ");
  assert.throws(() => readDesktopRoster(obs(capture.replace("6:28", "6:88")), rules, binding, now), /missing_game_time/);
  assert.throws(() => readDesktopRoster(obs(capture.replace("12.34\n0.54", "12.34\nunknown")), rules, binding, now), /missing_player_metrics/);
});
test("fails closed on stale rules, wrong identity, diffs, missing tables and unknown projections", () => {
  assert.throws(() => readDesktopRoster(roster, { ...rules, capturedAt: "2026-09-08T00:00:00Z" }, binding, now), /stale/);
  assert.throws(() => readDesktopRoster(obs(roster.capture.replace("f1/100/2\n", "f1/100/3\n")), rules, binding, now), /unexpected_primary_document/);
  assert.throws(() => readDesktopRoster(obs(roster.capture + "\n    999 link My Team, Value: football.fantasysports.yahoo.com/f1/100/3"), rules, binding, now), /wrong_team/);
  assert.throws(() => readDesktopRoster(obs(roster.capture.replace("1 HTML", "+1 HTML")), rules, binding, now), /full_observation/);
  assert.throws(() => readDesktopRoster(obs(roster.capture.replace("table Example's Kickers", "table Missing Kickers")), rules, binding, now), /incomplete/);
  assert.throws(() => readDesktopRoster(obs(roster.capture.replace("cell (selectable) 12.34", "cell (selectable) –")), rules, binding, now), /missing_player_metrics/);
});
test("reports missing and ineligible starters without conflating questionable with illegal", () => {
  const missing = readDesktopRoster(obs(roster.capture.replace("edit QB Player One", "edit BN Player One")), rules, binding, now);
  assert.equal(missing.legality.complete, false); assert.ok(missing.legality.gaps.includes("QB:1"));
  const illegal = readDesktopRoster(obs(roster.capture.replace("ABC - RB", "ABC - QB")), rules, binding, now);
  assert.equal(illegal.legality.legal, false); assert.ok(illegal.legality.issues.includes("ineligible_assignment"));
});
test("drop controls remain independent of lineup edits and unknown glyphs remain unknown", () => {
  const capture = identity("100/2/dropplayer") + node(2, "text Select a player to drop") + node(2, "table") +
    ["—", "\ue038", "?"].map((glyph, i) => node(3, "row (selectable)") + node(4, "cell (selectable) " + glyph) + node(4, "cell (selectable) " + detail(`Example ${i}`, "RB"))).join("");
  assert.deepEqual(readDesktopDrops(obs(capture), binding, now).map(x => x.state), ["offered", "prohibited", "unknown"]);
});
test("pool pages keep date-only waivers and historical points out of weekly projections", () => {
  const capture = identity("100/players") + node(2, "pop up button Stats, Value: 2025 Season (total)") + node(2, "table") + node(3, "row (selectable)") +
    ["\ue035", "\ue061", detail("Candidate", "RB"), "W (Sep 11)", "300"].map(x => node(4, "cell (selectable) " + x)).join("");
  const p = readDesktopPool(obs(capture), binding, now);
  assert.equal(p.coverage, "observed_page_only"); assert.equal(p.players[0]!.projectedPoints, null); assert.equal(p.players[0]!.waiverDateText, "Sep 11");
});
test("weekly pool projections require the observed stats scope, period and column layout", () => {
  const capture = identity("100/players") + node(2, "pop up button Stats, Value: Week 1 (proj)") + node(2, "table") +
    node(3, "row (selectable) Description: Fantasy Points, Value: Offense\nRoster Status\nGP*\nBye\nFan Pts\nPre-Season") +
    node(3, "row (selectable)") + ["\ue035", "\ue061", detail("Candidate", "RB"), "W (Sep 11)", "1", "7", "18.10"]
      .map(x => node(4, "cell (selectable) " + x)).join("");
  const pool = readDesktopPool(obs(capture), binding, now);
  assert.equal(pool.projectionPeriod, "1");
  assert.equal(pool.players[0]!.projectedPoints, 18.1);
  assert.equal(pool.coverage, "observed_page_only");
  assert.equal(readDesktopPool(obs(capture.replace("Week 1 (proj)", "2025 Season (total)")), binding, now).players[0]!.projectedPoints, null);
  assert.throws(() => readDesktopPool(obs(capture.replace("Fan Pts\n", "Other\n")), binding, now), /pool_projection_column_unobserved/);
  assert.throws(() => readDesktopPool(obs(capture.replace("cell (selectable) 18.10", "cell (selectable) –")), binding, now), /missing_pool_projection/);
});
test("recent transactions are not evidence of an empty pending-claims queue", () => {
  const t = readDesktopTransactions(obs(identity("100/transactions") + node(2, "heading Transactions, Value: 1") + node(2, "text  No recent transactions")), binding, now);
  assert.equal(t.recentTransactions, "none_reported"); assert.equal(t.pendingClaims, "unobserved");
});
test("advertisement contents cannot satisfy roster identity or add phantom players", () => {
  const ad = node(2, "HTML content Description: ad, URL: ad.invalid") + node(3, "text Waiver Priority: 1st");
  assert.equal(readDesktopRoster(obs(roster.capture + ad), rules, binding, now).waiverPriority, 6);
});
test("numeric multiline header labels are not accessibility nodes", () => {
  const capture = roster.capture.replace("\n% Start", "\n% Start\n4 Dwn Stops");
  assert.equal(readDesktopRoster(obs(capture), rules, binding, now).players.length, 5);
});
test("post-draft packet retains valid roster when other surfaces are blocked and grants no execution capability", () => {
  const packet = extractPostDraft({ roster, rules, drops: obs("wrong page"), pool: obs("wrong page"), transactions: obs("wrong page") }, binding, now);
  assert.equal(packet.roster.status, "pass"); assert.equal(packet.drops.status, "blocked");
  assert.equal(packet.executionEligible, false); assert.equal(packet.rosterActionsEnabled, false);
  assert.ok(packet.executionBlockers.includes("pending_claim_confirmation_unobserved"));
});
test("extraction command saves privately, suppresses player details and preserves existing evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "yahoo-extract-test-"));
  try {
    const capturedAt = new Date().toISOString();
    const observations = { roster: { ...roster, capturedAt }, rules: { ...rules, capturedAt }, drops: obs("missing"), pool: obs("missing"), transactions: obs("missing") };
    await writeFile(join(root, "observations.json"), JSON.stringify(observations));
    await writeFile(join(root, "binding.json"), JSON.stringify(binding));
    const output = join(root, "result.json");
    const args = [resolve("dist/src/cli/season-extract.js"), "--observations", join(root, "observations.json"), "--binding", join(root, "binding.json"), "--output", output];
    const stdout = execFileSync(process.execPath, args, { encoding: "utf8", stdio: "pipe" });
    assert.equal(stdout.includes("Player"), false);
    const original = await readFile(output, "utf8");
    assert.equal(JSON.parse(original).roster.status, "pass");
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.throws(() => execFileSync(process.execPath, args, { stdio: "pipe" }));
    assert.equal(await readFile(output, "utf8"), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
