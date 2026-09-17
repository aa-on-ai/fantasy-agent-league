import { readFile, writeFile, mkdir, lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "../manager/season.js";
import { managerContextHash, validateManagerContext, type ManagerContext, type ManagerPhase } from "../manager/codex-run.js";
import { loadManagerIdentity } from "../manager/identity.js";
import { buildManagerContinuityContext, loadSeasonMemory } from "../manager/season-memory.js";
import type { OwnedAssessment, OwnedBinding } from "../platforms/yahoo/owned-sources.js";
import type { GuardedOwnedConfig, OwnedTransport } from "../platforms/yahoo/guarded-owned.js";
import type { Ledger } from "../execution/coordinator.js";
import { runSeasonManager, type SeasonRunOptions, type SeasonRunReceipt } from "./season-run.js";
import { readStop } from "./native-read-proof.js";

export interface OwnedSeasonEvent { id: string; phase: ManagerPhase; opensAt: string; closesAt: string }
export interface OwnedSeasonTaskOptions {
  event: OwnedSeasonEvent;
  repositoryRoot: string;
  privateDirectory: string;
  binding: OwnedBinding;
  mode: "review" | "execute";
  collect(checkpoint: () => Promise<void>): Promise<OwnedAssessment>;
  decide: SeasonRunOptions["decide"];
  execution: GuardedOwnedConfig;
  transport: OwnedTransport;
  ledger: Ledger;
  // Optional host-owned maintenance/proof stops. The real stop is always checked.
  additionalStopPaths?: readonly string[];
  clock?: () => Date;
}
export interface OwnedSeasonTaskReceipt {
  schemaVersion: 1;
  eventId: string;
  eventHash: string;
  leagueId: string;
  teamId: string;
  mode: "review" | "execute";
  route: "owned_chrome";
  status: "reviewed" | "verified" | "no_action" | "blocked" | "uncertain";
  code: string;
  checkedAt: string;
  duplicate: boolean;
  managementCompleted: boolean;
  sourceGaps: string[];
  manager: SeasonRunReceipt | null;
}

/** One scheduler occurrence, one durable identity, one browser lease and at most one decision. */
export async function runOwnedSeasonTask(options: OwnedSeasonTaskOptions): Promise<OwnedSeasonTaskReceipt> {
  const clock = options.clock ?? (() => new Date());
  const event = structuredClone(options.event), binding = structuredClone(options.binding);
  const config = options.execution;
  const additionalStopPaths = [...(options.additionalStopPaths ?? [])];
  if (!event.id?.trim() || event.id.length > 200 || !["lineup", "free_agents", "waivers"].includes(event.phase) ||
      !["review", "execute"].includes(options.mode) || !Number.isFinite(Date.parse(event.opensAt)) ||
      !Number.isFinite(Date.parse(event.closesAt)) || Date.parse(event.opensAt) >= Date.parse(event.closesAt)) throw new Error("invalid_owned_event");
  if (!/^\d+$/.test(binding.leagueId) || !/^\d+$/.test(binding.teamId) || binding.profileId !== config.profileId ||
      binding.leagueId !== config.execution.leagueId || binding.teamId !== config.execution.teamId ||
      binding.maxAgeMs !== config.execution.maxAgeMs) throw new Error("owned_task_binding_conflict");
  const eventHash = digest({ event, binding, mode: options.mode, execution: config.execution });
  const directory = join(options.privateDirectory, "owned-scheduled-runs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("unsafe_owned_receipt_path");
  const key = digest({ id: event.id, leagueId: binding.leagueId, teamId: binding.teamId });
  const startedPath = join(directory, `${key}.started.json`), receiptPath = join(directory, `${key}.receipt.json`);
  const base = { schemaVersion: 1 as const, eventId: event.id, eventHash, leagueId: binding.leagueId, teamId: binding.teamId,
    mode: options.mode, route: "owned_chrome" as const };
  try {
    await writeFile(startedPath, JSON.stringify(base) + "\n", { flag: "wx", mode: 0o600, flush: true });
    const parent = await open(directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const prior = JSON.parse(await readFile(startedPath, "utf8"));
    if (prior.eventHash !== eventHash) throw new Error("owned_occurrence_conflict");
    try {
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as OwnedSeasonTaskReceipt;
      if (receipt.schemaVersion !== 1 || typeof receipt.code !== "string" || !receipt.code.trim() ||
          !Array.isArray(receipt.sourceGaps) || receipt.sourceGaps.some(g => typeof g !== "string") ||
          typeof receipt.duplicate !== "boolean" || typeof receipt.managementCompleted !== "boolean" ||
          receipt.managementCompleted !== (options.mode === "execute" && ["verified", "no_action"].includes(receipt.status)) ||
          (["verified", "no_action", "reviewed"].includes(receipt.status) && !validManagerReceipt(receipt.manager, receipt)) ||
          receipt.eventHash !== eventHash || receipt.eventId !== event.id || receipt.teamId !== binding.teamId ||
          receipt.leagueId !== binding.leagueId || receipt.route !== "owned_chrome" || receipt.mode !== options.mode ||
          !["reviewed", "verified", "no_action", "blocked", "uncertain"].includes(receipt.status) ||
          !Number.isFinite(Date.parse(receipt.checkedAt))) throw new Error("invalid_owned_receipt");
      return { ...receipt, duplicate: true };
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError;
      return { ...base, checkedAt: clock().toISOString(), status: options.mode === "execute" ? "uncertain" : "blocked", code: "interrupted_occurrence_requires_inspection",
        duplicate: true, managementCompleted: false, sourceGaps: [], manager: null };
    }
  }
  let managerInvocationStarted = false;
  let manager: SeasonRunReceipt | null = null, sourceGaps: string[] = [];
  let status: OwnedSeasonTaskReceipt["status"] = "blocked", code = "owned_task_preflight_failed";
  const checkpoint = async () => {
    if (await readStop(config.emergencyStopPath) !== "clear") throw new Error("emergency_stop");
    for (const path of additionalStopPaths) if (await readStop(path) !== "clear") throw new Error("emergency_stop");
    const now = clock().getTime();
    if (now < Date.parse(event.opensAt) || now >= Date.parse(event.closesAt)) throw new Error("owned_task_window_closed");
  };
  try {
    await checkpoint();
    const participant = join(options.privateDirectory, "participant");
    const identity = await loadManagerIdentity(participant, { platform: "yahoo", leagueId: binding.leagueId, teamId: binding.teamId });
    if (!identity) throw new Error("participant_not_initialized");
    const continuity = buildManagerContinuityContext(identity, await loadSeasonMemory(participant, identity));
    await config.browserLedger.exclusive(`yahoo-owned-browser:${binding.profileId}`, async () => {
      const assessment = await options.collect(checkpoint);
      await checkpoint();
      sourceGaps = assessment.gaps;
      if (!assessment.snapshot || !assessment.readiness[event.phase]) throw new Error("owned_sources_incomplete");
      const [strategyText, contractText] = await Promise.all([
        readFile(join(options.repositoryRoot, "agents/steady-manager.md"), "utf8"),
        readFile(join(options.repositoryRoot, "agents/manager-contract.md"), "utf8"),
      ]);
      const body: Omit<ManagerContext, "contextHash"> = { schemaVersion: 1, runId: event.id, phase: event.phase, strategy: "steady",
        strategyText, contractText, snapshot: assessment.snapshot, sources: assessment.sources,
        policy: structuredClone(config.execution.policy), continuity };
      const context = { ...body, contextHash: managerContextHash(body) };
      const managerBinding = { ...binding, strategyHash: digest(strategyText), contractHash: digest(contractText) };
      validateManagerContext(context, managerBinding, clock());
      let borrowed = true;
      const borrowedLedger: Ledger = { exclusive: async (scope, run) => {
        if (!borrowed || scope !== `yahoo-owned-browser:${binding.profileId}`) throw new Error("invalid_owned_lease");
        return run();
      }, get: id => config.browserLedger.get(id), put: entry => config.browserLedger.put(entry),
        hasUnresolved: (scope, id) => config.browserLedger.hasUnresolved(scope, id) };
      try {
        managerInvocationStarted = true;
        manager = await runSeasonManager({ context, binding: managerBinding, mode: options.mode, clock,
          emergencyStopPath: config.emergencyStopPath, receiptDirectory: join(directory, `${key}-manager`),
          participantDirectory: participant,
          decide: async request => { await checkpoint(); const packet = await options.decide(request); await checkpoint(); return packet; },
          owned: { config: { ...config, browserLedger: borrowedLedger }, transport: options.transport, ledger: options.ledger } });
        status = manager.status === "already_verified" ? "verified" : manager.status;
        code = manager.code;
      } finally { borrowed = false; }
    });
  } catch (error) {
    status = options.mode === "execute" && managerInvocationStarted ? "uncertain" : "blocked";
    const allowed = ["emergency_stop", "participant_not_initialized", "owned_task_window_closed", "owned_sources_incomplete", "wrong_team", "stale_snapshot",
      "invalid_manager_context", "stale_manager_source", "incomplete_player_evidence", "manager_window_closed"];
    code = error instanceof Error && allowed.includes(error.message) ? error.message : "owned_task_failed";
  }
  const receipt: OwnedSeasonTaskReceipt = { ...base, status, code, checkedAt: clock().toISOString(), duplicate: false,
    managementCompleted: options.mode === "execute" && ["verified", "no_action"].includes(status), sourceGaps, manager };
  await writeFile(receiptPath, JSON.stringify(receipt) + "\n", { flag: "wx", mode: 0o600, flush: true });
  return receipt;
}

function validManagerReceipt(manager: SeasonRunReceipt | null, task: OwnedSeasonTaskReceipt): boolean {
  if (!manager || manager.schemaVersion !== 1 || !manager.attemptId || manager.runId !== task.eventId ||
      manager.mode !== task.mode || !/^[a-f0-9]{64}$/.test(manager.contextHash ?? "") ||
      !/^[a-f0-9]{64}$/.test(manager.packetHash ?? "") || !Number.isFinite(Date.parse(manager.createdAt)) ||
      typeof manager.code !== "string" || !manager.code.trim()) return false;
  const status = manager.status === "already_verified" ? "verified" : manager.status;
  if (status !== task.status || task.code !== manager.code) return false;
  if (task.status === "reviewed") return task.mode === "review" && manager.applied === false && manager.execution === null;
  if (task.mode !== "execute" || manager.execution?.status !== manager.status || manager.execution.code !== manager.code) return false;
  return task.status === "verified" ? manager.applied === true && /^[a-f0-9]{64}$/.test(manager.execution.actionId ?? "") : manager.applied === false;
}
