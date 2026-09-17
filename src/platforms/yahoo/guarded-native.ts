import { executeDecision, actionFingerprint, executionCapabilityAllowed, type ExecutionConfig, type ExecutionReceipt, type Ledger } from "../../execution/coordinator.js";
import { digest, validateDecision, validateSnapshot, type Decision, type SeasonSnapshot } from "../../manager/season.js";
import { verifyNativeTeamCapture, readStop } from "../../runtime/native-read-proof.js";
import { validateAction } from "../../core/policy.js";

type Action = Exclude<Decision, { kind: "no_action" }>;
export interface NativeState {
  observationId: string;
  // Main roster read time; snapshot age still uses the oldest supporting source.
  nativeCapturedAt?: string;
  profileId: string;
  windowId: string;
  capture: string;
  snapshot: SeasonSnapshot;
  // The host resolves every player lock from fresh native controls and a dated
  // schedule. An absent deadline is a blocker, not an indefinitely open window.
  lineupDeadlines: Record<string, string>;
  acquisitionDeadlines: Record<string, string>;
}
export interface DisposableApproval {
  context: "disposable";
  leagueId: string; teamId: string; profileId: string;
  actionId: string;
  expiresAt: string;
  approvalReference: string;
  isolatedSessionVerified: boolean;
  recoveryVerified: boolean;
}
export interface PreparedNativeAction {
  actionId: string;
  observationId: string;
  snapshotHash: string;
  // This attests a reviewed atomic domain operation, never a sequence of
  // unverified multi-player edits. Partial lineup plans stop before any click.
  atomic: boolean;
  controlsEvidenceHash: string;
  expiresAt: string;
}
export interface NativeActionReadback {
  state: NativeState;
  // A waiver submission is established by the independent pending-claims page,
  // not by ownership (which changes only if the claim eventually wins).
  pendingClaims: Array<{ leagueId: string; teamId: string; period: string; addId: string; dropId: string; id: string }>;
  pendingClaimsCapture: string | null;
  pendingClaimsCapturedAt: string | null;
  pendingClaimsNormalized: boolean;
  pendingClaimsSourceHash: string | null;
}
export interface NativeTransport {
  read(): Promise<NativeState>;
  prepare(action: Action, state: NativeState): Promise<PreparedNativeAction>;
  // Implementations must await beforeCommit immediately before the final native
  // gesture and perform no further asynchronous work before that gesture.
  commit(prepared: PreparedNativeAction, beforeCommit: () => Promise<void>): Promise<void>;
  readback(): Promise<NativeActionReadback>;
}
export interface GuardedNativeConfig {
  execution: ExecutionConfig;
  teamName: string;
  profileId: string;
  windowId: string;
  emergencyStopPath: string;
  approval: DisposableApproval | null;
  // Fill only after observing the actual pending-claim page in the approved
  // disposable context. The transaction feed is not a substitute.
  pendingClaimsPageUrl: string | null;
  // Process-wide browser ownership, distinct from the durable team ledger.
  browserLedger: Ledger;
}
const fail = (code: string): never => { throw new Error(code); };
function safeState(state: NativeState, config: GuardedNativeConfig, now: Date): SeasonSnapshot {
  const s = validateSnapshot(state.snapshot, config.execution, now);
  const nativeTime = Date.parse(state.nativeCapturedAt ?? s.capturedAt);
  if (!Number.isFinite(nativeTime) || nativeTime < Date.parse(s.capturedAt) || nativeTime > now.getTime() || now.getTime() - nativeTime > config.execution.maxAgeMs) fail("invalid_native_capture_time");
  const capturedWindow = state.capture.match(/^\d+ standard window [^\n]*?\bID: ([^,\n]+)/m)?.[1];
  if (!state.observationId || !config.windowId || capturedWindow !== config.windowId || state.windowId !== config.windowId || state.profileId !== config.profileId ||
      !verifyNativeTeamCapture(state.capture, { ...config.execution, teamName: config.teamName })) fail("native_identity_unverified");
  return s;
}
function deadline(state: NativeState, action: Action, now: Date): void {
  const deadlines = action.kind === "set_lineup" ? state.lineupDeadlines : state.acquisitionDeadlines;
  const ids = action.kind === "set_lineup" ? state.snapshot.roster.filter(p =>
    (Object.entries(action.lineup).find(([, id]) => id === p.id)?.[0] ?? null) !== p.slot).map(p => p.id) : [action.addId, action.dropId];
  for (const id of ids) {
    const end = Date.parse(deadlines[id] ?? "");
    if (!Number.isFinite(end) || end <= now.getTime()) fail("player_deadline_closed_or_unknown");
  }
}
function approval(config: GuardedNativeConfig, actionId: string, now: Date): void {
  // This implementation slice cannot be used for the competitive league, even
  // if a caller toggles its write flag or supplies a fabricated test approval.
  if (config.execution.leagueId === "425299") fail("real_team_writes_disabled");
  const a = config.approval;
  if (!a || a.context !== "disposable" || !a.approvalReference.trim() || !a.isolatedSessionVerified || !a.recoveryVerified ||
      a.leagueId !== config.execution.leagueId || a.teamId !== config.execution.teamId || a.profileId !== config.profileId ||
      a.actionId !== actionId || !Number.isFinite(Date.parse(a.expiresAt)) || Date.parse(a.expiresAt) <= now.getTime()) fail("disposable_approval_required");
}

export async function runGuardedNativeAction(original: SeasonSnapshot, decision: Decision, config: GuardedNativeConfig,
  transport: NativeTransport, ledger: Ledger, clock: () => Date = () => new Date()): Promise<ExecutionReceipt> {
  if (decision.kind === "no_action") return { status: "no_action", code: decision.reason };
  const actionId = actionFingerprint(original, decision);
  try { approval(config, actionId, clock()); }
  catch (e) { return { status: "blocked", code: (e as Error).message }; }
  let fresh: NativeState | undefined;
  let freshSnapshotHash: string | undefined;
  let latestObservationId: string | undefined;
  let commitStarted = false;
  const stopped = async () => (await readStop(config.emergencyStopPath)) !== "clear";
  try {
    return await config.browserLedger.exclusive("yahoo-native-browser", async () => executeDecision(original, decision, config.execution, {
      stopped,
      async read() {
        if (await stopped()) fail("emergency_stop");
        fresh = await transport.read();
        latestObservationId = fresh.observationId;
        const snapshot = safeState(fresh, config, clock());
        freshSnapshotHash = snapshot.hash;
        deadline(fresh, decision, clock());
        return snapshot;
      },
      async submit(action) {
        if (!fresh) fail("fresh_native_read_required");
        const prepared = await transport.prepare(action, fresh!);
        const beforeCommit = async () => {
          if (await stopped()) fail("emergency_stop");
          const now = clock();
          approval(config, actionId, now);
          if (!executionCapabilityAllowed(config.execution, original, action, now)) fail("capability_unverified");
          safeState(fresh!, config, now);
          deadline(fresh!, action, now);
          if (!validateAction({ actionId, kind: action.kind, teamId: config.execution.teamId, submittedAt: now.toISOString() },
            { now: now.toISOString(), ownedTeamId: config.execution.teamId, policy: config.execution.policy }).ok) fail("outside_action_window");
          if (fresh!.snapshot.hash !== freshSnapshotHash || validateDecision(fresh!.snapshot, action).length || !prepared.atomic || prepared.actionId !== actionId ||
              prepared.observationId !== fresh!.observationId || prepared.snapshotHash !== fresh!.snapshot.hash ||
              !/^[a-f0-9]{64}$/.test(prepared.controlsEvidenceHash) || !Number.isFinite(Date.parse(prepared.expiresAt)) || Date.parse(prepared.expiresAt) <= now.getTime()) fail("unverified_native_controls");
        };
        await beforeCommit();
        // The ledger is already pending. Any transport exception thereafter is
        // uncertain and must be reconciled without another submission.
        commitStarted = true;
        await transport.commit(prepared, beforeCommit);
      },
      async verify(action) {
        if (await stopped()) return "unknown";
        const requestedAt = clock().getTime();
        const readback = await transport.readback(), state = readback.state;
        const snapshot = safeState(state, config, clock());
        if (snapshot.period !== original.period || state.observationId === latestObservationId || Date.parse(state.nativeCapturedAt ?? snapshot.capturedAt) < requestedAt ||
          Date.parse(snapshot.capturedAt) < Date.parse(fresh?.snapshot.capturedAt ?? original.capturedAt)) return "unknown";
        if (action.kind === "set_lineup") {
          const beforeIds = original.roster.map(p => p.id).sort(), afterIds = snapshot.roster.map(p => p.id).sort();
          return digest(beforeIds) === digest(afterIds) && snapshot.period === original.period && snapshot.slots.length === original.slots.length &&
            snapshot.slots.every(s => snapshot.roster.find(p => p.slot === s.id)?.id === action.lineup[s.id]) ? "applied" : "unknown";
        }
        if (action.kind === "add_drop") {
          const expected = original.roster.filter(p => p.id !== action.dropId).map(p => p.id).concat(action.addId).sort();
          return snapshot.period === original.period && digest(snapshot.roster.map(p => p.id).sort()) === digest(expected) ? "applied" : "unknown";
        }
        const age = clock().getTime() - Date.parse(readback.pendingClaimsCapturedAt ?? "");
        if (!readback.pendingClaimsNormalized || !readback.pendingClaimsCapture || !Number.isFinite(age) || age < 0 || age > config.execution.maxAgeMs ||
          Date.parse(readback.pendingClaimsCapturedAt!) < requestedAt || readback.pendingClaimsSourceHash !== digest(readback.pendingClaimsCapture)) return "unknown";
        const expected = config.pendingClaimsPageUrl;
        const teamUrl = `football.fantasysports.yahoo.com/f1/${original.leagueId}/${original.teamId}`;
        const page = readback.pendingClaimsCapture.match(/^\s*\d+ HTML content Description: [^\n]+, URL: ([^\n]+)$/m)?.[1];
        const owners = [...readback.pendingClaimsCapture.matchAll(/^\s*\d+ link My Team, Value: ([^\n]+)$/gm)];
        if (!expected || !expected.startsWith(teamUrl + "/") || expected.includes("?") || page !== expected || !owners.length || owners.some(m => m[1] !== teamUrl)) return "unknown";
        return readback.pendingClaims.some(c => c.id && c.leagueId === original.leagueId && c.teamId === original.teamId && c.period === original.period && c.addId === action.addId && c.dropId === action.dropId) ? "applied" : "unknown";
      }
    }, ledger, clock));
  } catch {
    return { status: commitStarted ? "uncertain" : "blocked", code: commitStarted ? "native_browser_release_uncertain" : "native_browser_preflight_failed", actionId };
  }
}
