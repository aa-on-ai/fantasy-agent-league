import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "../manager/season.js";
import { codexDecisionInstructions, validateManagerContext, validateManagerPacket, type ManagerBinding, type ManagerContext, type ManagerPacket } from "../manager/codex-run.js";
import { type ExecutionReceipt, type Ledger } from "../execution/coordinator.js";
import { runGuardedNativeAction, type GuardedNativeConfig, type NativeTransport } from "../platforms/yahoo/guarded-native.js";
import { readStop } from "./native-read-proof.js";
import { runGuardedOwnedAction, type GuardedOwnedConfig, type OwnedTransport } from "../platforms/yahoo/guarded-owned.js";
import { ParticipantOutcomeWriter, captureOwnedOutcomes, sanitizedOwnedOutcome,
  type OutcomeMemoryReceipt, type OwnedOutcomeCapture } from "./participant-outcome.js";

export interface SeasonRunOptions {
  context: ManagerContext;
  binding: ManagerBinding;
  emergencyStopPath: string;
  receiptDirectory: string;
  // The admitted Codex runtime supplies judgment. No model, credentials or
  // alternate browser route is started from inside the deterministic executor.
  decide: (request: { instructions: string; context: Readonly<ManagerContext> }) => Promise<unknown>;
  mode: "review" | "execute";
  native?: { config: GuardedNativeConfig; transport: NativeTransport; ledger: Ledger };
  owned?: { config: GuardedOwnedConfig; transport: OwnedTransport; ledger: Ledger };
  // Required by the persistent owned runtime. Omitted only by legacy/offline hosts.
  participantDirectory?: string;
  clock?: () => Date;
}
export interface SeasonRunReceipt {
  schemaVersion: 1;
  attemptId: string;
  runId: string | null;
  contextHash: string | null;
  packetHash: string | null;
  mode: "review" | "execute";
  status: "reviewed" | "blocked" | ExecutionReceipt["status"];
  code: string;
  // Uncertain means we cannot honestly assert either true or false.
  applied: boolean | null;
  createdAt: string;
  execution: ExecutionReceipt | null;
  memory?: OutcomeMemoryReceipt;
}

export async function runSeasonManager(options: SeasonRunOptions): Promise<SeasonRunReceipt> {
  const clock = options.clock ?? (() => new Date());
  const attemptId = randomUUID();
  let context: ManagerContext | undefined, packet: ManagerPacket | undefined;
  let execution: ExecutionReceipt | null = null;
  let executionStarted = false;
  let memory: ParticipantOutcomeWriter | undefined;
  let memoryReceipt: OutcomeMemoryReceipt | undefined;
  let ownedCapture: OwnedOutcomeCapture | undefined;
  let status: SeasonRunReceipt["status"] = "blocked", code = "manager_preflight_failed";
  // Durable packet persistence is a prerequisite to touching Yahoo. A failed
  // final receipt write throws; it cannot turn a possible action into a pass.
  await mkdir(options.receiptDirectory, { recursive: true, mode: 0o700 });
  try {
    if (!["review", "execute"].includes(options.mode)) throw new Error("invalid_run_mode");
    if (await readStop(options.emergencyStopPath) !== "clear") throw new Error("emergency_stop");
    context = structuredClone(validateManagerContext(options.context, options.binding, clock()));
    if (options.participantDirectory) {
      try { memory = await ParticipantOutcomeWriter.open(options.participantDirectory, context, options.mode); }
      catch { throw new Error("participant_memory_unavailable"); }
    }
    if (options.mode === "execute") {
      const executor = options.native ?? options.owned;
      if ((options.native && options.owned) || !executor || executor.config.emergencyStopPath !== options.emergencyStopPath ||
        executor.config.execution.leagueId !== context.snapshot.leagueId || executor.config.execution.teamId !== context.snapshot.teamId ||
        executor.config.execution.maxAgeMs !== options.binding.maxAgeMs || digest(executor.config.execution.policy) !== digest(context.policy))
        throw new Error("native_execution_binding_missing_or_conflicting");
    }
    // The model sees its own immutable copy. Mutating it does not mutate the
    // validator's source truth. Model output never selects transport/config.
    const proposed = await options.decide({ instructions: codexDecisionInstructions(context), context: structuredClone(context) });
    if (await readStop(options.emergencyStopPath) !== "clear") throw new Error("emergency_stop");
    packet = structuredClone(validateManagerPacket(proposed, context, options.binding, clock()));
    const decisionPath = join(options.receiptDirectory, `${attemptId}.decision.json`), validatedAt = clock().toISOString();
    await writeFile(decisionPath,
      JSON.stringify({ context, packet, validatedAt, executed: false }) + "\n", { flag: "wx", mode: 0o600, flush: true });
    if (memory) {
      try { await memory.recordProposal(packet, decisionPath, validatedAt); }
      catch {
        memoryReceipt = { status: "failed", proposalEventId: memory.proposalEventId, outcomeEventIds: [], actionAttributed: false };
        throw new Error("participant_proposal_persistence_failed");
      }
    }
    // Re-check after awaited persistence. Expiry never causes baseline fallback
    // or another model turn in the same run.
    if (await readStop(options.emergencyStopPath) !== "clear") throw new Error("emergency_stop");
    validateManagerPacket(packet, context, options.binding, clock());
    if (options.mode === "review") { status = "reviewed"; code = "manager_packet_validated_not_executed"; }
    else {
      executionStarted = true;
      if (options.owned) {
        const o = options.owned;
        const wrapped = memory ? captureOwnedOutcomes(o.transport, clock) : undefined;
        ownedCapture = wrapped?.capture;
        execution = await runGuardedOwnedAction(context.snapshot, packet.rankedActions[0]!.decision, o.config, wrapped?.transport ?? o.transport, o.ledger, clock);
      } else {
        const n = options.native!;
        execution = await runGuardedNativeAction(context.snapshot, packet.rankedActions[0]!.decision, n.config, n.transport, n.ledger, clock);
      }
      status = execution.status; code = execution.code;
    }
  } catch (error) {
    // Only allowlisted deterministic codes. Never copy model/transport/source
    // exception strings into user-visible receipts or logs.
    const allowed = new Set(["invalid_run_mode", "emergency_stop", "invalid_manager_context", "wrong_team", "stale_snapshot",
      "snapshot_hash_mismatch", "context_hash_mismatch", "invalid_manager_source", "stale_manager_source", "missing_manager_source",
      "incomplete_player_evidence", "manager_window_closed", "invalid_manager_packet", "stale_manager_packet", "unresolved_manager_constraints",
      "invalid_ranked_action", "illegal_manager_action", "lineup_projection_mismatch", "duplicate_ranked_action", "ambiguous_no_action",
      "native_execution_binding_missing_or_conflicting", "repository_contract_mismatch", "no_action_lineup_invalid",
      "native_task_cancelled", "native_task_window_closed", "participant_memory_unavailable", "participant_proposal_persistence_failed"]);
    code = error instanceof Error && allowed.has(error.message) ? error.message : "manager_run_failed";
    if (executionStarted) { status = "uncertain"; code = "execution_outcome_uncertain"; }
  }
  const receipt: SeasonRunReceipt = { schemaVersion: 1, attemptId, runId: context?.runId ?? null, contextHash: context?.contextHash ?? null,
    packetHash: packet ? digest(packet) : null, mode: options.mode, status, code,
    applied: status === "uncertain" ? null : ["verified", "already_verified"].includes(status), createdAt: clock().toISOString(), execution };
  if (memory) {
    // Preserve the exact runtime outcome and actual normalized capture even if
    // canonical memory fails afterward. No retry or successful completion is
    // inferred from an action that may already have been submitted.
    const outcomePath = join(options.receiptDirectory, `${attemptId}.outcome.json`);
    await writeFile(outcomePath, JSON.stringify({ receipt, ownedEvidence: sanitizedOwnedOutcome(ownedCapture) }) + "\n",
      { flag: "wx", mode: 0o600, flush: true });
    try {
      const recorded = await memory.recordOutcome(structuredClone(receipt), outcomePath, ownedCapture);
      memoryReceipt = memoryReceipt?.status === "failed" ? { ...recorded, status: "failed" } : recorded;
    } catch {
      memoryReceipt = { status: "failed", proposalEventId: memory.proposalEventId, outcomeEventIds: [], actionAttributed: false };
      receipt.status = executionStarted && execution?.status !== "blocked" && execution?.status !== "no_action" ? "uncertain" : "blocked";
      receipt.code = code === "participant_proposal_persistence_failed" ? code : "participant_outcome_persistence_failed";
      receipt.applied = receipt.status === "uncertain" ? null : false;
    }
    receipt.memory = memoryReceipt;
  } else if (options.participantDirectory && code === "participant_memory_unavailable") {
    receipt.memory = { status: "failed", proposalEventId: null, outcomeEventIds: [], actionAttributed: false };
  }
  await writeFile(join(options.receiptDirectory, `${attemptId}.receipt.json`), JSON.stringify(receipt) + "\n", { flag: "wx", mode: 0o600, flush: true });
  return receipt;
}
