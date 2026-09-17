import { validateAction, type LeaguePolicy } from "../core/policy.js";
import { digest, validateDecision, validateSnapshot, type Binding, type Decision, type SeasonSnapshot } from "../manager/season.js";

export interface ExecutionConfig extends Binding {
  writesEnabled: boolean;
  releaseSha: string;
  runningSha: string;
  verifiedCapabilities: Array<"set_lineup" | "waiver_claim" | "add_drop">;
  // First live acceptance proof is explicitly authorized, not falsely labelled
  // as an already verified capability. Normal production runs omit this grant.
  acceptanceTest?: {
    leagueId: string;
    teamId: string;
    actionId: string;
    expiresAt: string;
    approvalReference: string;
  };
  policy: LeaguePolicy;
}
export interface LedgerEntry {
  // not_applied is an operator reconciliation with retained independent
  // evidence. The executor never infers it from a timeout or failed read.
  status: "pending" | "verified" | "uncertain" | "not_applied";
  reconciliationReference?: string;
  actionId: string;
  updatedAt: string;
  scope?: string;
}
export interface Ledger {
  // Exclusive ownership must span read, submit and verification, across processes.
  exclusive<T>(scope: string, run: () => Promise<T>): Promise<T>;
  get(actionId: string): Promise<LedgerEntry | null>;
  put(entry: LedgerEntry): Promise<void>;
  hasUnresolved(scope: string, exceptActionId: string): Promise<boolean>;
}
export interface Executor {
  read(): Promise<unknown>;
  stopped(): Promise<boolean>;
  submit(decision: Exclude<Decision, { kind: "no_action" }>): Promise<void>;
  // A fresh independent platform read, not the click/submit response.
  verify(decision: Exclude<Decision, { kind: "no_action" }>): Promise<"applied" | "not_applied" | "unknown">;
}
export interface ExecutionReceipt {
  status: "no_action" | "blocked" | "already_verified" | "verified" | "uncertain";
  code: string;
  actionId?: string;
}

export function actionFingerprint(snapshot: SeasonSnapshot, decision: Decision): string {
  const action = decision.kind === "set_lineup" ? { kind: decision.kind, lineup: decision.lineup } :
    decision.kind === "no_action" ? decision : { kind: decision.kind, addId: decision.addId, dropId: decision.dropId };
  // No timestamp, snapshot hash or rationale: duplicate triggers retain identity.
  return digest({ league: snapshot.leagueId, team: snapshot.teamId, period: snapshot.period, action });
}

export function executionCapabilityAllowed(config: ExecutionConfig, snapshot: SeasonSnapshot, decision: Decision, now: Date): boolean {
  if (decision.kind === "no_action" || config.verifiedCapabilities.includes(decision.kind)) return true;
  const grant = config.acceptanceTest;
  return !!grant && config.leagueId !== "425299" && grant.leagueId === config.leagueId && grant.teamId === config.teamId &&
    grant.actionId === actionFingerprint(snapshot, decision) && !!grant.approvalReference?.trim() &&
    Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > now.getTime();
}

export async function executeDecision(
  original: SeasonSnapshot, decision: Decision, config: ExecutionConfig, executor: Executor, ledger: Ledger,
  clock: () => Date = () => new Date()
): Promise<ExecutionReceipt> {
  if (decision.kind === "no_action") return { status: "no_action", code: decision.reason };
  const block = (code: string): ExecutionReceipt => ({ status: "blocked", code });
  let attemptedActionId: string | undefined;
  try {
    validateSnapshot(original, config, clock());
    if (!config.writesEnabled) return block("writes_disabled");
    if (!/^[a-f0-9]{40}$/.test(config.releaseSha) || config.releaseSha !== config.runningSha) return block("release_mismatch");
    const capabilityAllowed = (now: Date) => executionCapabilityAllowed(config, original, decision, now);
    if (!capabilityAllowed(clock())) return block("capability_unverified");
    const invalid = validateDecision(original, decision);
    if (invalid.length) return block(invalid[0]!);
    const scope = `${config.leagueId}:${config.teamId}`;
    return await ledger.exclusive(scope, async () => {
      if (await executor.stopped()) return block("emergency_stop");
      const actionId = actionFingerprint(original, decision);
      const previous = await ledger.get(actionId);
      if (previous?.status === "verified") return { status: "already_verified", code: "duplicate_trigger", actionId };
      // A process crash or uncertain submission is reconciled, never resubmitted.
      if (previous && previous.status !== "not_applied") {
        let state: "applied" | "not_applied" | "unknown" = "unknown";
        try { state = await executor.verify(decision); } catch { /* keep uncertain */ }
        if (state === "applied") {
          await ledger.put({ actionId, scope, status: "verified", updatedAt: clock().toISOString() });
          return { status: "verified", code: "reconciled_without_resubmission", actionId };
        }
        return { status: "uncertain", code: "manual_reconciliation_required", actionId };
      }
      if (previous?.status === "not_applied" && !previous.reconciliationReference?.trim()) return block("reconciliation_evidence_required");
      if (await ledger.hasUnresolved(scope, actionId)) return block("unresolved_team_action");
      const current = validateSnapshot(await executor.read(), config, clock());
      // Fresh reads necessarily have new capture times. Compare decision-bearing
      // state, while validating the timestamp and integrity of each read above.
      const stateHash = ({ hash: _hash, capturedAt: _time, ...state }: SeasonSnapshot) => digest(state);
      if (stateHash(current) !== stateHash(original)) return block("state_changed_replan_required");
      const now = clock().toISOString();
      const validation = validateAction({ actionId, kind: decision.kind, teamId: config.teamId, submittedAt: now },
        { now, ownedTeamId: config.teamId, policy: config.policy });
      if (!validation.ok) return block(validation.issues[0]!.code);
      if (await executor.stopped()) return block("emergency_stop");
      await ledger.put({ actionId, scope, status: "pending", updatedAt: now });
      // Native startup, stop checks or ledger persistence can consume the window.
      // Revalidate synchronously after the final awaited check, immediately before submit.
      if (await executor.stopped()) return block("emergency_stop");
      const submitTime = clock();
      if (!capabilityAllowed(submitTime)) return block("capability_unverified");
      try { validateSnapshot(current, config, submitTime); }
      catch { return block("snapshot_expired_before_submission"); }
      const finalWindow = validateAction({ actionId, kind: decision.kind, teamId: config.teamId,
        submittedAt: submitTime.toISOString() }, { now: submitTime.toISOString(), ownedTeamId: config.teamId, policy: config.policy });
      if (!finalWindow.ok) return block(finalWindow.issues[0]!.code);
      attemptedActionId = actionId;
      try { await executor.submit(decision); } catch { /* submit may have succeeded; read back once */ }
      let state: "applied" | "not_applied" | "unknown" = "unknown";
      try { state = await executor.verify(decision); } catch { /* fail closed */ }
      const status = state === "applied" ? "verified" : "uncertain";
      await ledger.put({ actionId, scope, status, updatedAt: clock().toISOString() });
      return { status, code: state === "applied" ? "independent_readback_passed" : "submission_not_verified", actionId };
    });
  } catch {
    // Never copy browser/transport exceptions into receipts: they may carry private data.
    return attemptedActionId ? { status: "uncertain", code: "execution_outcome_uncertain", actionId: attemptedActionId } : block("execution_preflight_failed");
  }
}
