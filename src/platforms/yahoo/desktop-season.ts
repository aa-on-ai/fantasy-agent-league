import { digest, type Binding, type StarterSlot } from "../../manager/season.js";
import { nativeDocumentUrl } from "../../runtime/native-read-proof.js";

export interface NativeObservation { capture: string; capturedAt: string }
export interface DesktopBinding extends Binding { teamName: string }
export interface NativeNode { id: number; depth: number; text: string }
type Node = NativeNode;
const fail = (code: string): never => { throw new Error(code); };

// Safari emits multiline cells, with Description and Value sometimes disagreeing.
// Keep the original cell intact; row names are never selected by a fuzzy match.
function nodes(ax: string): Node[] {
  if (/^[ \t]*[+~]\d+ /m.test(ax)) fail("full_observation_required");
  const result: Node[] = [];
  for (const line of ax.split("\n")) {
    const m = line.match(/^([ \t]*)(\d+) (.*)$/);
    if (m && (m[1]!.length > 0 || /^(standard window|menu bar)/.test(m[3]!))) result.push({ id: Number(m[2]), depth: m[1]!.replaceAll("\t", "    ").length, text: m[3]! });
    else if (result.length && line && !line.startsWith("The focused UI element")) result.at(-1)!.text += "\n" + line;
  }
  return result;
}
function descendants(all: Node[], index: number): Node[] {
  const parent = all[index]!;
  const out: Node[] = [];
  for (let i = index + 1; i < all.length && all[i]!.depth > parent.depth; i++) out.push(all[i]!);
  return out;
}
function cells(all: Node[], index: number): string[] {
  return descendants(all, index).filter(n => n.text.startsWith("cell (selectable)"))
    .map(n => n.text.replace(/^cell \(selectable\) ?/, ""));
}
function value(cell: string): string { return cell.includes(", Value: ") ? cell.split(", Value: ").at(-1)! : cell; }
function primary(all: Node[]): Node[] {
  const i = all.findIndex(n => n.text.startsWith("HTML content"));
  if (i < 0) return fail("full_observation_required");
  // Discard nested advertising documents and their descendants.
  const subtree = descendants(all, i), result = [all[i]!];
  let excludedDepth = Infinity;
  for (const n of subtree) {
    if (n.depth <= excludedDepth) excludedDepth = Infinity;
    if (n.text.startsWith("HTML content")) excludedDepth = n.depth;
    if (excludedDepth === Infinity) result.push(n);
  }
  return result;
}
// Execution code may resolve indices only from the current full observation.
export const nativePrimaryTree = (capture: string) => primary(nodes(capture));
export const nativeDescendants = descendants;
export const nativePlayerCell = player;
function bound(observation: NativeObservation, binding: DesktopBinding, suffix: string | string[], now: Date): Node[] {
  if (!/^\d+$/.test(binding.leagueId) || !/^\d+$/.test(binding.teamId) || !binding.teamName.trim()) fail("invalid_team_binding");
  const age = now.getTime() - Date.parse(observation.capturedAt);
  if (!Number.isFinite(age) || !Number.isFinite(binding.maxAgeMs) || binding.maxAgeMs <= 0 || age < 0 || age > binding.maxAgeMs) fail("stale_native_observation");
  const all = primary(nodes(observation.capture));
  const team = `football.fantasysports.yahoo.com/f1/${binding.leagueId}/${binding.teamId}`;
  const expected = (Array.isArray(suffix) ? suffix : [suffix]).map(s => s.startsWith("@") ? `football.fantasysports.yahoo.com/f1/${binding.leagueId}/${s.slice(1)}` : team + s);
  const url = nativeDocumentUrl(observation.capture);
  if (!url || !expected.includes(url)) fail("unexpected_primary_document");
  const links = all.filter(n => n.text.startsWith("link My Team, Value: "));
  if (!links.length || links.some(n => n.text !== `link My Team, Value: ${team}`)) fail("wrong_team");
  if (all.some(n => /^(?:heading|text|button).*\b(?:Verify you are human|CAPTCHA|Sign in to Yahoo)\b/i.test(n.text))) fail("human_challenge");
  return all;
}
export interface ObservedRules {
  slots: StarterSlot[];
  benchCount: number;
  injuryCount: number;
  rosterLimit: number;
  waiverType: "rolling";
  waiverDays: number;
  weeklyWaivers: string;
  lockBenchedPlayers: boolean;
  sourceHash: string;
  capturedAt: string;
}
const normalizeSlot = (s: string) => s.replaceAll("_", "/");
export function readDesktopRules(observation: NativeObservation, binding: DesktopBinding, now = new Date()): ObservedRules {
  const all = bound(observation, binding, ["/settings", "@settings"], now);
  const settings = new Map<string, string>();
  all.forEach((n, i) => {
    if (!n.text.startsWith("row (selectable)")) return;
    const c = cells(all, i);
    if (c.length === 2) {
      const key = c[0]!.replaceAll("\u00a0", " ").replace(/:$/, "");
      if (settings.has(key)) fail("duplicate_setting");
      settings.set(key, c[1]!);
    }
  });
  if (settings.get("League ID#") !== binding.leagueId) fail("wrong_league_settings");
  if (settings.get("Waiver Type") !== "Continual rolling list" || settings.get("Weekly Waivers") !== "Game Time - Tuesday") fail("unsupported_waiver_rules");
  const positions = settings.get("Roster Positions")?.split(", ");
  if (!positions?.length || positions.some(p => !["QB", "RB", "WR", "TE", "W/R/T", "K", "DEF", "BN", "IR"].includes(p))) return fail("unsupported_roster_rules");
  const counts: Record<string, number> = {};
  const slots = positions.filter(p => p !== "BN" && p !== "IR").map(position => ({ id: `${position}:${counts[position] = (counts[position] ?? 0) + 1}`, position }));
  const benchCount = positions.filter(p => p === "BN").length, injuryCount = positions.filter(p => p === "IR").length;
  const waiverDays = Number(settings.get("Waiver Time")?.match(/^(\d+) days$/)?.[1]);
  const lock = settings.get("Lock Benched Players");
  if (!Number.isInteger(waiverDays) || waiverDays < 1 || !["Yes", "No"].includes(lock ?? "")) fail("incomplete_rules");
  return { slots, benchCount, injuryCount, rosterLimit: slots.length + benchCount, waiverType: "rolling", waiverDays,
    weeklyWaivers: "Game Time - Tuesday", lockBenchedPlayers: lock === "Yes", capturedAt: observation.capturedAt, sourceHash: digest(observation.capture) };
}
export interface ObservedRosterPlayer {
  // A native lookup key, explicitly not a Yahoo player ID or a transport selector.
  key: string;
  yahooPlayerId: null;
  name: string;
  nflTeam: string;
  positions: string[];
  assignment: string;
  slot: string | null;
  projectedPoints: number;
  // Preserve the secondary number Yahoo shows under the main projection
  // during a live game. It is not silently substituted for the primary value.
  secondaryProjectedPoints: number | null;
  bye: number;
  injuryLabel: string | null;
  gameText: string;
  editControlObserved: boolean;
}
function player(cell: string) {
  const v = value(cell), lines = v.split("\n");
  const name = lines[0]!;
  const description = cell.match(/, Description: ([^\n]+)/)?.[1];
  const leading = cell.split("\n")[0]!;
  if (!name || description && description !== name || leading !== name) fail("player_identity_conflict");
  const pos = lines.map(l => l.match(/^([A-Za-z]+) - (QB|RB|WR|TE|K|DEF)(?:,(QB|RB|WR|TE|K|DEF))*$/)).find(Boolean);
  if (!pos) return fail("missing_player_position");
  const positionLine = pos[0], [nflTeam, positions] = positionLine.split(" - ");
  const gameText = lines.find(l => /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}:\d{2} [ap]m (?:@|vs) /.test(l) || /^Final [WLT] \d+-\d+ (?:@|vs) [A-Za-z]+$/.test(l) || /^Q[1-4] (?:[0-9]|1[0-5]):[0-5][0-9], \d+-\d+ (?:@|vs) [A-Za-z]+$/.test(l));
  if (!gameText) return fail("missing_game_time");
  const injuryLabel = lines.find(l => ["Q", "O", "D", "IR", "PUP", "SUSP", "NA"].includes(l)) ?? null;
  return { key: `${nflTeam}:${name}`, yahooPlayerId: null, name, nflTeam: nflTeam!, positions: positions!.split(","), injuryLabel, gameText };
}
export interface DesktopRoster {
  leagueId: string; teamId: string; teamName: string;
  period: string; capturedAt: string; sourceHash: string;
  players: ObservedRosterPlayer[];
  waiverPriority: number;
  gameTimeZone: "EDT";
  legality: { complete: boolean; legal: boolean; gaps: string[]; issues: string[] };
}
export function readDesktopRoster(observation: NativeObservation, rulesObservation: NativeObservation, binding: DesktopBinding, now = new Date()): DesktopRoster {
  const rules = readDesktopRules(rulesObservation, binding, now), all = bound(observation, binding, "", now);
  if (!all.some(n => n.text === `text ${binding.teamName}` || n.text.startsWith(`text ${binding.teamName} `))) fail("missing_team_name");
  if (!all.some(n => n.text.includes("All game times are shown in EDT."))) fail("unsupported_game_timezone");
  const players: ObservedRosterPlayer[] = [], counts: Record<string, number> = {}, periods = new Set<string>();
  const categories = new Set<string>();
  all.forEach((n, i) => {
    const table = n.text.match(/^table (.+)'s (Offense|Kickers|Defense\/Special Teams) roster for week (\d+)\./);
    if (!table) return;
    if (table[1] !== binding.teamName || categories.has(table[2]!)) fail("ambiguous_roster_table");
    categories.add(table[2]!); periods.add(table[3]!);
    const children = descendants(all, i);
    if (!children.some(x => value(x.text).includes("\nProj Pts\n"))) fail("projection_column_unobserved");
    children.forEach((row, j) => {
      if (!row.text.startsWith("row (selectable)")) return;
      const c = cells(children, j);
      if (!c.length) return;
      const editable = c[0]!.match(/^Click here to edit (QB|RB|WR|TE|W_R_T|K|DEF|BN|IR)(?: (.+))?$/);
      // Completed games expose a plain assignment instead of an edit label.
      // Preserve that observation; absence of an edit label grants no lock or
      // execution capability without the independent controls producer.
      const slot = editable ?? c[0]!.match(/^(QB|RB|WR|TE|W\/R\/T|W_R_T|K|DEF|BN|IR)$/);
      if (!slot) return fail("unrecognized_roster_row");
      if (c[1] === "(Empty)") return;
      if (c.length < 5) return fail("incomplete_roster_row");
      const p = player(c[1]!);
      if (editable && slot[2] !== p.name) fail("player_identity_conflict");
      const assignment = normalizeSlot(slot[1]!);
      const projections = c[4]!.split("\n");
      if (projections.length > 2 || projections.some(v => !/^-?\d+(?:\.\d+)?$/.test(v)) ||
        (projections.length === 2 && !/^Q[1-4] /.test(p.gameText))) fail("missing_player_metrics");
      const projectedPoints = Number(projections[0]);
      const secondaryProjectedPoints = projections.length === 2 ? Number(projections[1]) : null;
      const bye = /^\d+$/.test(c[2]!) ? Number(c[2]) : NaN;
      if (!Number.isFinite(projectedPoints) || !Number.isInteger(bye) || bye < 1 || bye > 18) fail("missing_player_metrics");
      const slotId = ["BN", "IR"].includes(assignment) ? null : `${assignment}:${counts[assignment] = (counts[assignment] ?? 0) + 1}`;
      players.push({ ...p, assignment, slot: slotId, projectedPoints, secondaryProjectedPoints, bye, editControlObserved: !!editable });
    });
  });
  if (categories.size !== 3 || periods.size !== 1 || !players.length || new Set(players.map(p => p.key)).size !== players.length) fail("incomplete_or_duplicate_roster");
  const issues: string[] = [];
  if (players.filter(p => p.assignment !== "IR").length > rules.rosterLimit || players.filter(p => p.assignment === "IR").length > rules.injuryCount) issues.push("roster_capacity");
  if (players.filter(p => p.assignment === "BN").length > rules.benchCount) issues.push("bench_capacity");
  for (const p of players) {
    if (p.assignment === "IR") issues.push("injury_slot_eligibility_unverified");
    if (p.slot && (!rules.slots.some(s => s.id === p.slot) || !(p.positions.includes(p.assignment) || p.assignment === "W/R/T" && p.positions.some(x => ["WR", "RB", "TE"].includes(x))))) issues.push("ineligible_assignment");
  }
  const gaps = rules.slots.filter(s => !players.some(p => p.slot === s.id)).map(s => s.id);
  const priorities = all.map(n => n.text.match(/^text (?:You have used\s+\d+\s+of\s+\d+\s+IR positions on your roster\. )?Waiver Priority: (\d+)(?:st|nd|rd|th)$/)?.[1]).filter(Boolean);
  if (priorities.length !== 1) fail("missing_waiver_priority");
  return { leagueId: binding.leagueId, teamId: binding.teamId, teamName: binding.teamName, period: [...periods][0]!,
    capturedAt: observation.capturedAt, sourceHash: digest(observation.capture), players, waiverPriority: Number(priorities[0]), gameTimeZone: "EDT",
    legality: { complete: gaps.length === 0, legal: gaps.length === 0 && issues.length === 0, gaps, issues } };
}
export function readDesktopDrops(observation: NativeObservation, binding: DesktopBinding, now = new Date()) {
  const all = bound(observation, binding, "/dropplayer", now);
  if (!all.some(n => n.text === "text Select a player to drop")) fail("missing_drop_table");
  const result: Array<{ key: string; rawControl: string; state: "offered" | "prohibited" | "unknown" }> = [];
  all.forEach((n, i) => {
    if (!n.text.startsWith("row (selectable)")) return;
    const c = cells(all, i);
    if (c.length < 2) return;
    const p = player(c[1]!);
    // Native screenshot corroborated blue minus and red prohibited glyphs.
    result.push({ key: p.key, rawControl: c[0]!, state: c[0] === "—" ? "offered" : c[0] === "\ue038" ? "prohibited" : "unknown" });
  });
  if (!result.length || new Set(result.map(p => p.key)).size !== result.length) fail("incomplete_drop_controls");
  return result;
}
export function readDesktopPool(observation: NativeObservation, binding: DesktopBinding, now = new Date()) {
  const all = bound(observation, binding, "@players", now);
  const stats = all.find(n => n.text.startsWith("pop up button Stats, Value: "))?.text.split("Value: ")[1];
  if (!stats) fail("missing_pool_stats_scope");
  const projectionPeriod = stats!.match(/^Week ([1-9]\d*) \(proj\)$/)?.[1] ?? null;
  // In the observed weekly-projection view, Fan Pts contains projections. The
  // same label in a historical/statistics view must never become a forecast.
  const projectionHeader = all.some(n => n.text.startsWith("row (selectable)") &&
    n.text.includes(", Value: Offense\nRoster Status\nGP*\nBye\nFan Pts\n"));
  if (projectionPeriod && !projectionHeader) fail("pool_projection_column_unobserved");
  const result: Array<{ key: string; name: string; positions: string[]; availability: "waivers" | "free_agent" | "unknown"; waiverDateText: string | null; projectedPoints: number | null; rawControl: string }> = [];
  all.forEach((n, i) => {
    if (!n.text.startsWith("row (selectable)")) return;
    const c = cells(all, i);
    if (c.length < 4) return;
    const p = player(c[2]!);
    const waiver = c[3]!.match(/^W \(([^)]+)\)$/);
    const points = projectionPeriod && /^-?\d+(?:\.\d+)?$/.test(c[6] ?? "") ? Number(c[6]) : null;
    if (projectionPeriod && points === null) fail("missing_pool_projection");
    result.push({ key: p.key, name: p.name, positions: p.positions, availability: waiver ? "waivers" : c[3] === "FA" ? "free_agent" : "unknown",
      waiverDateText: waiver?.[1] ?? null, projectedPoints: points, rawControl: c[0]! });
  });
  if (!result.length || new Set(result.map(p => p.key)).size !== result.length) fail("incomplete_pool_page");
  // A page is a bounded sample. Historical points never become weekly projections.
  return { statsScope: stats!, projectionPeriod, coverage: "observed_page_only" as const, players: result };
}
export function readDesktopTransactions(observation: NativeObservation, binding: DesktopBinding, now = new Date()) {
  const all = bound(observation, binding, "@transactions", now);
  if (!all.some(n => n.text === "heading Transactions, Value: 1")) fail("missing_transactions_page");
  return { recentTransactions: all.some(n => /^text .*No recent transactions$/.test(n.text)) ? "none_reported" as const : "requires_normalization" as const,
    pendingClaims: "unobserved" as const, sourceHash: digest(observation.capture), capturedAt: observation.capturedAt };
}

// Observed September 11 roster modal. News is an excerpt: Safari can truncate
// long text nodes. Publication labels stay literal; capture time is not the
// publication time. Game-log times without dates never become lock deadlines.
export function readDesktopPlayerDetails(observation: NativeObservation, binding: DesktopBinding,
  expected: { key: string; name: string; season: number; period: string }, now = new Date()) {
  const all = bound(observation, binding, "", now);
  const one = <T>(items: T[], code: string): T => items.length === 1 ? items[0]! : fail(code);
  if (!Number.isInteger(expected.season) || expected.season < 2000 || !/^[1-9]\d*$/.test(expected.period)) fail("invalid_player_detail_binding");
  if (!all.some(n => n.text === `table ${binding.teamName}'s Offense roster for week ${expected.period}.\n` ||
    n.text === `table ${binding.teamName}'s Offense roster for week ${expected.period}.`)) fail("player_detail_period_conflict");
  const photo = one(all.filter(n => n.text.startsWith("image Photo of ")), "missing_selected_player_identity");
  if (photo.text !== `image Photo of ${expected.name}`) fail("wrong_selected_player");
  const photoIndex = all.indexOf(photo);
  const modal = all.slice(photoIndex);
  const selectedLink = one(modal.filter(n => n.depth === photo.depth && n.text.startsWith(`link ${expected.name}, Value: `)), "missing_selected_player_identity");
  const reference = selectedLink.text.split(", Value: ")[1]!;
  const numericId = reference.match(/^sports\.yahoo\.com\/nfl\/players\/(\d+)$/)?.[1] ?? null;
  if (!numericId && !/^sports\.yahoo\.com\/nfl\/teams\/[a-z-]+\/$/.test(reference)) fail("invalid_player_detail_reference");
  const rosterCells = all.slice(0, photoIndex).filter(n => n.text.startsWith("cell (selectable) ") &&
    n.text.includes(`, Value: ${expected.name}\n`));
  const owned = player(one(rosterCells, "missing_owned_detail_player").text.replace(/^cell \(selectable\) /, ""));
  if (owned.key !== expected.key || owned.name !== expected.name || (!numericId && !owned.positions.includes("DEF"))) fail("player_detail_identity_conflict");
  if (!modal.some(n => n.text === `link ${binding.teamName}, Value: football.fantasysports.yahoo.com/f1/${binding.leagueId}/${binding.teamId}`))
    fail("player_detail_ownership_conflict");
  const logHeading = one(modal.filter(n => /^heading \d{4} Season Game Log, Value: 3$/.test(n.text)), "missing_player_game_log");
  if (logHeading.text !== `heading ${expected.season} Season Game Log, Value: 3`) fail("player_detail_season_conflict");
  const logIndex = modal.indexOf(logHeading);
  const tableIndex = modal.findIndex((n, i) => i > logIndex && n.text === "table");
  if (tableIndex < 0) fail("missing_player_game_log");
  const log = descendants(modal, tableIndex);
  if (!log.some(n => n.text.startsWith("row (selectable) Week\nOpp\nStatus\nProj\nFan Pts\n"))) fail("player_projection_columns_unobserved");
  const games: Array<{ period: string; opponent: string; statusText: string; projectedPoints: number | null; fantasyPoints: number | null }> = [];
  const metric = (v: string | undefined) => v === "-" ? null : v && /^-?\d+(?:\.\d+)?$/.test(v) ? Number(v) : fail("invalid_player_game_metric");
  log.forEach((n, i) => {
    if (n.text !== "row (selectable)") return;
    const c = cells(log, i);
    if (c.length < 5 || !/^[1-9]\d*$/.test(c[0]!) || !/^(?:@?[A-Za-z]+|BYE)$/.test(c[1]!) || !c[2]?.trim()) fail("invalid_player_game_row");
    games.push({ period: c[0]!, opponent: c[1]!, statusText: c[2]!, projectedPoints: metric(c[3]), fantasyPoints: metric(c[4]) });
  });
  if (!games.length || new Set(games.map(g => g.period)).size !== games.length || !games.some(g => g.period === expected.period)) fail("incomplete_player_game_log");
  const newsHeading = one(modal.filter(n => n.text === "heading Latest News, Value: 3"), "missing_player_news");
  const news = modal.slice(modal.indexOf(newsHeading) + 1).filter(n => n.text.startsWith("text ")).map(n => n.text.slice(5)).filter(t => t !== "Latest News");
  const empty = `There are no news updates for ${expected.name} in the last 10 days.`;
  const explicitlyEmpty = news.length === 1 && news[0] === empty;
  if (!explicitlyEmpty && (!news.some(t => /\s\|\s/.test(t)) || !modal.some(n => n.text.startsWith("heading ") && n.text.endsWith(", Value: 4")))) fail("player_news_unobserved");
  return { key: expected.key, name: expected.name, yahooPlayerId: numericId, reference, season: expected.season,
    period: expected.period, games, news: { status: explicitlyEmpty ? "none_in_last_10_days" as const : "observed_excerpt" as const,
      text: news, publicationDatesResolved: false as const }, capturedAt: observation.capturedAt, sourceHash: digest(observation.capture) };
}
