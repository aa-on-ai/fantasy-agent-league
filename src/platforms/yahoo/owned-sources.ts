import { randomUUID } from "node:crypto";
import type { OwnedClaimsEvidence } from "./guarded-owned.js";
import { ownedAcquisitionDeadline } from "./owned-acquisition.js";
import type { Page } from "playwright-core";
import { digest, snapshotHash, validateSnapshot, type Binding, type Player, type SeasonSnapshot, type StarterSlot } from "../../manager/season.js";
import type { ManagerPhase, ManagerSource, SourceKind } from "../../manager/codex-run.js";

export interface OwnedLink { text: string; href: string; title: string; attributes: Record<string, string> }
export interface OwnedControl {
  tag: string; type: string; name: string; text: string; value: string; disabled: boolean;
  attributes: Record<string, string>; options: Array<{ text: string; value: string; selected: boolean; disabled: boolean }>;
}
export interface OwnedRow { cells: string[]; links: OwnedLink[]; controls: OwnedControl[]; attributes: Record<string, string> }
export interface OwnedDomCapture {
  readyState?: string;
  claimMarkerCount?: number;
  pendingTransactionLinks?: OwnedLink[];
  pendingTransactionCount?: number | null;
  title: string; text: string; headings: string[];
  tables: Array<{ caption: string; headers: string[]; rows: OwnedRow[]; attributes: Record<string, string> }>;
  links: OwnedLink[]; controls: OwnedControl[];
  forms: Array<{ action: string; method: string; attributes: Record<string, string>; controls: OwnedControl[]; numericFields?: Array<{ name: string; value: string }> }>;
}
export interface OwnedObservation { observationId: string; capturedAt: string; profileId: string; url: string; dom: OwnedDomCapture }
export type OwnedSourceObservation = OwnedObservation;
export interface OwnedBinding extends Binding { teamName: string; profileId: string; period?: string; season?: number }

/** Read the existing parent-owned Page. Never opens a browser, submits, or exposes hidden input secrets. */
export async function readOwnedDom(page: Page): Promise<OwnedDomCapture> {
  return page.evaluate(() => {
    const text = (e: Element) => (e as HTMLElement).innerText?.trim() ?? e.textContent?.trim() ?? "";
    const visible = (e: Element) => (e as HTMLElement).getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden" && getComputedStyle(e).display !== "none";
    const attrs = (e: Element): Record<string, string> => Object.fromEntries([...e.attributes].filter(a =>
      /^(?:id|class|name|type|role|title|aria-label|aria-disabled|aria-selected|data-ys-playerid|data-ys-playernote-view|data-swap-groups|data-swap-targets|data-check-box-value|data-playerid|data-pid|data-player-id|data-pos|data-position|data-slot|data-action|data-status|data-kickoff|data-week|disabled|selected)$/.test(a.name)).map(a => [a.name, a.value]));
    // Yahoo route query parameters used by selectors are public view state. Drop all others.
    const safeUrl = (v: string) => {
      try { const u = new URL(v, location.href); u.username = ""; u.password = ""; u.hash = "";
        for (const key of [...u.searchParams.keys()]) if (!/^(?:stage|week|stat1|status|pos|count|sort|sdir|myteam|type|mid|pid|apid|dpid|waid|claimid|claim_id|date|o|l|t|s|p)$/.test(key)) u.searchParams.delete(key);
        return /^https?:$/.test(u.protocol) ? u.toString() : ""; } catch { return ""; }
    };
    const link = (a: HTMLAnchorElement): OwnedLink => ({ text: text(a), href: safeUrl(a.href), title: a.title, attributes: attrs(a) });
    const control = (e: Element): OwnedControl => {
      const el = e as HTMLInputElement, select = e as HTMLSelectElement;
      return { tag: e.tagName.toLowerCase(), type: el.type ?? "", name: el.name ?? "", text: text(e),
        value: e.tagName === "SELECT" || /^(?:button|submit|radio|checkbox)$/.test(el.type) ? el.value ?? "" : "",
        disabled: !!el.disabled || e.getAttribute("aria-disabled") === "true", attributes: attrs(e),
        options: e.tagName === "SELECT" ? [...select.options].map(o => ({ text: o.text, value: o.value, selected: o.selected, disabled: o.disabled })) : [] };
    };
    const controls = (e: ParentNode) => [...e.querySelectorAll('button,select,input:not([type="hidden"]):not([type="password"]),[role="button"],[role="option"]')].map(control);
    const links = (e: ParentNode) => [...e.querySelectorAll<HTMLAnchorElement>("a[href]")].map(link).filter(a => !!a.href);
    const claimMarkerCount = [...document.querySelectorAll('[id],[class],[name],a,form')].filter(e =>
      !['SCRIPT', 'STYLE'].includes(e.tagName) && /(?:\bClaim\b|\bDraggable\b|pending|editwaiver|cancelwaiver|[?&](?:waid|claimid)=)/i.test(
        [e.id, e.getAttribute('class'), e.getAttribute('name'), e.getAttribute('href'), e.getAttribute('action')].join(' '))).length;
    const pending = document.querySelector('#pending_transactions');
    const badges = pending?.previousElementSibling?.querySelectorAll('.Badge');
    const count = badges?.length === 1 ? badges[0]!.textContent?.trim() ?? '' : '';
    return { readyState: document.readyState, claimMarkerCount, pendingTransactionLinks: pending ? links(pending) : [], pendingTransactionCount: /^\d+$/.test(count) ? Number(count) : null, title: document.title, text: document.body.innerText, headings: [...document.querySelectorAll("h1,h2,h3,h4,[role=heading]")].filter(visible).map(text),
      tables: [...document.querySelectorAll("table")].filter(visible).map(table => ({ caption: table.caption ? text(table.caption) : table.getAttribute("aria-label") ?? table.getAttribute("summary") ?? "",
        headers: [...table.querySelectorAll("thead tr")].map(tr => [...tr.querySelectorAll("th,td")].filter(visible).map(text)).at(-1) ?? [], attributes: attrs(table),
        rows: [...table.querySelectorAll("tbody tr")].filter(tr => tr.closest("table") === table && visible(tr)).map(tr => ({
          cells: [...tr.querySelectorAll(":scope > td,:scope > th")].filter(visible).map(text), links: links(tr), controls: controls(tr), attributes: attrs(tr) })) })),
      links: links(document), controls: controls(document),
      forms: [...document.forms].map(form => ({ action: safeUrl(form.action), method: form.method.toLowerCase(), attributes: attrs(form), controls: controls(form),
        numericFields: [...form.querySelectorAll<HTMLInputElement>("input[name]")].filter(e => /^(?:stage|apid|dpid|mid|week)$/.test(e.name) && /^\d+$/.test(e.value)).map(e => ({ name: e.name, value: e.value })) })) };
  });
}
export async function captureOwnedObservation(page: Page, profileId: string, clock: () => Date = () => new Date()): Promise<OwnedObservation> {
  if (!profileId.trim()) throw new Error("missing_owned_profile");
  const url = page.url(), capturedAt = clock().toISOString(), dom = await readOwnedDom(page);
  if (page.url() !== url) throw new Error("owned_document_changed_during_capture");
  return { observationId: randomUUID(), capturedAt, profileId, url, dom };
}

const fail = (code: string): never => { throw new Error(code); };
const clean = (value: string) => value.replaceAll("\u00a0", " ").trim();
const one = <T>(values: T[], code: string): T => values.length === 1 ? values[0]! : fail(code);
const teamPath = (binding: Binding) => `/f1/${binding.leagueId}/${binding.teamId}`;
const leaguePath = (binding: Binding) => `/f1/${binding.leagueId}`;
function urlOf(raw: string): URL { try { return new URL(raw); } catch { return fail("invalid_owned_url"); } }
function fresh(time: string, binding: Binding, now: Date): void {
  const age = now.getTime() - Date.parse(time);
  if (!Number.isFinite(age) || age < 0 || age > binding.maxAgeMs || !Number.isFinite(binding.maxAgeMs) || binding.maxAgeMs <= 0) fail("stale_owned_observation");
}
export function validateOwnedObservation(observation: OwnedObservation, binding: OwnedBinding, now = new Date()): void {
  if (!/^\d+$/.test(binding.leagueId) || !/^\d+$/.test(binding.teamId) || !binding.teamName?.trim() || !binding.profileId?.trim()) fail("invalid_owned_binding");
  if (!observation?.observationId || observation.profileId !== binding.profileId || !observation.dom) fail("wrong_owned_profile");
  fresh(observation.capturedAt, binding, now);
  const url = urlOf(observation.url);
  if (url.protocol !== "https:" || url.hostname !== "football.fantasysports.yahoo.com" || url.username || url.password ||
    !(url.pathname === leaguePath(binding) || url.pathname.startsWith(leaguePath(binding) + "/"))) fail("wrong_owned_league");
  const numericTeam = url.pathname.slice(leaguePath(binding).length).match(/^\/(\d+)(?:\/|$)/)?.[1];
  if (numericTeam && numericTeam !== binding.teamId) fail("wrong_owned_team");
  const mine = observation.dom.links.filter(link => clean(link.text) === "My Team");
  if (!mine.length || mine.some(link => { const u = urlOf(link.href); return u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.hostname !== url.hostname || u.pathname !== teamPath(binding); })) fail("wrong_owned_team");
  if (/\b(?:Verify you are human|CAPTCHA|Sign in to Yahoo)\b/i.test(observation.dom.text)) fail("owned_browser_challenge");
}
function route(observation: OwnedObservation, paths: string[]): void {
  if (!paths.includes(urlOf(observation.url).pathname)) fail("unexpected_owned_source_route");
}
export interface OwnedRules {
  slots: StarterSlot[]; rosterLimit: number; benchCount: number; injuryCount: number;
  waiverType: "rolling"; waiverDays: number; weeklyWaivers: string; lockBenchedPlayers: boolean;
  settings: Record<string, string>; scoring: Array<{ headers: string[]; rows: string[][] }>; capturedAt: string; sourceHash: string;
}
export function readOwnedRules(observation: OwnedObservation, binding: OwnedBinding, now = new Date()): OwnedRules {
  validateOwnedObservation(observation, binding, now); route(observation, [leaguePath(binding) + "/settings", teamPath(binding) + "/settings"]);
  const settings: Record<string, string> = {};
  for (const row of observation.dom.tables.flatMap(t => t.rows)) {
    if (row.cells.length !== 2) continue;
    const key = clean(row.cells[0]!).replace(/:$/, "");
    if (key in settings) fail("duplicate_owned_setting");
    settings[key] = clean(row.cells[1]!);
  }
  if (settings["League ID#"] !== binding.leagueId) fail("wrong_owned_league_settings");
  if (settings["Waiver Type"] !== "Continual rolling list" || settings["Weekly Waivers"] !== "Game Time - Tuesday") fail("unsupported_owned_waiver_rules");
  const positions = settings["Roster Positions"]?.split(/,\s*/);
  if (!positions?.length || positions.some(p => !["QB", "RB", "WR", "TE", "W/R/T", "K", "DEF", "BN", "IR"].includes(p))) return fail("unsupported_owned_roster_rules");
  const counts: Record<string, number> = {};
  const slots = positions.filter(p => !["BN", "IR"].includes(p)).map(position => ({ id: `${position}:${counts[position] = (counts[position] ?? 0) + 1}`, position }));
  const benchCount = positions.filter(p => p === "BN").length, injuryCount = positions.filter(p => p === "IR").length;
  const waiverDays = Number(settings["Waiver Time"]?.match(/^(\d+) days?$/)?.[1]);
  if (!Number.isInteger(waiverDays) || waiverDays < 1 || !["Yes", "No"].includes(settings["Lock Benched Players"] ?? "")) fail("incomplete_owned_rules");
  return { slots, rosterLimit: slots.length + benchCount, benchCount, injuryCount, waiverType: "rolling", waiverDays,
    weeklyWaivers: settings["Weekly Waivers"]!, lockBenchedPlayers: settings["Lock Benched Players"] === "Yes", settings,
    scoring: observation.dom.tables.filter(t => t.headers.includes("League Value")).map(t => ({ headers: t.headers, rows: t.rows.map(r => r.cells) })),
    capturedAt: observation.capturedAt, sourceHash: digest(observation.dom) };
}

/** Import the parent's September 15 DOM evidence shape. This is not a native accessibility conversion. */
export function importOwnedCapture(raw: unknown, profileId: string): OwnedObservation {
  const x = raw as Record<string, any>;
  if (!x || x.schemaVersion !== 1 || x.evidenceType !== "owned_browser_dom" || typeof x.url !== "string" || typeof x.capturedAt !== "string" || !Array.isArray(x.tables) || !Array.isArray(x.links)) fail("invalid_owned_capture");
  const attrs = (v: Record<string, any>) => ({ ...(v.attributes ?? v.attrs ?? {}), ...(v.ariaLabel ? { "aria-label": v.ariaLabel } : {}) });
  const link = (v: Record<string, any>): OwnedLink => ({ text: v.text ?? "", href: v.href ?? "", title: v.title ?? "", attributes: attrs(v) });
  const control = (v: Record<string, any>): OwnedControl => ({ tag: v.tag ?? "", type: v.type ?? "", name: v.name ?? "", text: v.text ?? "", value: v.value ?? "", disabled: v.disabled === true,
    attributes: attrs(v), options: (v.options ?? []).map((o: any) => ({ text: o.text ?? "", value: o.value ?? "", selected: o.selected === true, disabled: o.disabled === true })) });
  const controls = (values: Array<Record<string, any>>) => values.filter(v => !["hidden", "password"].includes(v.type)).map(control);
  const dom: OwnedDomCapture = { title: x.title ?? "", text: x.text ?? "", headings: x.headings ?? [], links: x.links.map(link), controls: controls(x.controls ?? []),
    tables: x.tables.map((t: any) => ({ caption: t.caption ?? "", attributes: attrs(t), headers: Array.isArray(t.headers?.[0]) ? t.headers.at(-1) : t.headers ?? [], rows: (t.rows ?? []).map((r: any) => ({ cells: r.cells ?? [], links: (r.links ?? []).map(link), controls: controls(r.controls ?? []), attributes: attrs(r) })) })),
    forms: (x.forms ?? []).map((f: any) => ({ action: f.action ?? "", method: f.method ?? "", attributes: attrs(f), controls: controls(f.controls ?? []), numericFields: (f.numericFields ?? f.numericFormFields ?? (x.numericFormFields ?? []).find((v: any) => { try { return v.action === new URL(f.action).pathname; } catch { return false; } })?.fields ?? []).filter((v: any) => /^(?:stage|apid|dpid|mid|week)$/.test(v.name) && /^\d+$/.test(v.value)).map((v: any) => ({ name: v.name, value: v.value })) })) };
  return { observationId: digest({ url: x.url, capturedAt: x.capturedAt, dom }), profileId, url: x.url, capturedAt: x.capturedAt, dom };
}
export interface OwnedRosterPlayer {
  id: string; name: string; nflTeam: string; positions: string[]; eligible: string[];
  assignment: string; slot: string | null; projectedPoints: number; injuryLabel: string | null;
  gameText: string; kickoff: string | null; scheduleReference: string | null;
  locked: boolean | null; editControlObserved: boolean; bye: number; newsLink: string | null;
}
export interface OwnedRoster { period: string; players: OwnedRosterPlayer[]; gaps: string[]; capturedAt: string }
function playerIdentity(row: OwnedRow): { id: string; name: string; nflTeam: string; positions: string[]; cell: string } {
  const playerLinks = row.links.filter(l => /^https:\/\/sports\.yahoo\.com\/nfl\/(?:players\/\d+\/?|teams\/[a-z-]+\/)$/i.test(l.href) && !/^(?:No new player Notes|New Player Note|Player Note)$/.test(l.text));
  const selected = one(playerLinks, "missing_owned_player_identity");
  const linkId = selected.href.match(/\/players\/(\d+)\/?$/)?.[1];
  const attrId = selected.attributes["data-ys-playerid"] ?? selected.attributes["data-playerid"] ?? row.attributes["data-player-id"];
  if (linkId && attrId && linkId !== attrId) fail("conflicting_owned_player_id");
  const id = linkId ?? attrId;
  if (!id || !/^\d+$/.test(id)) fail("unobserved_owned_player_id");
  const cell = one(row.cells.filter(c => /\b[A-Za-z]+ - (?:QB|RB|WR|TE|K|DEF)(?:,|\b)/.test(c)), "missing_owned_player_positions");
  const match = clean(cell).match(/\b([A-Za-z]+) - ((?:QB|RB|WR|TE|K|DEF)(?:,(?:QB|RB|WR|TE|K|DEF))*)\b/)!;
  if (!clean(cell).startsWith(selected.text)) fail("owned_player_name_conflict");
  return { id: id!, name: selected.text, nflTeam: match[1]!, positions: match[2]!.split(","), cell: clean(cell) };
}
function gameSchedule(row: OwnedRow, gameText: string, timeZone: string): { kickoff: string | null; scheduleReference: string | null } {
  const games = row.links.filter(l => /^https:\/\/sports\.yahoo\.com\/nfl\/[a-z0-9-]+-\d{11}\/$/.test(l.href));
  if (games.length !== 1 || !["EDT", "EST"].includes(timeZone)) return { kickoff: null, scheduleReference: null };
  const reference = games[0]!.href, date = reference.match(/-(\d{4})(\d\d)(\d\d)\d{3}\/$/)!;
  const time = gameText.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\d{1,2}):(\d\d) ([ap])m (?:@|vs) /);
  if (!time) return { kickoff: null, scheduleReference: reference };
  const hour = Number(time[2]) % 12 + (time[4] === "p" ? 12 : 0);
  if (Number(time[2]) < 1 || Number(time[2]) > 12 || Number(time[3]) > 59) fail("invalid_owned_game_time");
  const candidate = `${date[1]}-${date[2]}-${date[3]}T${String(hour).padStart(2, "0")}:${time[3]}:00${timeZone === "EDT" ? "-04:00" : "-05:00"}`;
  const parsed = new Date(candidate);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }).formatToParts(parsed);
  const p = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value;
  if (p("weekday") !== time[1] || p("year") !== date[1] || p("month") !== date[2] || p("day") !== date[3] || p("timeZoneName") !== timeZone || Number(p("hour")) !== Number(time[2])) fail("owned_schedule_date_conflict");
  return { kickoff: parsed.toISOString(), scheduleReference: reference };
}
export function readOwnedRoster(observation: OwnedObservation, rules: OwnedRules, binding: OwnedBinding, now = new Date()): OwnedRoster {
  validateOwnedObservation(observation, binding, now); fresh(rules.capturedAt, binding, now);
  route(observation, [teamPath(binding), teamPath(binding) + "/team"]);
  const tables = observation.dom.tables.filter(t => /'s (Offense|Kickers|Defense\/Special Teams) roster for week \d+\./.test(t.caption));
  const periods = new Set<string>(), categories = new Set<string>(), counts: Record<string, number> = {}, players: OwnedRosterPlayer[] = [], gaps: string[] = [];
  const timeZone = observation.dom.text.match(/All game times are shown in (EDT|EST)\./)?.[1] ?? "unknown";
  for (const table of tables) {
    const match = table.caption.match(/^(.+)'s (Offense|Kickers|Defense\/Special Teams) roster for week (\d+)\.$/);
    if (!match || match[1] !== binding.teamName) fail("wrong_owned_roster_name");
    categories.add(match![2]!); periods.add(match![3]!);
    const headers = table.headers.map(clean), posIndex = headers.indexOf("Pos"), projectionIndex = headers.indexOf("Proj Pts"), byeIndex = headers.indexOf("Bye");
    if (posIndex < 0 || projectionIndex < 0 || byeIndex < 0) fail("unobserved_owned_roster_columns");
    for (const row of table.rows) {
      const assignment = clean(row.cells[posIndex] ?? "").replaceAll("_", "/");
      if (!/^(?:QB|RB|WR|TE|W\/R\/T|K|DEF|BN|IR)$/.test(assignment)) fail("unsupported_owned_assignment");
      const slot = ["BN", "IR"].includes(assignment) ? null : `${assignment}:${counts[assignment] = (counts[assignment] ?? 0) + 1}`;
      if (row.cells.some(c => clean(c) === "(Empty)")) continue;
      const identity = playerIdentity(row);
      const pointsText = clean(row.cells[projectionIndex] ?? "").split("\n")[0]!;
      if (!/^-?\d+(?:\.\d+)?$/.test(pointsText)) fail("missing_owned_roster_projection");
      const bye = Number(clean(row.cells[byeIndex] ?? ""));
      if (!Number.isInteger(bye) || bye < 1 || bye > 18) fail("missing_owned_bye");
      const suffix = identity.cell.slice(identity.name.length).split("\n")[0]!;
      const injuryLabel = suffix.match(/^(IR|PUP|SUSP|NA|Q|O|D)(?=Video|Player|New|No|$)/)?.[1] ?? null;
      const gameText = identity.cell.split("\n").find(l => /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Final |Q[1-4] |Bye)/.test(l))?.replace(/[\ue000-\uf8ff]/g, "").trim() ?? "";
      const schedule = gameSchedule(row, gameText, timeZone);
      const controls = row.controls.filter(c => c.attributes["aria-label"]?.startsWith("Click here to edit "));
      if (controls.length > 1) fail("ambiguous_owned_edit_controls");
      const edit = controls[0];
      if (edit && edit.attributes["aria-label"] !== `Click here to edit ${assignment.replaceAll("/", "_")} ${identity.name}` && edit.attributes["aria-label"] !== `Click here to edit ${assignment} ${identity.name}`) fail("owned_edit_identity_conflict");
      const editControlObserved = !!edit && !edit.disabled;
      const locked = editControlObserved ? false : edit?.disabled === true || /(?:^|\s)locked(?:\s|$)/.test(row.attributes.class ?? "") ? true : null;
      if (locked === false && schedule.kickoff && Date.parse(schedule.kickoff) <= now.getTime()) fail("owned_lock_schedule_conflict");
      const eligible = [...identity.positions, ...rules.slots.map(s => s.position).filter(p => p === "W/R/T" && identity.positions.some(x => ["RB", "WR", "TE"].includes(x)))].filter((p, i, a) => a.indexOf(p) === i);
      if (assignment === "IR") gaps.push(`injury_slot_unsupported:${identity.id}`);
      if (locked === null) gaps.push(`locks_unobserved:${identity.id}`);
      if (!schedule.kickoff) gaps.push(`dated_schedule_unobserved:${identity.id}`);
      if (slot && (!rules.slots.some(s => s.id === slot) || !eligible.includes(assignment))) gaps.push(`ineligible_assignment:${identity.id}`);
      players.push({ ...identity, assignment, slot, projectedPoints: Number(pointsText), eligible, injuryLabel, gameText, ...schedule, locked, editControlObserved, bye,
        newsLink: row.links.find(l => /^(?:Player Note|New Player Note|No new player Notes)$/.test(l.text))?.href ?? null });
    }
  }
  if (categories.size !== 3 || periods.size !== 1 || !players.length || new Set(players.map(p => p.id)).size !== players.length) fail("incomplete_owned_roster");
  const period = [...periods][0]!;
  if (binding.period && binding.period !== period) fail("wrong_owned_period");
  if (players.filter(p => p.assignment !== "IR").length > rules.rosterLimit) gaps.push("owned_roster_capacity_exceeded");
  return { period, players, gaps, capturedAt: observation.capturedAt };
}

export interface OwnedPoolPlayer extends Omit<OwnedRosterPlayer, "assignment" | "slot" | "locked" | "editControlObserved"> {
  availability: "free_agent" | "waivers" | "unknown"; waiverDateText: string | null; addControlObserved: boolean;
}
export function readOwnedPool(observation: OwnedObservation, rules: OwnedRules, binding: OwnedBinding, now = new Date()) {
  validateOwnedObservation(observation, binding, now); route(observation, [leaguePath(binding) + "/players"]);
  const stats = one(observation.dom.controls.filter(c => c.tag === "select" && c.name === "stat1"), "missing_owned_pool_stats");
  const period = stats.value.match(/^S_PW_(\d+)$/)?.[1];
  if (!period || binding.period && binding.period !== period) fail("wrong_owned_pool_projection_period");
  const status = one(observation.dom.controls.filter(c => c.tag === "select" && c.name === "status"), "missing_owned_pool_scope").value;
  if (!["A", "FA", "W"].includes(status)) fail("unsupported_owned_pool_scope");
  const players: OwnedPoolPlayer[] = [];
  for (const table of observation.dom.tables.filter(t => t.headers.includes("Roster Status"))) {
    const headers = table.headers.map(h => clean(h).replace(/[\ue000-\uf8ff]/g, "")), statusIndex = headers.indexOf("Roster Status"), projectionIndex = headers.indexOf("Fan Pts"), byeIndex = headers.indexOf("Bye");
    if (projectionIndex < 0 || byeIndex < 0) fail("missing_owned_pool_projection_header");
    for (const row of table.rows) {
      const identity = playerIdentity(row), rawStatus = clean(row.cells[statusIndex] ?? ""), waiverDateText = rawStatus.match(/^W \(([^)]+)\)$/)?.[1] ?? null;
      const availability = rawStatus === "FA" ? "free_agent" as const : waiverDateText ? "waivers" as const : "unknown" as const;
      const projection = clean(row.cells[projectionIndex] ?? "");
      if (!/^-?\d+(?:\.\d+)?$/.test(projection)) fail("missing_owned_pool_projection");
      const addControls = row.links.filter(l => l.title === "Add Player" && urlOf(l.href).protocol === "https:" && urlOf(l.href).hostname === "football.fantasysports.yahoo.com" && urlOf(l.href).pathname === leaguePath(binding) + "/addplayer" && l.attributes["aria-disabled"] !== "true");
      const addControlObserved = addControls.length === 1 && urlOf(addControls[0]!.href).searchParams.get("apid") === identity.id;
      const gameText = identity.cell.split("\n").find(l => /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Final |Q[1-4] |Bye)/.test(l))?.replace(/[\ue000-\uf8ff]/g, "").trim() ?? "";
      const suffix = identity.cell.slice(identity.name.length).split("\n")[0]!;
      const injuryLabel = suffix.match(/^(IR|PUP|SUSP|NA|Q|O|D)(?=Video|Player|New|No|$)/)?.[1] ?? null;
      const bye = Number(clean(row.cells[byeIndex] ?? ""));
      if (!Number.isInteger(bye) || bye < 1 || bye > 18) fail("missing_owned_pool_bye");
      const eligible = [...identity.positions, ...rules.slots.map(s => s.position).filter(p => p === "W/R/T" && identity.positions.some(x => ["RB", "WR", "TE"].includes(x)))].filter((p, i, a) => a.indexOf(p) === i);
      players.push({ ...identity, eligible, projectedPoints: Number(projection), injuryLabel, gameText, ...gameSchedule(row, gameText, observation.dom.text.match(/All game times are shown in (EDT|EST)\./)?.[1] ?? "unknown"),
        bye, availability, waiverDateText, addControlObserved, newsLink: row.links.find(l => /^(?:Player Note|New Player Note|No new player Notes)$/.test(l.text))?.href ?? null });
    }
  }
  const explicitEmpty = /\bNo players (?:found|available|match(?:ed)? your search)\b/i.test(observation.dom.text);
  if (!players.length && !explicitEmpty) fail("owned_pool_unobserved");
  if (new Set(players.map(p => p.id)).size !== players.length) fail("duplicate_owned_pool_player");
  return { period: period!, status, coverage: "observed_page_only" as const, players, empty: players.length === 0, capturedAt: observation.capturedAt };
}
export function readOwnedDrops(observation: OwnedObservation, binding: OwnedBinding, now = new Date()) {
  validateOwnedObservation(observation, binding, now); route(observation, [teamPath(binding) + "/dropplayer"]);
  if (!observation.dom.text.includes("Select a player to drop")) fail("owned_drop_table_unobserved");
  const players = observation.dom.tables.filter(t => t.headers.includes("Drop")).flatMap(t => t.rows).map(row => {
    const p = playerIdentity(row);
    const controls = row.controls.filter(c => c.attributes.title === "Click to drop this player");
    const control = controls.length === 1 ? controls[0] : undefined;
    const controlId = control?.attributes["data-check-box-value"]?.trim();
    if (controlId && controlId !== p.id) fail("owned_drop_identity_conflict");
    const state = control && !control.disabled && control.attributes["aria-disabled"] !== "true" && controlId === p.id ? "offered" as const : (control?.disabled || control?.attributes["aria-disabled"] === "true") ? "prohibited" as const : "unknown" as const;
    return { id: p.id, name: p.name, state };
  });
  if (!players.length || new Set(players.map(p => p.id)).size !== players.length) fail("owned_drops_unobserved");
  return { players, capturedAt: observation.capturedAt };
}
export function readOwnedTransactions(observation: OwnedObservation, binding: OwnedBinding, now = new Date()) {
  validateOwnedObservation(observation, binding, now); route(observation, [leaguePath(binding) + "/transactions", teamPath(binding) + "/transactions"]);
  if (!observation.dom.headings.some(h => /^(?:Recent )?Transactions$/.test(h))) fail("owned_transactions_unobserved");
  const start = observation.dom.text.indexOf("Transactions"), text = observation.dom.text.slice(start, start + 15000);
  return { status: /\bNo recent transactions\b/i.test(text) ? "explicitly_empty" as const : "observed_feed" as const,
    tables: observation.dom.tables.map(t => ({ headers: t.headers, rows: t.rows.map(r => r.cells) })),
    pendingClaims: "unobserved" as const, capturedAt: observation.capturedAt };
}
export interface OwnedPendingClaims { status: "observed" | "explicitly_empty" | "unobserved"; claims: Array<{ id: string; addId: string; dropId: string | null }>; capturedAt: string; reason: string | null }
/** No guessed route: caller supplies a previously observed exact queue route. Transactions never count as pending claims. */
export function readOwnedPendingClaims(observation: OwnedObservation, binding: OwnedBinding, expectedQueueUrl: string, now = new Date(), details: readonly OwnedObservation[] = []): OwnedPendingClaims {
  validateOwnedObservation(observation, binding, now);
  const expected = urlOf(expectedQueueUrl), current = urlOf(observation.url);
  if (expected.hostname !== "football.fantasysports.yahoo.com" || current.origin + current.pathname + current.search !== expected.origin + expected.pathname + expected.search || /transactions/.test(current.pathname)) fail("wrong_owned_pending_claims_route");
  const headings = observation.dom.headings.filter(h => /^(?:Pending (?:Waiver )?Claims|Waiver Claims|Pending Transactions)$/i.test(h));
  const unknown = (reason: string): OwnedPendingClaims => ({ status: "unobserved", claims: [], capturedAt: observation.capturedAt, reason });
  const queueLinks = observation.dom.links.filter(l => new URL(l.href).pathname === teamPath(binding) + "/viewwaiver");
  // The observed current My Team template uses a plain-text section title, not
  // a heading. Its claim_id links lead to read-only details with actual numeric
  // Add/Drop rows and cancellation form. Priority values are never claim IDs.
  if (queueLinks.length) {
    if (observation.dom.readyState !== "complete" || current.pathname !== teamPath(binding) ||
        !observation.dom.text.split("\n").some(line => line.trim() === "Pending Transactions") || !binding.period ||
        !observation.dom.tables.some(t => t.caption === `${binding.teamName}'s Offense roster for week ${binding.period}.`) ||
        details.length !== queueLinks.length || observation.dom.pendingTransactionCount !== queueLinks.length || !observation.dom.pendingTransactionLinks ||
        digest(observation.dom.pendingTransactionLinks.map(l => l.href).sort()) !== digest(queueLinks.map(l => l.href).sort())) return unknown("pending_claim_detail_coverage_missing");
    const claims: OwnedPendingClaims["claims"] = [];
    for (const link of queueLinks) {
      const url = new URL(link.href), id = url.searchParams.get("claim_id");
      if (url.origin !== current.origin || url.searchParams.getAll("claim_id").length !== 1 || !id || !/^\d+_\d+_\d+$/.test(id)) return unknown("pending_claim_identity_unobserved");
      const matched = details.filter(d => { const u = new URL(d.url); return u.origin === url.origin && u.pathname === url.pathname && u.searchParams.getAll("claim_id").length === 1 && u.searchParams.get("claim_id") === id; });
      if (matched.length !== 1) return unknown("pending_claim_detail_coverage_missing");
      const detail = matched[0]!; validateOwnedObservation(detail, binding, now);
      if (detail.dom.readyState !== "complete" || !detail.dom.headings.includes("Cancel Waiver") ||
          !detail.dom.text.includes(`If successful, this waiver claim will be reflected in your lineup for Week ${binding.period} on `)) return unknown("pending_claim_detail_incomplete");
      const player = (label: string) => {
        const tables = detail.dom.tables.filter(t => t.headers[0] === label);
        return tables.length === 1 && tables[0]!.rows.length === 1 ? playerIdentity(tables[0]!.rows[0]!) : null;
      };
      const add = player("Add"), drop = player("Drop");
      if (!add || !drop || add.id === drop.id || id.split("_").slice(1).join("_") !== `${add.id}_${drop.id}` ||
          !link.text.includes(`: Add ${add.name}, Drop ${drop.name}`)) return unknown("pending_claim_players_conflict");
      const forms = detail.dom.forms.filter(f => f.method === "post" && new URL(f.action).origin === current.origin && new URL(f.action).pathname === teamPath(binding) + "/editwaiver");
      if (forms.length !== 1 || !forms[0]!.controls.some(c => c.type === "submit" && c.name === "s" && c.value === "Cancel Waiver" && !c.disabled)) return unknown("pending_claim_cancel_contract_missing");
      if ([["stage", "2"], ["apid", add.id], ["dpid", drop.id]].some(([name, value]) => {
        const fields = forms[0]!.numericFields?.filter(f => f.name === name); return fields?.length !== 1 || fields[0]!.value !== value;
      })) return unknown("pending_claim_form_identity_conflict");
      claims.push({ id, addId: add.id, dropId: drop.id });
    }
    if (new Set(claims.map(c => c.id)).size !== claims.length) return unknown("duplicate_pending_claim_identity");
    return { status: "observed", claims, capturedAt: observation.capturedAt, reason: null };
  }
  if (!headings.length) return unknown("pending_claims_heading_unobserved");
  if (/\b(?:You (?:have|do) not have any|You have no|No) pending (?:waiver )?claims\b/i.test(observation.dom.text)) return { status: "explicitly_empty", claims: [], capturedAt: observation.capturedAt, reason: null };
  // Populated queues need a proven claim-id/add/drop schema, not guessed semantics.
  return { status: "unobserved", claims: [], capturedAt: observation.capturedAt, reason: "populated_pending_claims_schema_unobserved" };
}
export interface OwnedPlayerDetails { playerId: string; news: { status: "observed_excerpt" | "none_in_last_10_days"; text: string; publicationDatesResolved: false }; games: Array<{ period: string; opponent: string; statusText: string; projectedPoints: number | null }>; capturedAt: string }
export function readOwnedPlayerDetails(observation: OwnedObservation, binding: OwnedBinding, playerId: string, playerName: string, now = new Date()): OwnedPlayerDetails {
  validateOwnedObservation(observation, binding, now);
  const selected = observation.dom.links.filter(l => /(?:^|\s)player-name(?:\s|$)/.test(l.attributes.class ?? ""));
  const modalPlayer = one(selected, "owned_selected_player_unobserved");
  const rosterIdentity = observation.dom.links.filter(l => l.text === playerName && l.attributes["data-ys-playerid"] === playerId);
  if (modalPlayer.text !== playerName || !rosterIdentity.some(l => l.href === modalPlayer.href)) fail("wrong_owned_selected_player");
  const seasonHeadings = observation.dom.headings.filter(h => /^\d{4} Season Game Log$/.test(h));
  if (seasonHeadings.length !== 1 || binding.season && seasonHeadings[0] !== `${binding.season} Season Game Log`) fail("wrong_owned_game_log_season");
  if (binding.period) {
    const path = urlOf(observation.url).pathname;
    if (path === leaguePath(binding) + "/players") {
      const stats = observation.dom.controls.filter(c => c.tag === "select" && c.name === "stat1" && !c.disabled);
      if (stats.length !== 1 || stats[0]!.value !== `S_PW_${binding.period}` ||
        !stats[0]!.options.some(o => o.value === stats[0]!.value && o.selected && !o.disabled)) fail("wrong_owned_detail_period");
    } else if (path !== teamPath(binding) || !observation.dom.tables.some(t => t.caption === `${binding.teamName}'s Offense roster for week ${binding.period}.`)) fail("wrong_owned_detail_period");
  }
  const heading = observation.dom.headings.some(h => h === "Latest News");
  const table = observation.dom.tables.find(t => t.headers[0] === "Week" && t.headers[1] === "Opp" && t.headers.includes("Proj"));
  if (!heading || !table) fail("owned_player_details_unobserved");
  const newsStart = observation.dom.text.lastIndexOf("Latest News"), news = observation.dom.text.slice(newsStart + "Latest News".length).trim();
  const emptyText = `There are no news updates for ${playerName} in the last 10 days.`;
  const explicitlyEmpty = news.includes(emptyText);
  if (!explicitlyEmpty && !/\b(?:Analysis|Advice|Source|Rotowire|RotoWire)\b/.test(news)) fail("owned_player_news_unobserved");
  const games = table!.rows.map(row => {
    const period = clean(row.cells[0] ?? ""), opponent = clean(row.cells[1] ?? ""), statusText = clean(row.cells[2] ?? ""), raw = clean(row.cells[table!.headers.indexOf("Proj")] ?? "");
    if (!/^\d+$/.test(period) || !opponent || !statusText || !/^(?:-|\d+(?:\.\d+)?)$/.test(raw)) fail("invalid_owned_game_log");
    return { period, opponent, statusText, projectedPoints: raw === "-" ? null : Number(raw) };
  });
  if (!games.length || new Set(games.map(g => g.period)).size !== games.length) fail("incomplete_owned_game_log");
  return { playerId, news: { status: explicitlyEmpty ? "none_in_last_10_days" : "observed_excerpt", text: explicitlyEmpty ? emptyText : news.slice(0, 12000), publicationDatesResolved: false }, games, capturedAt: observation.capturedAt };
}

export interface OwnedAssessmentInput {
  roster: OwnedObservation; rules: OwnedObservation; pools?: OwnedObservation[]; drops?: OwnedObservation;
  playerDetails?: Array<{ playerId: string; playerName: string; observation: OwnedObservation }>;
  transactions?: OwnedObservation; pendingClaims?: { observation: OwnedObservation; expectedQueueUrl: string };
  /** Host-owned parser output. Null is unknown, never an empty queue. */
  pendingClaimsEvidence?: OwnedClaimsEvidence | null;
}
export interface OwnedAssessment {
  snapshot: SeasonSnapshot | null; sources: ManagerSource[]; gaps: string[];
  readiness: Record<ManagerPhase, boolean>; lineupDeadlines: Record<string, string>; acquisitionDeadlines: Record<string, string>;
  roster: OwnedRoster | null;
}
function normalizedStatus(label: string | null): Player["status"] {
  if (label === null) return "active";
  if (label === "Q") return "questionable";
  // Requires the explicit domain extension in the integrating release. Never mislabel D as out.
  if (label === "D") return "doubtful" as Player["status"];
  if (label === "O") return "out";
  if (["IR", "PUP"].includes(label)) return "injured_reserve";
  if (label === "NA") return "not_active";
  return fail("unsupported_owned_player_status");
}
/** Incomplete evidence yields explicit gaps. A partial snapshot does not imply manager readiness. */
export function normalizeOwnedAssessment(input: OwnedAssessmentInput, binding: OwnedBinding, phase: ManagerPhase, now = new Date()): OwnedAssessment {
  const result: OwnedAssessment = { snapshot: null, sources: [], gaps: [], readiness: { lineup: false, free_agents: false, waivers: false }, lineupDeadlines: {}, acquisitionDeadlines: {}, roster: null };
  const take = <T>(label: string, read: () => T): T | null => { try { return read(); } catch (e) { result.gaps.push(`${label}:${e instanceof Error ? e.message : "invalid_source"}`); return null; } };
  const rules = take("rules", () => readOwnedRules(input.rules, binding, now));
  if (!rules) return result;
  const roster = take("roster", () => readOwnedRoster(input.roster, rules, binding, now));
  if (!roster) return result;
  result.roster = roster; result.gaps.push(...roster.gaps);
  const phaseBinding = { ...binding, period: roster.period };
  const source = (kind: SourceKind, observation: OwnedObservation, playerIds: string[], facts: unknown): void => {
    const content = { evidenceType: "owned_browser_dom", observationId: observation.observationId, facts };
    result.sources.push({ id: `owned:${kind}:${digest({ observation: observation.observationId, playerIds }).slice(0, 20)}`, kind,
      reference: observation.url, capturedAt: observation.capturedAt, leagueId: binding.leagueId, teamId: binding.teamId,
      period: roster.period, playerIds, content, contentHash: digest(content) });
  };
  const rosterIds = roster.players.map(p => p.id);
  if (rules.scoring.length) source("rules", input.rules, [], rules);
  else result.gaps.push("scoring_rules_unobserved");
  source("roster", input.roster, rosterIds, roster.players);
  const pools = phase === "lineup" ? [] : (input.pools ?? []).map(o => ({ observation: o, pool: take("pool", () => readOwnedPool(o, rules, phaseBinding, now)) })).filter(x => x.pool !== null);
  const available = pools.flatMap(x => x.pool!.players), assessed = [...roster.players, ...available];
  const ids = assessed.map(p => p.id);
  if (new Set(ids).size !== ids.length) result.gaps.push("duplicate_assessed_player");
  const emitPlayerFacts = (observation: OwnedObservation, players: Array<OwnedRosterPlayer | OwnedPoolPlayer>) => {
    source("projections", observation, players.map(p => p.id), players.map(p => ({ id: p.id, period: roster.period, projectedPoints: p.projectedPoints })));
    const dated = players.filter(p => p.kickoff && p.scheduleReference);
    if (dated.length) source("schedule", observation, dated.map(p => p.id), dated.map(p => ({ id: p.id, kickoff: p.kickoff, reference: p.scheduleReference, gameText: p.gameText })));
    const deadline = (p: OwnedPoolPlayer) => ownedAcquisitionDeadline(p, rules, binding.season ?? Number.NaN, now);
    const locked = players.filter(p => "locked" in p ? p.locked !== null : deadline(p) !== null);
    if (locked.length) source("locks", observation, locked.map(p => p.id), locked.map(p => ({ id: p.id, locked: "locked" in p ? p.locked : false,
      evidence: "locked" in p ? "observed_lineup_control" : p.availability === "waivers" ? "observed_add_control_and_conservative_weekly_cutoff" : "observed_add_control_and_future_game",
      ...("locked" in p ? {} : { acquisitionDeadline: deadline(p), ...(p.availability === "waivers" ? { deadlineInterpretation: "conservative_submission_cutoff_not_processing_time", waiverDateText: p.waiverDateText, weeklyWaivers: rules.weeklyWaivers,
        ruleReference: "https://help.yahoo.com/kb/sports/customize-weekly-waivers-settings-sln8825.html" } : {}) }) })));
    for (const p of players) {
      if (!p.kickoff) result.gaps.push(`dated_schedule_unobserved:${p.id}`);
      else if ("locked" in p) result.lineupDeadlines[p.id] = p.kickoff;
      else { const cutoff = deadline(p); if (cutoff) result.acquisitionDeadlines[p.id] = cutoff; }
    }
  };
  emitPlayerFacts(input.roster, roster.players);
  for (const entry of pools) { source("pool", entry.observation, entry.pool!.players.map(p => p.id), entry.pool); emitPlayerFacts(entry.observation, entry.pool!.players); }
  const drops = input.drops ? take("drops", () => readOwnedDrops(input.drops!, phaseBinding, now)) : null;
  if (drops && input.drops) source("drops", input.drops, drops.players.filter(p => rosterIds.includes(p.id)).map(p => p.id), drops);
  for (const player of roster.players) {
    if (drops?.players.some(d => d.id === player.id && d.state === "offered") && player.kickoff && Date.parse(player.kickoff) > now.getTime()) result.acquisitionDeadlines[player.id] = player.kickoff;
  }
  for (const detail of input.playerDetails ?? []) {
    if (!ids.includes(detail.playerId)) { result.gaps.push(`details_unknown_player:${detail.playerId}`); continue; }
    const parsed = take(`details:${detail.playerId}`, () => readOwnedPlayerDetails(detail.observation, phaseBinding, detail.playerId, detail.playerName, now));
    if (!parsed) continue;
    source("news", detail.observation, [detail.playerId], parsed.news);
    const future = parsed.games.filter(g => Number(g.period) > Number(roster.period));
    if (future.length >= 2) source("horizon", detail.observation, [detail.playerId], { scope: "observed_game_log", games: future });
  }
  if (input.transactions) { const parsed = take("transactions", () => readOwnedTransactions(input.transactions!, phaseBinding, now)); if (parsed) source("transactions", input.transactions, [], parsed); }
  if (input.pendingClaimsEvidence) {
    const evidence = input.pendingClaimsEvidence;
    const parsed = take("pending_claims", () => {
      validateOwnedObservation(evidence.observation, phaseBinding, now);
      const url = urlOf(evidence.observation.url);
      if (!evidence.normalized || evidence.sourceHash !== digest(evidence.observation) ||
        !(url.pathname === teamPath(binding) || url.pathname.startsWith(teamPath(binding) + "/")) || /transactions/.test(url.pathname) ||
        !Array.isArray(evidence.claims) || evidence.claims.some(c => !c.id || c.leagueId !== binding.leagueId || c.teamId !== binding.teamId ||
          c.period !== roster.period || !/^\d+$/.test(c.addId) || !/^\d+$/.test(c.dropId) || c.addId === c.dropId) || new Set(evidence.claims.map(c => c.id)).size !== evidence.claims.length) fail("invalid_owned_claims_evidence");
      return { status: evidence.claims.length ? "observed_claims" : evidence.interpretation ?? "host_normalized_empty", claims: evidence.claims,
        supportingDocumentIds: evidence.supportingDocumentIds ?? [], sourceHash: evidence.sourceHash };
    });
    if (parsed) source("pending_claims", evidence.observation, [], parsed);
  } else if (input.pendingClaims) {
    const parsed = take("pending_claims", () => readOwnedPendingClaims(input.pendingClaims!.observation, phaseBinding, input.pendingClaims!.expectedQueueUrl, now));
    if (parsed?.status === "unobserved") result.gaps.push(`pending_claims:${parsed.reason}`);
    else if (parsed) source("pending_claims", input.pendingClaims.observation, [], parsed);
  }
  const convert = (p: OwnedRosterPlayer | OwnedPoolPlayer): Player => {
    const drop = drops?.players.find(d => d.id === p.id), owned = "slot" in p;
    if (owned && p.locked === null) fail("unobserved_owned_lineup_lock");
    if (!owned && (p.availability === "unknown" || !p.addControlObserved)) fail("unobserved_owned_acquisition_control");
    return { id: p.id, eligible: p.eligible, slot: owned ? p.slot : null, projectedPoints: p.projectedPoints, status: normalizedStatus(p.injuryLabel),
      locked: owned ? p.locked! : false, ...(drop?.state === "offered" ? { dropLocked: false } : {}),
      canDrop: owned && drop?.state === "offered", availability: owned ? "rostered" : p.availability as "free_agent" | "waivers" };
  };
  const snapshot = take("snapshot", () => {
    const allTimes = [input.roster.capturedAt, input.rules.capturedAt, ...pools.map(p => p.observation.capturedAt), ...(input.drops ? [input.drops.capturedAt] : [])];
    const s: SeasonSnapshot = { schemaVersion: 1, leagueId: binding.leagueId, teamId: binding.teamId, period: roster.period,
      capturedAt: allTimes.sort((a, b) => Date.parse(a) - Date.parse(b))[0]!, hash: "", roster: roster.players.map(convert), available: available.map(convert),
      slots: rules.slots, rosterLimit: rules.rosterLimit, waiverType: rules.waiverType };
    s.hash = snapshotHash(s); return validateSnapshot(s, binding, now);
  });
  result.snapshot = snapshot;
  const has = (kind: SourceKind, id?: string) => result.sources.some(s => s.kind === kind && (id === undefined || s.playerIds.includes(id)));
  for (const kind of ["news", "schedule", "locks", "projections"] as const) for (const p of assessed) if (!has(kind, p.id)) result.gaps.push(`${kind}_unobserved:${p.id}`);
  const lineup = !!snapshot && has("rules") && !roster.gaps.length && rosterIds.every(id => ["news", "schedule", "locks", "projections"].every(kind => has(kind as SourceKind, id)));
  result.readiness.lineup = lineup;
  if (phase !== "lineup") {
    for (const kind of ["pool", "drops", "pending_claims", "horizon", "transactions"] as const) if (!has(kind)) result.gaps.push(`${kind}_unobserved`);
    for (const p of assessed) if (!has("horizon", p.id)) result.gaps.push(`horizon_unobserved:${p.id}`);
    for (const p of roster.players) if (!drops?.players.some(d => d.id === p.id && d.state !== "unknown")) result.gaps.push(`drop_control_unobserved:${p.id}`);
    for (const p of available) if (!result.acquisitionDeadlines[p.id]) result.gaps.push(`${p.availability === "waivers" ? "waiver_submission_deadline_unobserved" : "acquisition_deadline_unobserved"}:${p.id}`);
    for (const p of roster.players) if (drops?.players.some(d => d.id === p.id && d.state === "offered") && !result.acquisitionDeadlines[p.id]) result.gaps.push(`drop_deadline_unobserved:${p.id}`);
    result.readiness[phase] = lineup && result.gaps.length === 0;
  }
  result.gaps = [...new Set(result.gaps)];
  return result;
}
