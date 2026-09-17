import { digest, snapshotHash, validateSnapshot, type Player, type SeasonSnapshot } from "../../manager/season.js";
import { readDesktopRoster, readDesktopRules, type DesktopBinding, type NativeObservation } from "./desktop-season.js";
import { verifyNativeTeamCapture } from "../../runtime/native-read-proof.js";
import type { NativeState } from "./guarded-native.js";

export interface ObservedLineupControls {
  period: string;
  capture: string;
  capturedAt: string;
  sourceHash: string;
  // These are the host's independently observed controls, not deductions from
  // the rule "Lock Benched Players: No" or from projected points.
  players: Array<{
    key: string;
    eligible: string[];
    locked: boolean;
    evidenceReference: string;
    kickoff: string;
    scheduleReference: string;
    scheduleObservedAt: string;
    // Independently sourced result for a completed game whose Yahoo row no
    // longer displays kickoff. Team/opponent/period/score must match the row.
    completedGame?: {
      period: string;
      nflTeam: string;
      opponent: string;
      home: boolean;
      pointsFor: number;
      pointsAgainst: number;
    };
    inProgressGame?: { period: string; nflTeam: string; opponent: string; home: boolean };
  }>;
}
export interface LineupObservationInput {
  observationId: string;
  profileId: string;
  roster: NativeObservation;
  rules: NativeObservation;
  controls: ObservedLineupControls;
}

// A lineup-only normalized native state. No pool, drop or claim capability is
// inferred. This consumes host-observed controls; hashes establish consistency,
// not the truth of an invented host observation or profile-isolation proof.
export function buildDesktopLineupState(input: LineupObservationInput, binding: DesktopBinding, now = new Date()): NativeState {
  const fail = (code: string): never => { throw new Error(code); };
  const fresh = (timestamp: string) => {
    const age = now.getTime() - Date.parse(timestamp);
    if (!Number.isFinite(age) || age < 0 || age > binding.maxAgeMs) fail("stale_lineup_controls");
  };
  if (!input || !input.observationId?.trim() || !input.profileId?.trim() || !input.controls) fail("missing_native_lineup_observation");
  const rules = readDesktopRules(input.rules, binding, now);
  const roster = readDesktopRoster(input.roster, input.rules, binding, now);
  const controls = input.controls;
  fresh(controls.capturedAt);
  if (controls.period !== roster.period || !Array.isArray(controls.players) || controls.players.length !== roster.players.length ||
    new Set(controls.players.map(p => p?.key)).size !== roster.players.length ||
    controls.sourceHash !== digest(controls.capture) || !verifyNativeTeamCapture(controls.capture, binding)) fail("unverified_lineup_controls");
  const window = (capture: string) => capture.match(/^\d+ standard window [^\n]*?\bID: ([^,\n]+)/m)?.[1];
  const windowId = window(input.roster.capture);
  if (!windowId || window(controls.capture) !== windowId || window(input.rules.capture) !== windowId) fail("native_window_conflict");
  if (roster.legality.issues.length) fail("unsupported_roster_state");
  const lineupDeadlines: Record<string, string> = {};
  const players = roster.players.map((p): Player => {
    const c = controls.players.find(c => c.key === p.key);
    if (!c || typeof c.locked !== "boolean" || !c.evidenceReference?.trim() || !c.scheduleReference?.trim() ||
      !Array.isArray(c.eligible) || !c.eligible.length || new Set(c.eligible).size !== c.eligible.length ||
      c.eligible.some(x => !p.positions.includes(x) && !(x === "W/R/T" && p.positions.some(pos => ["RB", "WR", "TE"].includes(pos)))))
      return fail("incomplete_player_controls");
    if (p.slot && !c.eligible.includes(rules.slots.find(s => s.id === p.slot)!.position)) fail("eligible_control_conflict");
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(c.kickoff) || !Number.isFinite(Date.parse(c.kickoff))) fail("undated_player_lock");
    fresh(c.scheduleObservedAt);
    if (!c.locked && Date.parse(c.kickoff) <= now.getTime()) fail("lock_schedule_conflict");
    // Exact displayed local game time must agree with the independently dated
    // schedule. Date parsing never guesses a year or week from "Sun 1:00 pm".
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit", hour12: true })
      .formatToParts(new Date(c.kickoff));
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value;
    const displayed = `${part("weekday")} ${part("hour")}:${part("minute")} ${part("dayPeriod")?.toLowerCase()}`;
    if (/^Q[1-4] /.test(p.gameText)) {
      const game = c.inProgressGame ?? fail("in_progress_game_evidence_conflict");
      if (c.completedGame || game.period !== roster.period || game.nflTeam !== p.nflTeam ||
        !/^[A-Za-z]+$/.test(game.opponent) || typeof game.home !== "boolean" || !c.locked ||
        Date.parse(c.kickoff) > now.getTime() || !p.gameText.endsWith(` ${game.home ? "vs" : "@"} ${game.opponent}`))
        fail("in_progress_game_evidence_conflict");
    } else if (p.gameText.startsWith("Final ")) {
      const game = c.completedGame ?? fail("completed_game_evidence_conflict");
      if (c.inProgressGame || game.period !== roster.period || game.nflTeam !== p.nflTeam ||
        !/^[A-Za-z]+$/.test(game.opponent) || typeof game.home !== "boolean" ||
        !Number.isInteger(game.pointsFor) || game.pointsFor < 0 ||
        !Number.isInteger(game.pointsAgainst) || game.pointsAgainst < 0 ||
        !c.locked || p.editControlObserved || Date.parse(c.kickoff) > now.getTime()) fail("completed_game_evidence_conflict");
      const result = game.pointsFor > game.pointsAgainst ? "W" : game.pointsFor < game.pointsAgainst ? "L" : "T";
      if (p.gameText !== `Final ${result} ${game.pointsFor}-${game.pointsAgainst} ${game.home ? "vs" : "@"} ${game.opponent}`)
        fail("completed_game_evidence_conflict");
    } else if (c.completedGame || c.inProgressGame || !p.gameText.startsWith(displayed + " ")) fail("player_schedule_conflict");
    lineupDeadlines[p.key] = c.kickoff;
    const status = p.injuryLabel === null ? "active" : p.injuryLabel === "Q" ? "questionable" :
      p.injuryLabel === "O" ? "out" : ["IR", "PUP"].includes(p.injuryLabel) ? "injured_reserve" : null;
    if (!status) return fail("unsupported_player_status");
    return { id: p.key, eligible: [...c.eligible], slot: p.slot, projectedPoints: p.projectedPoints,
      status, locked: c.locked, canDrop: false, availability: "rostered" as const };
  });
  // Oldest required observation governs freshness, not normalization time.
  const capturedAt = [input.roster.capturedAt, input.rules.capturedAt, controls.capturedAt,
    ...controls.players.map(c => c.scheduleObservedAt)].sort((a, b) => Date.parse(a) - Date.parse(b))[0]!;
  const snapshot: SeasonSnapshot = { schemaVersion: 1, leagueId: binding.leagueId, teamId: binding.teamId,
    period: roster.period, capturedAt, hash: "", roster: players, available: [], slots: rules.slots, rosterLimit: rules.rosterLimit, waiverType: rules.waiverType };
  snapshot.hash = snapshotHash(snapshot);
  validateSnapshot(snapshot, binding, now);
  return { observationId: input.observationId, profileId: input.profileId, windowId: windowId!, capture: input.roster.capture,
    snapshot, lineupDeadlines, acquisitionDeadlines: {} };
}
