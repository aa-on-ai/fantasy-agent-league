import { actionFingerprint, executeDecision, executionCapabilityAllowed, type ExecutionConfig, type ExecutionReceipt, type Ledger } from "../../execution/coordinator.js";
import { digest, validateDecision, validateSnapshot, type Decision, type SeasonSnapshot } from "../../manager/season.js";
import { validateAction } from "../../core/policy.js";
import { readStop } from "../../runtime/native-read-proof.js";
import type { OwnedObservation } from "./owned-sources.js";
import { assertOwnedLineupAuthorization, type OwnedLineupReleaseGrant } from "../../runtime/owned-lineup-release.js";
import { assertOwnedAcquisitionAuthorization, assertOwnedAcquisitionClaims, type OwnedAcquisitionReleaseGrant } from "../../runtime/owned-acquisition-release.js";

export type OwnedAction = Exclude<Decision, { kind: "no_action" }>;
export interface OwnedClaim { id: string; leagueId: string; teamId: string; period: string; addId: string; dropId: string }
export interface OwnedClaimsEvidence {
  observation: OwnedObservation;
  sourceHash: string;
  normalized: boolean;
  claims: OwnedClaim[];
  interpretation?: "observed_empty" | "explicitly_empty" | "observed_claims";
  supportingDocumentIds?: string[];
}
export interface OwnedState {
  observation: OwnedObservation;
  snapshot: SeasonSnapshot;
  lineupDeadlines: Record<string, string>;
  acquisitionDeadlines: Record<string, string>;
  // Unknown is null, not an empty queue. A waiver cannot prepare without this.
  pendingClaims: OwnedClaimsEvidence | null;
}
export interface PreparedOwnedAction {
  actionId: string;
  observationId: string;
  snapshotHash: string;
  leagueId: string;
  teamId: string;
  period: string;
  atomic: boolean;
  controlsEvidenceHash: string;
  expiresAt: string;
}
export interface OwnedActionReadback { state: OwnedState; pendingClaims: OwnedClaimsEvidence | null }
export interface OwnedTransport {
  read(): Promise<OwnedState>;
  prepare(action: OwnedAction, state: OwnedState): Promise<PreparedOwnedAction>;
  // Await the callback immediately before dispatch. The concrete driver checks
  // current DOM identity and exact control semantics atomically with its click.
  commit(prepared: PreparedOwnedAction, beforeCommit: () => Promise<void>): Promise<void>;
  readback(): Promise<OwnedActionReadback>;
}
export interface OwnedDisposableApproval {
  context: "disposable";
  leagueId: string;
  teamId: string;
  profileId: string;
  actionId: string;
  expiresAt: string;
  approvalReference: string;
  isolatedSessionVerified: boolean;
  recoveryVerified: boolean;
}
// This is review material, not an activation switch. The real-league hard block
// remains until a separately reviewed implementation explicitly changes it.
export interface OwnedReviewedRelease {
  releaseSha: string;
  leagueId: string;
  teamId: string;
  profileId: string;
  approvalReference: string;
  reviewReference: string;
  capabilityEvidence: Partial<Record<OwnedAction["kind"], string>>;
}
export interface GuardedOwnedConfig {
  execution: ExecutionConfig;
  profileId: string;
  emergencyStopPath: string;
  approval: OwnedDisposableApproval | null;
  reviewedRelease?: OwnedReviewedRelease;
  lineupRelease?: OwnedLineupReleaseGrant;
  acquisitionRelease?: OwnedAcquisitionReleaseGrant;
  pendingClaimsPageUrl: string | null;
  browserLedger: Ledger;
}
const fail = (code: string): never => { throw new Error(code); };
const origin = "https://football.fantasysports.yahoo.com";
export function assertOwnedIdentity(observation: OwnedObservation, config: Pick<GuardedOwnedConfig, "execution" | "profileId">, now: Date, requireTeamPage = true): void {
  const { leagueId, teamId, maxAgeMs } = config.execution;
  const expected = `/f1/${leagueId}/${teamId}`;
  const url = new URL(observation.url);
  const age = now.getTime() - Date.parse(observation.capturedAt);
  if (!observation.observationId || observation.profileId !== config.profileId || !Number.isFinite(age) || age < 0 || age > maxAgeMs ||
    url.origin !== origin || url.username || url.password || url.hash || (requireTeamPage && url.pathname !== expected)) fail("owned_identity_unverified");
  const leaguePath = `/f1/${leagueId}`;
  const numericTeam = url.pathname.slice(leaguePath.length).match(/^\/(\d+)(?:\/|$)/)?.[1];
  if (!(url.pathname === leaguePath || url.pathname.startsWith(leaguePath + "/")) || (numericTeam && numericTeam !== teamId) ||
    url.searchParams.getAll("mid").length > 1 || (url.searchParams.has("mid") && url.searchParams.get("mid") !== teamId)) fail("wrong_team");
  const owners = observation.dom.links.filter(l => l.text.trim() === "My Team");
  if (!owners.length || owners.some(l => { const u = new URL(l.href, url); return u.origin !== origin || u.pathname !== expected || !!u.username || !!u.password; })) fail("wrong_team");
}
function safeState(state: OwnedState, config: GuardedOwnedConfig, now: Date): SeasonSnapshot {
  const snapshot = validateSnapshot(state.snapshot, config.execution, now);
  assertOwnedIdentity(state.observation, config, now);
  if (Date.parse(state.observation.capturedAt) < Date.parse(snapshot.capturedAt)) fail("invalid_owned_capture_time");
  return snapshot;
}
function deadlines(state: OwnedState, action: OwnedAction, now: Date): void {
  const times = action.kind === "set_lineup" ? state.lineupDeadlines : state.acquisitionDeadlines;
  const ids = action.kind === "set_lineup" ? state.snapshot.roster.filter(p =>
    (Object.entries(action.lineup).find(([, id]) => id === p.id)?.[0] ?? null) !== p.slot).map(p => p.id) : [action.addId, action.dropId];
  for (const id of ids) if (!Number.isFinite(Date.parse(times[id] ?? "")) || Date.parse(times[id]!) <= now.getTime()) fail("player_deadline_closed_or_unknown");
}
function authority(config: GuardedOwnedConfig, actionId: string, now: Date, snapshot: SeasonSnapshot, action: OwnedAction): void {
  if (config.execution.leagueId === "425299") {
    const release = action.kind === "set_lineup" ? config.lineupRelease : config.acquisitionRelease;
    if (!release) fail("real_team_writes_disabled");
    if (release!.releaseSha !== config.execution.releaseSha || release!.runningSha !== config.execution.runningSha) fail("reviewed_release_mismatch");
    const check = {leagueId: config.execution.leagueId, teamId: config.execution.teamId,
      profileId: config.profileId, releaseSha: config.execution.releaseSha, runningSha: config.execution.runningSha, snapshot, action};
    if (action.kind === "set_lineup") assertOwnedLineupAuthorization(config.lineupRelease!.authorization, check, now);
    else assertOwnedAcquisitionAuthorization(config.acquisitionRelease!.authorization, check, now);
    return;
  }
  const a = config.approval;
  if (!a || a.context !== "disposable" || !a.approvalReference.trim() || !a.isolatedSessionVerified || !a.recoveryVerified ||
    a.leagueId !== config.execution.leagueId || a.teamId !== config.execution.teamId || a.profileId !== config.profileId ||
    a.actionId !== actionId || !Number.isFinite(Date.parse(a.expiresAt)) || Date.parse(a.expiresAt) <= now.getTime()) fail("disposable_approval_required");
  const release = config.reviewedRelease;
  if (release && (release.releaseSha !== config.execution.releaseSha || release.leagueId !== config.execution.leagueId ||
    release.teamId !== config.execution.teamId || release.profileId !== config.profileId || !release.approvalReference.trim() || !release.reviewReference.trim())) fail("reviewed_release_mismatch");
}
function safeClaims(evidence: OwnedClaimsEvidence | null, config: GuardedOwnedConfig, now: Date, notBefore: number): OwnedClaim[] {
  if (!evidence || !evidence.normalized || evidence.sourceHash !== digest(evidence.observation) || !config.pendingClaimsPageUrl ||
    evidence.observation.url !== config.pendingClaimsPageUrl || Date.parse(evidence.observation.capturedAt) < notBefore) fail("pending_claim_readback_unavailable");
  assertOwnedIdentity(evidence!.observation, config, now, false);
  const path = new URL(config.pendingClaimsPageUrl!).pathname;
  // Yahoo documents pending claims above the roster on My Team itself. A bound
  // root page is valid; its missing queue is still null, never normalized empty.
  const teamPath = `/f1/${config.execution.leagueId}/${config.execution.teamId}`;
  if (path !== teamPath && !path.startsWith(teamPath + "/")) fail("pending_claim_page_unbound");
  const claims = evidence!.claims;
  if (!Array.isArray(claims) || claims.some(c => !c.id || c.leagueId !== config.execution.leagueId || c.teamId !== config.execution.teamId ||
    !c.period || !c.addId || !c.dropId || c.addId === c.dropId) || new Set(claims.map(c => c.id)).size !== claims.length) fail("invalid_pending_claims");
  return claims;
}
export async function runGuardedOwnedAction(original: SeasonSnapshot, decision: Decision, config: GuardedOwnedConfig,
  transport: OwnedTransport, ledger: Ledger, clock: () => Date = () => new Date()): Promise<ExecutionReceipt> {
  if (decision.kind === "no_action") return { status: "no_action", code: decision.reason };
  const actionId = actionFingerprint(original, decision);
  try { authority(config, actionId, clock(), original, decision); } catch (e) { return { status: "blocked", code: (e as Error).message }; }
  let fresh: OwnedState | undefined;
  let freshHash: string | undefined;
  let observationId: string | undefined;
  let commitStarted = false;
  const stopped = async () => (await readStop(config.emergencyStopPath)) !== "clear";
  try {
    return await config.browserLedger.exclusive(`yahoo-owned-browser:${config.profileId}`, async () => executeDecision(original, decision, config.execution, {
      stopped,
      async read() {
        if (await stopped()) fail("emergency_stop");
        fresh = await transport.read();
        observationId = fresh.observation.observationId;
        const snapshot = safeState(fresh, config, clock()); freshHash = snapshot.hash;
        if (config.execution.leagueId === "425299" && decision.kind !== "set_lineup")
          assertOwnedAcquisitionClaims(fresh, decision, {...config.execution, profileId: config.profileId}, clock());
        deadlines(fresh, decision, clock());
        if (decision.kind === "waiver_claim") {
          const claims = safeClaims(fresh.pendingClaims, config, clock(), 0);
          if (claims.some(c => c.period === snapshot.period && c.addId === decision.addId && c.dropId === decision.dropId)) fail("equivalent_claim_already_pending");
        }
        return snapshot;
      },
      async submit(action) {
        if (!fresh) fail("fresh_owned_read_required");
        const prepared = await transport.prepare(action, fresh!);
        const beforeCommit = async () => {
          if (await stopped()) fail("emergency_stop");
          const now = clock(); authority(config, actionId, now, fresh!.snapshot, action);
          if (config.execution.leagueId === "425299" && action.kind !== "set_lineup")
            assertOwnedAcquisitionClaims(fresh!, action, {...config.execution, profileId: config.profileId}, now);
          if (!executionCapabilityAllowed(config.execution, original, action, now)) fail("capability_unverified");
          safeState(fresh!, config, now); deadlines(fresh!, action, now);
          if (!validateAction({ actionId, kind: action.kind, teamId: config.execution.teamId, submittedAt: now.toISOString() },
            { now: now.toISOString(), ownedTeamId: config.execution.teamId, policy: config.execution.policy }).ok) fail("outside_action_window");
          if (fresh!.snapshot.hash !== freshHash || validateDecision(fresh!.snapshot, action).length || !prepared.atomic || prepared.actionId !== actionId ||
            prepared.observationId !== fresh!.observation.observationId || prepared.snapshotHash !== fresh!.snapshot.hash || prepared.leagueId !== original.leagueId ||
            prepared.teamId !== original.teamId || prepared.period !== original.period || !/^[a-f0-9]{64}$/.test(prepared.controlsEvidenceHash) ||
            !Number.isFinite(Date.parse(prepared.expiresAt)) || Date.parse(prepared.expiresAt) <= now.getTime()) fail("unverified_owned_controls");
        };
        await beforeCommit(); commitStarted = true;
        await transport.commit(prepared, beforeCommit);
      },
      async verify(action) {
        if (await stopped()) return "unknown";
        const requestedAt = clock().getTime();
        const result = await transport.readback(), state = result.state;
        const snapshot = safeState(state, config, clock());
        if (snapshot.period !== original.period || state.observation.observationId === observationId || Date.parse(state.observation.capturedAt) < requestedAt ||
          Date.parse(snapshot.capturedAt) < Date.parse(fresh?.snapshot.capturedAt ?? original.capturedAt)) return "unknown";
        if (action.kind === "set_lineup") {
          return digest(original.roster.map(p => p.id).sort()) === digest(snapshot.roster.map(p => p.id).sort()) && snapshot.slots.length === original.slots.length &&
            snapshot.slots.every(slot => snapshot.roster.find(p => p.slot === slot.id)?.id === action.lineup[slot.id]) ? "applied" : "unknown";
        }
        if (action.kind === "add_drop") {
          const expected = original.roster.filter(p => p.id !== action.dropId).map(p => p.id).concat(action.addId).sort();
          return digest(snapshot.roster.map(p => p.id).sort()) === digest(expected) ? "applied" : "unknown";
        }
        const claims = safeClaims(result.pendingClaims, config, clock(), requestedAt);
        if (result.pendingClaims?.observation.observationId === fresh?.pendingClaims?.observation.observationId) return "unknown";
        return claims.filter(c => c.period === original.period && c.addId === action.addId && c.dropId === action.dropId).length === 1 ? "applied" : "unknown";
      }
    }, ledger, clock));
  } catch {
    return { status: commitStarted ? "uncertain" : "blocked", code: commitStarted ? "owned_browser_release_uncertain" : "owned_browser_preflight_failed", actionId };
  }
}
