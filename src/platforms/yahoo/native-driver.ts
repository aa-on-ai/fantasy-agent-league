import { randomUUID } from "node:crypto";
import { digest, validateDecision, validateSnapshot, type Decision } from "../../manager/season.js";
import { actionFingerprint } from "../../execution/coordinator.js";
import { readStop, nativeDocumentUrl } from "../../runtime/native-read-proof.js";
import { nativePrimaryTree, nativeDescendants, nativePlayerCell, type NativeNode, type NativeObservation, type DesktopBinding } from "./desktop-season.js";
import type { NativeActionReadback, NativeState, NativeTransport, PreparedNativeAction } from "./guarded-native.js";

type Action = Exclude<Decision, { kind: "no_action" }>;
// Exactly the native CUA App methods. No browser evaluation, HTTP or CLI bridge.
export interface NativeDesktopApp {
  getAXStateAndScreenshot(options: { disableDiffing: boolean }): Promise<{ state: string; screenshot?: Uint8Array }>;
  getAXState(): Promise<string>;
  click(index: number): Promise<void>;
  pressKey(key: string): Promise<void>;
}
export interface DriverObservation extends NativeObservation { observationId: string; screenshot: Uint8Array }
export interface NativeDriverOptions {
  binding: DesktopBinding;
  profileId: string;
  windowId: string;
  emergencyStopPath: string;
  allowSubmission: boolean;
  // Existing buildDesktopLineupState/source producer; must retain the exact
  // supplied capture and use source clocks, not the normalization time.
  normalize(observation: DriverObservation): Promise<NativeState>;
  record(observation: DriverObservation): Promise<void>;
  // Host visual corroboration is needed because Safari's tree does not expose
  // the green/disabled swap-target distinction. This is evidence, not a click.
  verifySwapTarget?: (observation: DriverObservation, targetIndex: number) => Promise<boolean>;
  collectPendingClaims?: () => Promise<Omit<NativeActionReadback, "state">>;
  atomicSwapVerified: boolean;
  atomicAcquisitionVerified: boolean;
  clock?: () => Date;
}
const fail = (code: string): never => { throw new Error(code); };
interface BoundPage { observation: DriverObservation; tree: NativeNode[]; url: URL }
interface PlayerControl { index: number; key: string; name: string; position: string; raw: string }
function controlRows(tree: NativeNode[]): PlayerControl[] {
  const rows: PlayerControl[] = [];
  tree.forEach((node, i) => {
    if (!node.text.startsWith("row (selectable)")) return;
    const cells = nativeDescendants(tree, i).filter(n => n.text.startsWith("cell (selectable)"));
    const details = cells.find(n => n.text.includes(", Value: ") && /\n[A-Za-z]+ - (QB|RB|WR|TE|K|DEF)\n/.test(n.text));
    if (!details) return;
    const p = nativePlayerCell(details.text.replace(/^cell \(selectable\) /, ""));
    const first = cells[0]!;
    const raw = first.text.replace(/^cell \(selectable\) /, "");
    const slot = raw.match(/^Click here to edit (\S+) (.+)$/);
    if (slot && slot[2] !== p.name) fail("player_identity_conflict");
    rows.push({ index: first.id, key: p.key, name: p.name, position: slot?.[1] ?? "", raw });
  });
  return rows;
}
function one<T>(values: T[], code: string): T { if (values.length !== 1) return fail(code); return values[0]!; }

// Parses the observed Yahoo confirmation, including both numeric IDs from the
// stage-2 links. A generic Submit button or success text is never sufficient.
export function parseWaiverConfirmation(capture: string, binding: DesktopBinding, addKey: string, dropKey: string) {
  return parseAcquisitionConfirmation(capture, binding, addKey, dropKey, "waiver_claim");
}
export function parseFreeAgentConfirmation(capture: string, binding: DesktopBinding, addKey: string, dropKey: string) {
  return parseAcquisitionConfirmation(capture, binding, addKey, dropKey, "add_drop");
}
function parseAcquisitionConfirmation(capture: string, binding: DesktopBinding, addKey: string, dropKey: string, kind: "waiver_claim" | "add_drop") {
  const tree = nativePrimaryTree(capture), team = `football.fantasysports.yahoo.com/f1/${binding.leagueId}/${binding.teamId}`;
  const primary = nativeDocumentUrl(capture);
  if (!primary || !/^football\.fantasysports\.yahoo\.com\//.test(primary)) fail("wrong_confirmation_page");
  const page = new URL("https://" + primary);
  if (![ `/f1/${binding.leagueId}/addplayer`, `/f1/${binding.leagueId}/${binding.teamId}/addplayer` ].includes(page.pathname) || !/^\d+$/.test(page.searchParams.get("apid") ?? "")) fail("wrong_confirmation_page");
  const owners = tree.filter(n => n.text.startsWith("link My Team, Value: "));
  if (!owners.length || owners.some(n => n.text !== `link My Team, Value: ${team}`)) fail("wrong_team");
  const heading = kind === "waiver_claim" ? "Claim Player From Waivers" : "Add Free Agent";
  if (!tree.some(n => n.text === `heading ${heading}, Value: 2`)) fail("unobserved_confirmation_kind");
  const rows = controlRows(tree), add = one(rows.filter(r => r.key === addKey && r.raw === "\ue035"), "wrong_confirmation_add");
  const drop = one(rows.filter(r => r.key === dropKey && r.raw === "\ue033"), "wrong_confirmation_drop");
  const label = `button ${kind === "waiver_claim" ? "Create claim to Add" : "Add"} ${add.name}, Drop ${drop.name}`;
  const button = one(tree.filter(n => n.text === label), "missing_exact_confirmation");
  const stats = tree.filter(n => n.text.startsWith("link Stats, Value: ")).map(n => new URL("https://" + n.text.split("Value: ")[1]!));
  const stage = one(stats.filter(u => u.origin === "https://football.fantasysports.yahoo.com" &&
    !u.username && !u.password && !u.hash &&
    u.pathname === `/f1/${binding.leagueId}/${binding.teamId}/addplayer` && u.searchParams.get("stage") === "2"), "missing_stage_two_identity");
  for (const key of ["stage", "apid", "dpid"]) {
    if (stage.searchParams.getAll(key).length !== 1) fail("conflicting_confirmation_ids");
  }
  if (page.searchParams.getAll("apid").length !== 1) fail("conflicting_confirmation_ids");
  const apid = stage.searchParams.get("apid"), dpid = stage.searchParams.get("dpid");
  if (!apid || apid !== page.searchParams.get("apid") || !/^\d+$/.test(dpid ?? "") || apid === dpid) fail("conflicting_confirmation_ids");
  for (const [name, id] of [[add.name, apid], [drop.name, dpid]]) {
    if (!tree.some(n => n.text === `link ${name}, Value: sports.yahoo.com/nfl/players/${id}`)) fail("missing_numeric_player_identity");
  }
  const prefix = kind === "waiver_claim" ? "text If successful, this waiver claim will be reflected in your lineup for " : "text This transaction will be reflected in your lineup for ";
  const terms = one(tree.filter(n => n.text.startsWith(prefix)), "missing_acquisition_effective_period").text;
  const period = kind === "waiver_claim" ? terms.match(/Week (\d+) on ([^.]+)\./) : terms.match(/Week (\d+)\s*$/);
  if (!period) return fail("missing_acquisition_effective_period");
  return { index: button.id, addKey, dropKey, apid, dpid: dpid!, period: period[1]!, effectiveDateText: period[2]?.trim() ?? null, label };
}

export class YahooNativeDriver implements NativeTransport {
  private clock: () => Date;
  private pending: { ticket: PreparedNativeAction; ticketHash: string; action: Action; state: NativeState; semanticHash: string; targetKey?: string } | undefined;
  private consumed = new Set<PreparedNativeAction>();
  constructor(private app: NativeDesktopApp, private options: NativeDriverOptions) { this.clock = options.clock ?? (() => new Date()); }
  private async stop() { if (await readStop(this.options.emergencyStopPath) !== "clear") fail("emergency_stop"); }
  private teamPath() { return `/f1/${this.options.binding.leagueId}/${this.options.binding.teamId}`; }
  private async observe(): Promise<BoundPage> {
    await this.stop();
    const raw = await this.app.getAXStateAndScreenshot({ disableDiffing: true });
    const capturedAt = this.clock().toISOString();
    if (!raw.screenshot?.length) fail("native_screenshot_required");
    const observation: DriverObservation = { capture: raw.state, screenshot: raw.screenshot!, capturedAt, observationId: randomUUID() };
    await this.options.record(observation);
    const tree = nativePrimaryTree(raw.state);
    const window = raw.state.match(/^\d+ standard window [^\n]*?\bID: ([^,\n]+)/m)?.[1];
    if (window !== this.options.windowId) fail("native_window_conflict");
    const primary = nativeDocumentUrl(raw.state);
    if (!primary || !primary.startsWith("football.fantasysports.yahoo.com/")) fail("wrong_native_document");
    const url = new URL("https://" + primary);
    const owners = tree.filter(n => n.text.startsWith("link My Team, Value: "));
    if (!owners.length || owners.some(n => n.text !== `link My Team, Value: football.fantasysports.yahoo.com${this.teamPath()}`)) fail("wrong_team");
    const leaguePath = `/f1/${this.options.binding.leagueId}`;
    if (url.pathname !== leaguePath && !url.pathname.startsWith(leaguePath + "/")) fail("wrong_league");
    if (tree.some(n => /^(?:text|heading|button).*\b(?:Verify you are human|CAPTCHA|Sign in to Yahoo)\b/i.test(n.text))) fail("human_challenge");
    return { observation, tree, url };
  }
  private async click(index: number) { await this.stop(); await this.app.click(index); await this.app.getAXState(); }
  private async link(page: BoundPage, label: string, url: string) {
    const n = one(page.tree.filter(n => n.text === `link ${label}, Value: ${url}`), "missing_native_navigation");
    await this.click(n.id); return this.observe();
  }
  private async normalize(page: BoundPage) {
    if (page.url.pathname !== this.teamPath() || page.url.search) fail("team_read_required");
    const state = structuredClone(await this.options.normalize(page.observation));
    if (state.capture !== page.observation.capture || state.windowId !== this.options.windowId || state.profileId !== this.options.profileId) fail("native_normalization_conflict");
    validateSnapshot(state.snapshot, this.options.binding, this.clock());
    state.observationId = page.observation.observationId;
    state.nativeCapturedAt = page.observation.capturedAt;
    return state;
  }
  async read(): Promise<NativeState> {
    let page = await this.observe();
    if (page.url.pathname !== this.teamPath() || page.url.search) page = await this.link(page, "My Team", `football.fantasysports.yahoo.com${this.teamPath()}`);
    else { await this.stop(); await this.app.pressKey("super+r"); await this.app.getAXState(); page = await this.observe(); }
    return this.normalize(page);
  }
  async prepare(action: Action, state: NativeState): Promise<PreparedNativeAction> {
    if (this.pending) fail("native_preparation_already_pending");
    validateSnapshot(state.snapshot, this.options.binding, this.clock());
    if (validateDecision(state.snapshot, action).length) fail("illegal_native_action");
    const actionId = actionFingerprint(state.snapshot, action);
    let page = await this.observe(), semanticHash: string, targetKey: string | undefined;
    if (page.url.pathname !== this.teamPath()) fail("team_read_required");
    const current = await this.normalize(page);
    const comparable = ({ capturedAt: _t, hash: _h, ...s }: NativeState["snapshot"]) => digest(s);
    if (comparable(current.snapshot) !== comparable(state.snapshot)) fail("state_changed_replan_required");
    if (action.kind === "set_lineup") {
      const changed = state.snapshot.roster.filter(p => (Object.entries(action.lineup).find(([, id]) => id === p.id)?.[0] ?? null) !== p.slot);
      if (changed.length !== 2) fail("lineup_requires_multiple_transactions");
      const from = changed.find(p => p.slot !== null)!;
      const to = changed.find(p => p.id !== from?.id)!;
      if (!from || !to || action.lineup[from.slot!] !== to.id || (to.slot !== null && action.lineup[to.slot] !== from.id)) fail("non_atomic_lineup_plan");
      const select = one(controlRows(page.tree).filter(r => r.key === from.id && r.position), "missing_lineup_source_control");
      await this.click(select.index); page = await this.observe();
      const target = one(controlRows(page.tree).filter(r => r.key === to.id && r.position), "missing_lineup_target_control");
      if (!await this.options.verifySwapTarget?.(page.observation, target.index)) fail("lineup_target_visual_evidence_required");
      targetKey = to.id;
      semanticHash = digest({ from: from.id, to: to.id, assignment: action.lineup });
    } else {
      page = await this.link(page, "Players", `football.fantasysports.yahoo.com/f1/${this.options.binding.leagueId}/players`);
      const candidate = one(controlRows(page.tree).filter(r => r.key === action.addId && r.raw === "\ue035"), "candidate_not_in_observed_pool_page");
      await this.click(candidate.index); page = await this.observe();
      const heading = action.kind === "waiver_claim" ? "Claim Player From Waivers" : "Add Free Agent";
      if (!page.tree.some(n => n.text === `heading ${heading}, Value: 2`)) fail("acquisition_kind_changed");
      const drop = one(controlRows(page.tree).filter(r => r.key === action.dropId && r.raw === "—"), "drop_not_offered");
      await this.click(drop.index); page = await this.observe();
      const confirmation = parseAcquisitionConfirmation(page.observation.capture, this.options.binding, action.addId, action.dropId, action.kind);
      if (confirmation.period !== state.snapshot.period) fail("waiver_period_changed");
      const { index: _index, ...semantic } = confirmation; semanticHash = digest(semantic);
    }
    const ticket: PreparedNativeAction = { actionId, observationId: state.observationId, snapshotHash: state.snapshot.hash,
      atomic: action.kind === "set_lineup" ? this.options.atomicSwapVerified : this.options.atomicAcquisitionVerified,
      controlsEvidenceHash: digest(page.observation.capture), expiresAt: new Date(Date.parse(page.observation.capturedAt) + Math.min(60000, this.options.binding.maxAgeMs)).toISOString() };
    this.pending = { ticket, ticketHash: digest(ticket), action: structuredClone(action), state: structuredClone(state), semanticHash, ...(targetKey ? { targetKey } : {}) };
    return ticket;
  }
  async commit(ticket: PreparedNativeAction, beforeCommit: () => Promise<void>): Promise<void> {
    if (!this.options.allowSubmission || this.options.binding.leagueId === "425299") fail("real_team_writes_disabled");
    const pending = this.pending ?? fail("unknown_or_consumed_native_ticket");
    if (ticket !== pending.ticket || digest(ticket) !== pending.ticketHash || this.consumed.has(ticket)) fail("unknown_or_consumed_native_ticket");
    if (pending.action.kind === "waiver_claim" && !this.options.collectPendingClaims) fail("pending_claim_readback_unavailable");
    if (!ticket.atomic || Date.parse(ticket.expiresAt) <= this.clock().getTime()) fail("expired_or_unverified_native_ticket");
    const page = await this.observe();
    let index: number;
    if (pending.action.kind === "set_lineup") {
      if (page.url.pathname !== this.teamPath()) fail("lineup_page_changed");
      const current = await this.normalize(page);
      const comparable = ({ capturedAt: _t, hash: _h, ...s }: NativeState["snapshot"]) => digest(s);
      if (comparable(current.snapshot) !== comparable(pending.state.snapshot)) fail("state_changed_replan_required");
      index = one(controlRows(page.tree).filter(r => r.key === pending.targetKey && r.position), "missing_lineup_target_control").index;
      if (!await this.options.verifySwapTarget?.(page.observation, index)) fail("lineup_target_visual_evidence_required");
    } else {
      const { index: freshIndex, ...semantic } = parseAcquisitionConfirmation(page.observation.capture, this.options.binding, pending.action.addId, pending.action.dropId, pending.action.kind);
      if (digest(semantic) !== pending.semanticHash) fail("confirmation_changed");
      index = freshIndex;
    }
    this.consumed.add(ticket); this.pending = undefined;
    await this.stop();
    if (!Number.isFinite(Date.parse(ticket.expiresAt)) || Date.parse(ticket.expiresAt) <= this.clock().getTime()) fail("expired_or_unverified_native_ticket");
    await beforeCommit();
    // No awaited work between the final guarded boundary and the native gesture.
    await this.app.click(index);
    await this.app.getAXState();
  }
  async readback(): Promise<NativeActionReadback> {
    // read() reloads/navigates and independently captures the actual team; never
    // recycle the confirmation response as transaction verification.
    const state = await this.read();
    const claims = this.options.collectPendingClaims ? await this.options.collectPendingClaims() :
      { pendingClaims: [], pendingClaimsCapture: null, pendingClaimsCapturedAt: null, pendingClaimsNormalized: false, pendingClaimsSourceHash: null };
    return { state, ...claims };
  }
  async cancelPreparation(): Promise<void> {
    const page = await this.observe();
    if (page.url.pathname.endsWith("/addplayer")) await this.link(page, "Cancel", `football.fantasysports.yahoo.com/f1/${this.options.binding.leagueId}/players`);
    else { await this.stop(); await this.app.pressKey("super+r"); await this.app.getAXState(); }
    this.pending = undefined;
  }
}
