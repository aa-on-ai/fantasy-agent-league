import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { digest, validateDecision, validateSnapshot, type Binding } from "../../manager/season.js";
import { actionFingerprint } from "../../execution/coordinator.js";
import { readStop } from "../../runtime/native-read-proof.js";
import { assertOwnedLineupAuthorization, type OwnedLineupReleaseGrant } from "../../runtime/owned-lineup-release.js";
import { assertOwnedAcquisitionAuthorization, assertOwnedAcquisitionClaims, type OwnedAcquisitionReleaseGrant } from "../../runtime/owned-acquisition-release.js";
import { captureOwnedObservation, type OwnedControl, type OwnedObservation, type OwnedRow } from "./owned-sources.js";
import { assertOwnedIdentity, type OwnedAction, type OwnedActionReadback, type OwnedClaimsEvidence, type OwnedState, type OwnedTransport, type PreparedOwnedAction } from "./guarded-owned.js";

const origin = "https://football.fantasysports.yahoo.com";
export const OWNED_BROWSER_PROFILE = join(homedir(), ".local/share/fantasy-agent-league/2026/agent-1/browser");
const fail = (code: string): never => { throw new Error(code); };
const one = <T>(values: T[], code: string): T => values.length === 1 ? values[0]! : fail(code);
const clean = (value: string) => value.replaceAll("\u00a0", " ").trim();
export async function assertOwnedBrowserProfile(path: string): Promise<void> {
  let info;
  try { info = await lstat(path); } catch { return fail("browser_profile_missing_or_unavailable"); }
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || await realpath(path) !== resolve(path)) fail("unsafe_browser_profile");
}
export interface OwnedBrowserOptions {
  profilePath: string;
  checkProfile?: (path: string) => Promise<void>;
  launch?: (path: string) => Promise<BrowserContext>;
}
/** Own only the context launched by this call. Never attach, clone auth, remove a lock, or kill a browser. */
export async function withOwnedBrowser<T>(options: OwnedBrowserOptions, run: (page: Page) => Promise<T>): Promise<T> {
  await (options.checkProfile ?? assertOwnedBrowserProfile)(options.profilePath);
  let context: BrowserContext | undefined;
  try {
    context = await (options.launch ?? (path => {
      if (resolve(path) !== resolve(OWNED_BROWSER_PROFILE)) return fail("unowned_browser_profile");
      return chromium.launchPersistentContext(path, {
        channel: "chrome", headless: true, chromiumSandbox: true, acceptDownloads: false, serviceWorkers: "block", timeout: 10000
      });
    }))(options.profilePath);
    const page = await context.newPage();
    await page.route("**/*", route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() &&
        ![origin, "https://login.yahoo.com"].includes(new URL(request.url()).origin)) return route.abort();
      return route.continue();
    });
    return await run(page);
  } finally { if (context) { try { await context.close(); } catch { fail("browser_cleanup_failed"); } } }
}
/** Dismiss only the observed optional email prompt. Never choose or submit an address. */
export async function dismissOwnedOptionalPrompt(page: Page): Promise<void> {
  const title = page.getByText("Choose your preferred email", {exact:true});
  if (await title.isVisible()) {
    const later = page.getByRole("button", {name:"Later",exact:true});
    if (await later.count() !== 1) fail("ambiguous_optional_prompt");
    await later.click({timeout:5000});
    await title.waitFor({state:"hidden",timeout:5000});
  }
}
export interface OwnedDriverOptions {
  binding: Binding;
  profileId: string;
  emergencyStopPath: string;
  allowSubmission: boolean;
  lineupRelease?: OwnedLineupReleaseGrant;
  acquisitionRelease?: OwnedAcquisitionReleaseGrant;
  normalize(observation: OwnedObservation): Promise<OwnedState>;
  record(observation: OwnedObservation): Promise<void>;
  collectPendingClaims?: () => Promise<OwnedClaimsEvidence>;
  // Observed filtered candidate pages from this assessment, not constructed
  // addplayer URLs. The live page/control is independently read again.
  getAcquisitionPoolSources?: () => readonly OwnedObservation[];
  // Evidence references must refer to observed atomic Yahoo operations. Neither
  // a unit-test fixture nor a write flag qualifies as that proof.
  atomicSwapEvidence: string | null;
  atomicAcquisitionEvidence: string | null;
  // Exact observed selected-source and enabled-target class tokens. Null blocks
  // lineup preparation until the live selection-state capture is inspected.
  swapSelection: { sourceClass: string; targetClass: string } | null;
  clock?: () => Date;
}
function playerId(row: OwnedRow): string | null {
  const ids = row.links.flatMap(link => {
    const byAttribute = link.attributes["data-ys-playerid"];
    const byUrl = new URL(link.href).pathname.match(/^\/nfl\/players\/(\d+)\/?$/)?.[1];
    return [byAttribute, byUrl].filter((id): id is string => !!id && /^\d+$/.test(id));
  });
  const distinct = [...new Set(ids)];
  if (distinct.length > 1) fail("conflicting_numeric_player_identity");
  return distinct[0] ?? null;
}
function playerRows(observation: OwnedObservation): Array<{ id: string; row: OwnedRow }> {
  const rows = observation.dom.tables.flatMap(t => t.rows).map(row => ({ id: playerId(row), row })).filter((r): r is { id: string; row: OwnedRow } => r.id !== null);
  if (new Set(rows.map(r => r.id)).size !== rows.length) fail("duplicate_player_rows");
  return rows;
}
interface TargetControl { tag: string; name: string; type: string; text: string; value: string; ariaLabel: string; rowId: string | null }
function targetControl(control: OwnedControl, rowId: string | null): TargetControl {
  if (control.disabled) fail("disabled_owned_control");
  return { tag: control.tag, name: control.name, type: control.type, text: clean(control.text), value: control.value, ariaLabel: control.attributes["aria-label"] ?? "", rowId };
}
interface RowWitness { id: string; position: string; className: string; swapGroups: string; swapTargets: string }
interface GestureWitness {
  url: string; teamPath: string; period: string;
  rows: RowWitness[];
  target: TargetControl;
  heading: string | null;
  confirmation: { addId: string; dropId: string; label: string; effectiveText: string } | null;
  expiresAt: number;
  dropSelection: { addId: string; dropId: string; heading: string } | null;
}
function witness(observation: OwnedObservation, binding: Binding, period: string, target: TargetControl,
  confirmation: GestureWitness["confirmation"] = null, heading: string | null = null): GestureWitness {
  return { url: observation.url, teamPath: `/f1/${binding.leagueId}/${binding.teamId}`, period,
    rows: playerRows(observation).map(({ id, row }) => ({ id, position: row.attributes["data-pos"] ?? "", className: row.attributes.class ?? "",
      swapGroups: row.attributes["data-swap-groups"] ?? "", swapTargets: row.attributes["data-swap-targets"] ?? "" })),
    target, heading, confirmation, dropSelection: null, expiresAt: Date.parse(observation.capturedAt) + Math.min(binding.maxAgeMs, 60000) };
}
// This entire function executes synchronously in the owned Page. It verifies the
// current DOM and dispatches at most one DOM click in the same browser task.
// Playwright retries/actionability waiting are deliberately not used for commit.
export function atomicOwnedGesture(expected: GestureWitness): void {
  const fail = () => { throw new Error("owned_controls_changed_before_gesture"); };
  const clean = (value: string) => value.replaceAll("\u00a0", " ").trim();
  const text = (e: Element) => clean((e as HTMLElement).innerText?.trim() ?? e.textContent?.trim() ?? "");
  if (Date.now() >= expected.expiresAt || location.href !== expected.url || location.origin !== "https://football.fantasysports.yahoo.com") fail();
  const owners = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].filter(a => text(a) === "My Team");
  if (!owners.length || owners.some(a => new URL(a.href).origin !== location.origin || new URL(a.href).pathname !== expected.teamPath)) fail();
  const rows = [...document.querySelectorAll("table tbody tr")].filter(row => (row as HTMLElement).getClientRects().length > 0).flatMap(row => {
    const ids = [...new Set([...row.querySelectorAll<HTMLAnchorElement>("a[href]")].flatMap(a => [a.getAttribute("data-ys-playerid"), new URL(a.href).pathname.match(/^\/nfl\/players\/(\d+)\/?$/)?.[1]]).filter((id): id is string => !!id && /^\d+$/.test(id)))];
    if (ids.length > 1) fail();
    return ids.length ? [{ element: row, id: ids[0]!, position: row.getAttribute("data-pos") ?? "", className: row.getAttribute("class") ?? "",
      swapGroups: row.getAttribute("data-swap-groups") ?? "", swapTargets: row.getAttribute("data-swap-targets") ?? "" }] : [];
  });
  if (JSON.stringify(rows.map(({ element: _e, ...row }) => row)) !== JSON.stringify(expected.rows)) fail();
  const scope = expected.target.rowId ? rows.find(r => r.id === expected.target.rowId)?.element : document;
  if (!scope) return fail();
  const matches = [...scope.querySelectorAll('button,select,input:not([type="hidden"]):not([type="password"]),[role="button"],[role="option"]')].filter(e => {
    const c = e as HTMLInputElement;
    return e.tagName.toLowerCase() === expected.target.tag && (c.name ?? "") === expected.target.name && (c.type ?? "") === expected.target.type &&
      text(e) === expected.target.text && (c.value ?? "") === expected.target.value && (e.getAttribute("aria-label") ?? "") === expected.target.ariaLabel;
  });
  if (matches.length !== 1) return fail();
  const target = matches[0] as HTMLElement & { disabled?: boolean };
  if (target.disabled || target.getAttribute("aria-disabled") === "true" || !target.getClientRects().length || getComputedStyle(target).visibility === "hidden") fail();
  if (expected.dropSelection) {
    const { addId, dropId, heading } = expected.dropSelection;
    const url = new URL(location.href);
    if (url.searchParams.getAll("apid").length !== 1 || url.searchParams.get("apid") !== addId ||
      ![...document.querySelectorAll("h1,h2,h3,h4,[role=heading]")].some(e => text(e) === heading) ||
      target.tagName !== "BUTTON" || (target as HTMLButtonElement).type !== "button" ||
      target.getAttribute("title") !== "Click to drop this player" || target.getAttribute("data-check-box-value")?.trim() !== dropId) fail();
  } else if (!expected.confirmation) {
    const captions = [...document.querySelectorAll("table caption")].map(text).map(c => c.match(/roster for week (\d+)\./i)?.[1]).filter(Boolean);
    if (!captions.length || captions.some(p => p !== expected.period)) fail();
  } else {
    if (![...document.querySelectorAll("h1,h2,h3,h4,[role=heading]")].some(e => text(e) === expected.heading)) fail();
    const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].filter(a => text(a) === "Stats").map(a => new URL(a.href));
    const stages = links.filter(u => u.origin === location.origin && u.pathname === expected.teamPath + "/addplayer" && u.searchParams.get("stage") === "2");
    if (stages.length !== 1 || ["stage", "apid", "dpid"].some(key => stages[0]!.searchParams.getAll(key).length !== 1) ||
      stages[0]!.searchParams.get("apid") !== expected.confirmation.addId || stages[0]!.searchParams.get("dpid") !== expected.confirmation.dropId ||
      (target.tagName === "INPUT" ? (target as HTMLInputElement).value : text(target)) !== expected.confirmation.label || !clean(document.body.innerText).includes(expected.confirmation.effectiveText)) fail();
    const form = (target as HTMLInputElement | HTMLButtonElement).form;
    if (!form || form.method.toLowerCase() !== "post" || new URL(form.action).origin !== location.origin || new URL(form.action).pathname !== expected.teamPath + "/addplayer" ||
      (target.hasAttribute("formmethod") && target.getAttribute("formmethod")?.toLowerCase() !== "post") ||
      (target.hasAttribute("formaction") && new URL(target.getAttribute("formaction")!, location.href).href !== form.action)) return fail();
    for (const [key, value] of [["stage", "3"], ["apid", expected.confirmation.addId], ["dpid", expected.confirmation.dropId]]) {
      const fields = [...form.querySelectorAll<HTMLInputElement>(`input[name="${key}"]`)];
      if (fields.length !== 1 || fields[0]!.disabled || fields[0]!.value.trim() !== value) fail();
    }
  }
  target.click();
}
export interface OwnedConfirmation {
  target: TargetControl;
  heading: string;
  addId: string; dropId: string; label: string; period: string; effectiveText: string;
}
export function parseOwnedAcquisitionConfirmation(observation: OwnedObservation, binding: Binding,
  action: Extract<OwnedAction, { addId: string }>, period: string): OwnedConfirmation {
  const url = new URL(observation.url), teamPath = `/f1/${binding.leagueId}/${binding.teamId}`;
  if (url.origin !== origin || ![teamPath + "/addplayer", `/f1/${binding.leagueId}/addplayer`].includes(url.pathname) ||
    url.searchParams.getAll("apid").length !== 1 || url.searchParams.get("apid") !== action.addId) fail("wrong_confirmation_page");
  const heading = action.kind === "waiver_claim" ? "Claim Player From Waivers" : "Add Free Agent";
  if (!observation.dom.headings.includes(heading)) fail("unobserved_confirmation_kind");
  const rows = playerRows(observation);
  const add = one(rows.filter(r => r.id === action.addId), "wrong_confirmation_add"), drop = one(rows.filter(r => r.id === action.dropId), "wrong_confirmation_drop");
  const name = (r: typeof add) => one(r.row.links.filter(l =>
    new URL(l.href).pathname.replace(/\/$/, "") === `/nfl/players/${r.id}` ||
    (l.attributes["data-ys-playerid"] === r.id && !!l.attributes.class?.split(/\s+/).includes("name"))), "missing_confirmation_player_name").text;
  const label = `${action.kind === "waiver_claim" ? "Create claim to Add" : "Add"} ${name(add)}, Drop ${name(drop)}`;
  const control = one(observation.dom.controls.filter(c => clean(c.tag === "input" && c.type === "submit" ? c.value : c.text) === label && !c.disabled), "missing_exact_confirmation");
  const stages = observation.dom.links.filter(l => clean(l.text) === "Stats").map(l => new URL(l.href)).filter(u =>
    u.origin === origin && u.pathname === teamPath + "/addplayer" && u.searchParams.get("stage") === "2");
  const stage = one(stages, "missing_stage_two_identity");
  if (["stage", "apid", "dpid"].some(key => stage.searchParams.getAll(key).length !== 1) || stage.searchParams.get("apid") !== action.addId ||
    stage.searchParams.get("dpid") !== action.dropId || action.addId === action.dropId) fail("conflicting_confirmation_ids");
  const form = one(observation.dom.forms.filter(f => f.method === "post" && new URL(f.action).origin === origin && new URL(f.action).pathname === teamPath + "/addplayer" &&
    f.controls.some(c => digest(c) === digest(control))), "missing_exact_acquisition_form");
  const numeric = (form as typeof form & { numericFields?: Array<{ name: string; value: string }> }).numericFields;
  for (const [name, value] of [["stage", "3"], ["apid", action.addId], ["dpid", action.dropId]]) {
    const fields = numeric?.filter(f => f.name === name) ?? [];
    if (fields.length !== 1 || fields[0]!.value !== value) fail("unverified_submission_form_ids");
  }
  const term = action.kind === "waiver_claim" ? observation.dom.text.match(/If successful, this waiver claim will be reflected in your lineup for Week (\d+) on [^.]+\./) :
    observation.dom.text.match(/This transaction will be reflected in your lineup for Week (\d+)/);
  if (!term || term[1] !== period) return fail("acquisition_period_changed");
  return { target: targetControl(control, null), heading, addId: action.addId, dropId: action.dropId, label, period, effectiveText: term[0] };
}
export class YahooOwnedDriver implements OwnedTransport {
  private readonly clock: () => Date;
  private pending: { ticket: PreparedOwnedAction; ticketHash: string; action: OwnedAction; state: OwnedState; gesture: GestureWitness } | undefined;
  private consumed = new Set<PreparedOwnedAction>();
  constructor(private readonly page: Page, private readonly options: OwnedDriverOptions) { this.clock = options.clock ?? (() => new Date()); }
  private async stop() { if (await readStop(this.options.emergencyStopPath) !== "clear") fail("emergency_stop"); }
  private async observe(requireTeamPage = true): Promise<OwnedObservation> {
    await this.stop();
    // Yahoo can expose controls at DOMContentLoaded before their handlers are
    // ready. Wait for the document load, never a fixed sleep or a blind retry.
    await this.page.waitForLoadState("load", { timeout: 10000 });
    await dismissOwnedOptionalPrompt(this.page);
    const observation = await captureOwnedObservation(this.page, this.options.profileId, this.clock);
    assertOwnedIdentity(observation, { execution: { ...this.options.binding, writesEnabled: false, releaseSha: "", runningSha: "", verifiedCapabilities: [], policy: { allowedActions: [], tradesEnabled: false, windows: [] } }, profileId: this.options.profileId }, this.clock(), requireTeamPage);
    await this.options.record(observation);
    return observation;
  }
  private async normalize(observation: OwnedObservation): Promise<OwnedState> {
    const state = await this.options.normalize(observation);
    if (digest(state.observation) !== digest(observation)) fail("owned_capture_not_preserved");
    validateSnapshot(state.snapshot, this.options.binding, this.clock());
    return state;
  }
  private authority(action: OwnedAction, state: OwnedState): void {
    if (!this.options.allowSubmission) fail("real_team_writes_disabled");
    if (this.options.binding.leagueId === "425299") {
      const release = action.kind === "set_lineup" ? this.options.lineupRelease : this.options.acquisitionRelease;
      if (!release) fail("real_team_writes_disabled");
      const check = {leagueId:this.options.binding.leagueId, teamId:this.options.binding.teamId,
        profileId:this.options.profileId, releaseSha:release!.releaseSha, runningSha:release!.runningSha, snapshot:state.snapshot, action};
      if (action.kind === "set_lineup") assertOwnedLineupAuthorization(this.options.lineupRelease!.authorization, check, this.clock());
      else {
        assertOwnedAcquisitionAuthorization(this.options.acquisitionRelease!.authorization, check, this.clock());
        assertOwnedAcquisitionClaims(state, action, {...this.options.binding, profileId: this.options.profileId}, this.clock());
      }
    }
  }
  async read(): Promise<OwnedState> {
    await this.stop();
    const url = origin + `/f1/${this.options.binding.leagueId}/${this.options.binding.teamId}`;
    const response = await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
    if (response && response.status() >= 400) fail("owned_team_read_failed");
    const observation = await this.observe();
    return this.normalize(observation);
  }
  async prepare(action: OwnedAction, state: OwnedState): Promise<PreparedOwnedAction> {
    this.pending = undefined;
    await this.stop();
    this.authority(action, state);
    validateSnapshot(state.snapshot, this.options.binding, this.clock());
    if (validateDecision(state.snapshot, action).length) fail("invalid_owned_action");
    let observation = await this.observe(), gesture: GestureWitness;
    const current = await this.normalize(observation);
    const comparable = ({ capturedAt: _time, hash: _hash, ...s }: OwnedState["snapshot"]) => digest(s);
    if (comparable(current.snapshot) !== comparable(state.snapshot)) fail("state_changed_replan_required");
    this.authority(action, current);
    if (action.kind === "set_lineup") {
      const selection = this.options.swapSelection;
      if (!selection || !this.options.atomicSwapEvidence?.trim()) fail("atomic_swap_evidence_required");
      const changed = state.snapshot.roster.filter(p => (Object.entries(action.lineup).find(([, id]) => id === p.id)?.[0] ?? null) !== p.slot);
      if (changed.length !== 2) fail("lineup_requires_multiple_transactions");
      const from = changed.find(p => p.slot !== null), to = changed.find(p => p.id !== from?.id);
      if (!from || !to || action.lineup[from.slot!] !== to.id || (to.slot !== null && action.lineup[to.slot] !== from.id)) fail("non_atomic_lineup_plan");
      const source = one(playerRows(observation).filter(r => r.id === from!.id), "missing_lineup_source");
      const control = one(source.row.controls.filter(c => !c.disabled && c.attributes["aria-label"]?.startsWith("Click here to edit ")), "missing_lineup_source_control");
      await this.stop();
      await this.page.evaluate(atomicOwnedGesture, witness(observation, this.options.binding, state.snapshot.period, targetControl(control, source.id)));
      observation = await this.observe();
      const rows = playerRows(observation), selected = one(rows.filter(r => r.id === from!.id), "missing_selected_source"), target = one(rows.filter(r => r.id === to!.id), "missing_lineup_target");
      if (!selected.row.attributes.class?.split(/\s+/).includes(selection!.sourceClass) || !target.row.attributes.class?.split(/\s+/).includes(selection!.targetClass)) fail("unobserved_swap_target_state");
      const targetButton = one(target.row.controls.filter(c => !c.disabled && c.attributes["aria-label"]?.startsWith("Click here to edit ")), "missing_lineup_target_control");
      gesture = witness(observation, this.options.binding, state.snapshot.period, targetControl(targetButton, target.id));
    } else {
      if (!this.options.atomicAcquisitionEvidence?.trim()) fail("atomic_acquisition_evidence_required");
      if (action.kind === "waiver_claim" && !this.options.collectPendingClaims) fail("pending_claim_readback_unavailable");
      observation = await this.stageAcquisition(action, state, observation);
      const confirmation = parseOwnedAcquisitionConfirmation(observation, this.options.binding, action, state.snapshot.period);
      const { target, heading, period: _period, ...terms } = confirmation;
      gesture = witness(observation, this.options.binding, state.snapshot.period, target, terms, heading);
    }
    const ticket: PreparedOwnedAction = { actionId: actionFingerprint(state.snapshot, action), observationId: state.observation.observationId,
      snapshotHash: state.snapshot.hash, leagueId: state.snapshot.leagueId, teamId: state.snapshot.teamId, period: state.snapshot.period, atomic: true,
      controlsEvidenceHash: digest(gesture), expiresAt: new Date(gesture.expiresAt).toISOString() };
    this.pending = { ticket, ticketHash: digest(ticket), action: structuredClone(action), state: structuredClone({...state, pendingClaims: current.pendingClaims}), gesture };
    return ticket;
  }
  private async stageAcquisition(action: Extract<OwnedAction, { addId: string }>, state: OwnedState, initial: OwnedObservation): Promise<OwnedObservation> {
    const leaguePath = `/f1/${this.options.binding.leagueId}`, teamPath = `${leaguePath}/${this.options.binding.teamId}`;
    const navigate = async (url: string) => {
      await this.stop(); const destination = new URL(url);
      if (destination.origin !== origin || !(destination.pathname === leaguePath || destination.pathname.startsWith(leaguePath + "/"))) fail("unowned_navigation");
      const response = await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
      if (response && response.status() >= 400) fail("owned_acquisition_read_failed");
      return this.observe(false);
    };
    const sources = this.options.getAcquisitionPoolSources?.();
    let poolUrl: string;
    const validatePoolSource = (source: OwnedObservation) => {
      assertOwnedIdentity(source, {execution: {...this.options.binding, writesEnabled: false, releaseSha: "", runningSha: "", verifiedCapabilities: [], policy: {allowedActions: [], tradesEnabled: false, windows: []}}, profileId: this.options.profileId}, this.clock(), false);
      const url = new URL(source.url), expected = {status: action.kind === "waiver_claim" ? "W" : "FA", stat1: `S_PW_${state.snapshot.period}`};
      if (url.pathname !== leaguePath + "/players" || Object.entries(expected).some(([name, value]) =>
        url.searchParams.getAll(name).length !== 1 || url.searchParams.get(name) !== value ||
        source.dom.controls.filter(c => c.tag === "select" && c.name === name && !c.disabled && c.value === value && c.options.some(o => o.value === value && o.selected && !o.disabled)).length !== 1)) fail("acquisition_pool_source_unverified");
    };
    if (sources) {
      const source = one(sources.filter(o => playerRows(o).some(row => row.id === action.addId)), "ambiguous_acquisition_pool_source");
      validatePoolSource(source); poolUrl = source.url;
    } else {
      poolUrl = one(initial.dom.links.filter(l => l.text.trim() === "Players" && new URL(l.href).pathname === leaguePath + "/players"), "missing_observed_pool_link").href;
    }
    let observation = await navigate(poolUrl);
    if (sources) validatePoolSource(observation);
    const candidate = one(playerRows(observation).filter(r => r.id === action.addId), "candidate_not_in_observed_pool_page");
    const add = one(candidate.row.links.filter(l => l.title === "Add Player" && new URL(l.href).pathname === leaguePath + "/addplayer" &&
      new URL(l.href).searchParams.getAll("apid").length === 1 && new URL(l.href).searchParams.get("apid") === action.addId &&
      [...new URL(l.href).searchParams.keys()].every(k => k === "apid")), "missing_observed_add_control");
    observation = await navigate(add.href);
    if (new URL(observation.url).pathname === leaguePath + "/selectmanager") {
      if (!observation.dom.headings.includes("Select Team")) fail("unobserved_manager_selection");
      const form = one(observation.dom.forms.filter(f => f.method === "get" && new URL(f.action).pathname === leaguePath + "/selectmanager"), "missing_team_selection_form");
      const select = one(form.controls.filter(c => c.tag === "select" && c.name === "mid" && !c.disabled), "missing_team_selection_control");
      if (!select.options.some(o => o.value === this.options.binding.teamId && !o.disabled)) fail("assigned_team_not_offered");
      await this.stop();
      await Promise.all([
        this.page.waitForURL(u => u.pathname.endsWith("/addplayer"), { timeout: 10000 }),
        this.page.evaluate(({ leaguePath, teamId, addId }) => {
          const forms = [...document.forms].filter(f => f.method.toLowerCase() === "get" && new URL(f.action).origin === location.origin && new URL(f.action).pathname === leaguePath + "/selectmanager");
          if (forms.length !== 1) throw new Error("team_selection_changed");
          const form = forms[0]!, selects = [...form.querySelectorAll<HTMLSelectElement>('select[name="mid"]')], submits = [...form.querySelectorAll<HTMLInputElement>('input[type="submit"][name="submit"]')];
          const done = form.querySelector<HTMLInputElement>('input[name="done"]')?.value ?? new URL(location.href).searchParams.get("done");
          const target = done ? new URL(done, location.href) : null;
          if (selects.length !== 1 || submits.length !== 1 || selects[0]!.disabled || submits[0]!.disabled ||
            ![...selects[0]!.options].some(o => o.value === teamId && !o.disabled) || !target || target.origin !== location.origin ||
            target.pathname !== leaguePath + "/addplayer" || target.searchParams.getAll("apid").length !== 1 || target.searchParams.get("apid") !== addId ||
            [...target.searchParams.keys()].some(k => k !== "apid")) throw new Error("team_selection_changed");
          selects[0]!.value = teamId;
          form.requestSubmit(submits[0]!);
        }, { leaguePath, teamId: this.options.binding.teamId, addId: action.addId })
      ]);
      observation = await this.observe(false);
    }
    const heading = action.kind === "waiver_claim" ? "Claim Player From Waivers" : "Add Free Agent";
    if (!observation.dom.headings.includes(heading) || ![leaguePath + "/addplayer", teamPath + "/addplayer"].includes(new URL(observation.url).pathname)) fail("acquisition_kind_changed");
    const drop = one(playerRows(observation).filter(r => r.id === action.dropId), "drop_not_offered");
    const control = one(drop.row.controls.filter(c => c.tag === "button" && c.type === "button" && !c.disabled &&
      c.attributes.title === "Click to drop this player" && c.attributes["data-check-box-value"]?.trim() === action.dropId), "missing_observed_drop_control");
    const gesture = witness(observation, this.options.binding, state.snapshot.period, targetControl(control, action.dropId));
    gesture.dropSelection = { addId: action.addId, dropId: action.dropId, heading };
    await this.stop();
    await this.page.evaluate(atomicOwnedGesture, gesture);
    await this.page.waitForFunction(() => [...document.querySelectorAll<HTMLInputElement>('input[type="submit"][name="submit_add_player"]')].some(b => /^(?:Create claim to Add|Add) .+, Drop .+/.test(b.value.trim())), undefined, { timeout: 10000 });
    return this.observe(false);
  }
  async commit(ticket: PreparedOwnedAction, beforeCommit: () => Promise<void>): Promise<void> {
    if (!this.options.allowSubmission) fail("real_team_writes_disabled");
    const pending = this.pending ?? fail("unknown_or_consumed_owned_ticket");
    this.authority(pending.action, pending.state);
    if (pending.ticket !== ticket || digest(ticket) !== pending.ticketHash || this.consumed.has(ticket) || !ticket.atomic || Date.parse(ticket.expiresAt) <= this.clock().getTime()) fail("unknown_or_consumed_owned_ticket");
    this.consumed.add(ticket); this.pending = undefined;
    await this.stop();
    await beforeCommit();
    this.authority(pending.action, pending.state);
    // Any error from this dispatch is uncertain. The ticket is already consumed.
    // No awaited work occurs between the final guard and the atomic DOM action.
    // Acquisition submits a document POST. Register its completion before the
    // click, so the independent GET readback cannot cancel an in-flight POST.
    // Settling is not success evidence; only the guard's later reload is proof.
    const navigation = pending.action.kind !== "set_lineup" ? this.page.waitForNavigation({ waitUntil: "load", timeout: 15000 })
      .then(response => !!response, () => false) : null;
    await this.page.evaluate(atomicOwnedGesture, pending.gesture);
    if (navigation && !await navigation) fail("acquisition_navigation_uncertain");
    if (pending.action.kind === "set_lineup") {
      const expected = pending.state.snapshot.roster.map(p => ({ id: p.id,
        position: Object.entries((pending.action as Extract<OwnedAction, {kind: "set_lineup"}>).lineup).find(([, id]) => id === p.id)?.[0].split(":")[0] ?? "BN" }));
      // Wait only for the submitted UI operation to settle. This is not readback
      // proof: the guard still performs an independent new-page roster read.
      await this.page.waitForFunction(players => players.every(p => {
        const matches = [...document.querySelectorAll<HTMLAnchorElement>('table tbody tr a[data-ys-playerid]')].filter(a => a.getAttribute('data-ys-playerid') === p.id);
        return matches.some(a => a.closest('tr')?.getAttribute('data-pos') === p.position);
      }), expected, {timeout:10000});
    }
  }
  async readback(): Promise<OwnedActionReadback> {
    const state = await this.read();
    let pendingClaims: OwnedClaimsEvidence | null = null;
    if (this.options.collectPendingClaims) { try { pendingClaims = await this.options.collectPendingClaims(); } catch { /* Unknown stays null; never an empty queue. */ } }
    return { state, pendingClaims };
  }
  async cancelPreparation(): Promise<void> { this.pending = undefined; await this.read(); }
}
