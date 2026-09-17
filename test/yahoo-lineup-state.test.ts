import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../src/manager/season.js";
import { buildDesktopLineupState, type LineupObservationInput } from "../src/platforms/yahoo/lineup-state.js";

const at = "2026-09-09T18:00:00Z", kickoff = "2026-09-10T00:20:00Z", now = new Date(at);
const binding = { leagueId: "100", teamId: "2", teamName: "Example", maxAgeMs: 60000 };
function fixture(): LineupObservationInput {
  let id = 10;
  const node = (depth: number, text: string) => `${"  ".repeat(depth)}${id++} ${text}\n`;
  const identity = (suffix = "") => `0 standard window Example, ID: test-window, Secondary Actions: Raise\n  1 HTML content Description: Example | Yahoo, URL: football.fantasysports.yahoo.com/f1/100/2${suffix}\n    2 link My Team, Value: football.fantasysports.yahoo.com/f1/100/2\n    3 text Example\n`;
  const settings = { "League ID#:": "100", "Waiver Type:": "Continual rolling list", "Waiver Time:": "2 days", "Weekly Waivers": "Game Time - Tuesday",
    "Roster Positions:": "QB, W/R/T, K, DEF, BN, IR", "Lock Benched Players:": "No" };
  const rules = identity("/settings") + node(2, "table") + Object.entries(settings).map(([k, v]) => node(3, "row (selectable)") +
    node(4, "cell (selectable) " + k) + node(4, "cell (selectable) " + v)).join("");
  const table = (kind: string) => node(2, `table Example's ${kind} roster for week 1.`) + node(3, "row (selectable) Description: Projected Points, Value: Pos\nOffense\nBye\nFan Pts\nProj Pts\n% Start");
  const row = (assignment: string, name: string, position: string, injury = "") => node(3, "row (selectable)") +
    [`Click here to edit ${assignment} ${name}`, `${name}\nDescription extra, Description: ${name}\nnotes, Value: ${name}\n${injury ? injury + "\n" : ""}ABC - ${position}\nWed 8:20 pm vs XYZ`,
      "7", "–", "12.34", "50%"].map(text => node(4, "cell (selectable) " + text)).join("");
  const roster = identity() + node(2, "text Waiver Priority: 6th") + table("Offense") + row("QB", "One", "QB") + row("W_R_T", "Two", "RB", "Q") +
    row("BN", "Three", "TE") + table("Kickers") + row("K", "Four", "K") + table("Defense/Special Teams") + row("DEF", "Five", "DEF") +
    node(2, "text All game times are shown in EDT.");
  const capture = identity() + node(2, "text Sanitized fixture for host-observed controls; not live evidence.");
  return { observationId: "fixture-observation", profileId: "fixture-profile", roster: { capture: roster, capturedAt: at }, rules: { capture: rules, capturedAt: at },
    controls: { period: "1", capture, capturedAt: at, sourceHash: digest(capture), players: [
      ["One", ["QB"]], ["Two", ["RB", "W/R/T"]], ["Three", ["TE", "W/R/T"]], ["Four", ["K"]], ["Five", ["DEF"]]
    ].map(([name, eligible]) => ({ key: "ABC:" + name, eligible: eligible as string[], locked: false,
      evidenceReference: "fixture:observed-controls", kickoff, scheduleReference: "fixture:dated-schedule", scheduleObservedAt: at })) } };
}

test("normalizes current native lineup, explicit controls and dated schedule without acquisition permission", () => {
  const state = buildDesktopLineupState(fixture(), binding, now);
  assert.equal(state.snapshot.roster.length, 5); assert.equal(state.snapshot.roster[1]!.status, "questionable");
  assert.equal(state.snapshot.roster[2]!.slot, null); assert.ok(state.snapshot.roster.every(p => !p.canDrop));
  assert.deepEqual(state.snapshot.available, []); assert.deepEqual(state.acquisitionDeadlines, {});
  assert.equal(state.lineupDeadlines["ABC:Two"], kickoff); assert.equal(state.windowId, "test-window");
});

test("uses the oldest source clock and rejects stale rules, controls, schedule and roster", () => {
  const input = fixture(); input.rules.capturedAt = "2026-09-09T17:59:30Z";
  assert.equal(buildDesktopLineupState(input, binding, now).snapshot.capturedAt, input.rules.capturedAt);
  for (const which of ["rules", "roster", "controls", "schedule"]) {
    const input = fixture(), stale = "2026-09-09T17:58:00Z";
    if (which === "schedule") input.controls.players[0]!.scheduleObservedAt = stale;
    else input[which as "rules" | "roster" | "controls"].capturedAt = stale;
    assert.throws(() => buildDesktopLineupState(input, binding, now), /stale/);
  }
});

test("never infers unknown individual locks from league settings", () => {
  const input = fixture(); delete (input.controls.players[0] as any).locked;
  assert.throws(() => buildDesktopLineupState(input, binding, now), /incomplete_player_controls/);
});

test("rejects missing/duplicate control rows, wrong-team capture, window changes and impossible eligibility", () => {
  for (const change of ["missing", "duplicate", "team", "window", "eligible", "hash", "period"]) {
    const input = fixture();
    if (change === "missing") input.controls.players.pop();
    if (change === "duplicate") input.controls.players[1] = input.controls.players[0]!;
    if (change === "team") input.controls.capture = input.controls.capture.replaceAll("/100/2", "/100/1");
    if (change === "window") input.controls.capture = input.controls.capture.replace("test-window", "another-window");
    if (change === "eligible") input.controls.players[0]!.eligible = ["RB"];
    input.controls.sourceHash = digest(input.controls.capture);
    if (change === "hash") input.controls.sourceHash = "wrong";
    if (change === "period") input.controls.period = "2";
    assert.throws(() => buildDesktopLineupState(input, binding, now));
  }
});

test("requires dated kickoff evidence matching the visible game and refuses past unlocked starts", () => {
  for (const kickoff of ["Wed 8:20 pm", "2026-09-10T01:20:00Z", "2026-09-09T00:20:00Z"]) {
    const input = fixture(); input.controls.players[0]!.kickoff = kickoff;
    assert.throws(() => buildDesktopLineupState(input, binding, now), /lock|schedule/);
  }
});

test("completed-game roster extraction does not manufacture actionable schedule evidence", () => {
  const input = fixture();
  input.roster.capture = input.roster.capture.replace("Click here to edit QB One", "QB")
    .replace("Wed 8:20 pm vs XYZ", "Final W 13-10 vs XYZ");
  input.controls.players[0]!.locked = true;
  assert.throws(() => buildDesktopLineupState(input, binding, now), /completed_game_evidence_conflict/);
});
test("in-progress games require a bound dated schedule and stay locked", () => {
  const input = fixture();
  input.roster.capture = input.roster.capture.replace("Wed 8:20 pm vs XYZ", "Q4 6:28, 7-27 vs XYZ")
    .replace("cell (selectable) 12.34", "cell (selectable) 12.34\n0.54");
  const c = input.controls.players[0]!;
  c.locked = true; c.kickoff = "2026-09-09T00:20:00Z";
  assert.throws(() => buildDesktopLineupState(input, binding, now), /in_progress_game_evidence_conflict/);
  c.inProgressGame = { period: "1", nflTeam: "ABC", opponent: "XYZ", home: true };
  const state = buildDesktopLineupState(input, binding, now);
  assert.equal(state.snapshot.roster[0]!.locked, true);
  assert.equal(state.snapshot.roster[0]!.projectedPoints, 12.34);
  c.inProgressGame.opponent = "Other";
  assert.throws(() => buildDesktopLineupState(input, binding, now), /in_progress_game_evidence_conflict/);
});

test("binds a completed game to independently observed period, teams, score and past kickoff", () => {
  const completed = () => {
    const input = fixture();
    input.roster.capture = input.roster.capture.replace("Click here to edit QB One", "QB")
      .replace("Wed 8:20 pm vs XYZ", "Final W 13-10 vs XYZ");
    Object.assign(input.controls.players[0]!, { locked: true, kickoff: "2026-09-09T00:20:00Z",
      completedGame: { period: "1", nflTeam: "ABC", opponent: "XYZ", home: true, pointsFor: 13, pointsAgainst: 10 } });
    return input;
  };
  const state = buildDesktopLineupState(completed(), binding, now);
  assert.equal(state.snapshot.roster[0]!.locked, true);
  assert.equal(state.snapshot.roster[0]!.slot, "QB:1");
  assert.equal(state.lineupDeadlines["ABC:One"], "2026-09-09T00:20:00Z");
  for (const change of ["period", "team", "score", "opponent", "home", "future", "editable", "unlocked"]) {
    const input = completed(), control = input.controls.players[0]!;
    if (change === "period") control.completedGame!.period = "2";
    if (change === "team") control.completedGame!.nflTeam = "Other";
    if (change === "score") control.completedGame!.pointsFor = 14;
    if (change === "opponent") control.completedGame!.opponent = "Other";
    if (change === "home") control.completedGame!.home = false;
    if (change === "future") control.kickoff = kickoff;
    if (change === "editable") input.roster.capture = input.roster.capture.replace("cell (selectable) QB\n", "cell (selectable) Click here to edit QB One\n");
    if (change === "unlocked") control.locked = false;
    assert.throws(() => buildDesktopLineupState(input, binding, now), /conflict/);
  }
});
