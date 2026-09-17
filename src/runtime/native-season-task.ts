import { readFile, writeFile, mkdir, lstat, open } from "node:fs/promises";
import { join, dirname } from "node:path";
import { digest } from "../manager/season.js";
import { loadManagerIdentity } from "../manager/identity.js";
import { buildManagerContinuityContext, loadSeasonMemory } from "../manager/season-memory.js";
import { managerContextHash, validateManagerContext, type ManagerContext, type ManagerPhase,
  type ManagerSource } from "../manager/codex-run.js";
import { type LeaguePolicy } from "../core/policy.js";
import { type Ledger } from "../execution/coordinator.js";
import { FileLedger } from "../execution/file-ledger.js";
import { YahooNativeDriver, type NativeDesktopApp, type NativeDriverOptions } from "../platforms/yahoo/native-driver.js";
import { type NativeState, type GuardedNativeConfig, type NativeTransport } from "../platforms/yahoo/guarded-native.js";
import { type DesktopBinding } from "../platforms/yahoo/desktop-season.js";
import { runSeasonManager, type SeasonRunOptions, type SeasonRunReceipt } from "./season-run.js";
import { readStop, verifyNativeTeamCapture } from "./native-read-proof.js";

export interface NativeSeasonEvent {
  // The scheduler supplies a stable occurrence ID, not a new ID on every retry.
  id: string;
  phase: ManagerPhase;
  opensAt: string;
  closesAt: string;
}
export interface NativeSeasonSources {
  state: NativeState;
  sources: ManagerSource[];
}
export interface NativeSeasonTaskOptions {
  event: NativeSeasonEvent;
  repositoryRoot: string;
  privateDirectory: string;
  binding: DesktopBinding;
  policy: LeaguePolicy;
  mode: "review" | "execute";
  app: NativeDesktopApp;
  // Source and native normalization are trusted host producers. The scheduled
  // desktop task must implement them from actual captures, never from a model's
  // unsupported assertions, old fixtures, or copied observation timestamps.
  collect(checkpoint: () => Promise<void>): Promise<NativeSeasonSources>;
  decide: SeasonRunOptions["decide"];
  driver: Omit<NativeDriverOptions, "binding" | "allowSubmission" | "clock" | "emergencyStopPath">;
  execution: Omit<GuardedNativeConfig, "browserLedger" | "emergencyStopPath">;
  emergencyStopPath: string;
  clock?: () => Date;
}
export interface NativeSeasonTaskReceipt {
  schemaVersion: 1;
  eventId: string;
  eventHash: string;
  teamId: string;
  leagueId: string;
  mode: "review" | "execute";
  status: "reviewed" | "no_action" | "verified" | "blocked" | "uncertain";
  code: string;
  checkedAt: string;
  // A repeated trigger returns the previous terminal result without rerunning.
  duplicate: boolean;
  managementCompleted: boolean;
  manager: SeasonRunReceipt | null;
}

export type NativeSeasonTaskStep =
  | { kind: "decision_requested"; request: Parameters<SeasonRunOptions["decide"]>[0] }
  | { kind: "finished"; receipt: NativeSeasonTaskReceipt };

async function persist(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600, flush: true });
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

// The persistent desktop JavaScript tool cannot call its own model recursively.
// Start collection in one tool call, return the decision request to the admitted
// Codex turn, then submit its packet in the next call. The same process retains
// the browser lease. No second model, subprocess, file polling or credentials.
export function startNativeSeasonTask(options: Omit<NativeSeasonTaskOptions, "decide">): {
  next: Promise<NativeSeasonTaskStep>;
  completion: Promise<NativeSeasonTaskReceipt>;
  submit(packet: unknown): Promise<NativeSeasonTaskReceipt>;
  cancel(): Promise<NativeSeasonTaskReceipt>;
} {
  let resolveNext!: (step: NativeSeasonTaskStep) => void, rejectNext!: (error: Error) => void;
  let accept: ((packet: unknown) => void) | undefined, reject: ((error: Error) => void) | undefined;
  const next = new Promise<NativeSeasonTaskStep>((resolve, reject) => { resolveNext = resolve; rejectNext = reject; });
  const completion = runNativeSeasonTask({ ...options, decide: request => new Promise((resolve, rejectDecision) => {
    accept = resolve; reject = rejectDecision;
    resolveNext({ kind: "decision_requested", request: structuredClone(request) });
  }) }).then(receipt => {
    resolveNext({ kind: "finished", receipt }); return receipt;
  }, () => {
    const error = new Error("native_task_session_failed"); rejectNext(error); throw error;
  });
  // Callers may first await next; observing that promise must not cause the
  // separately exposed completion promise to become an unhandled rejection.
  void completion.catch(() => {});
  void next.catch(() => {});
  return { next, completion,
    submit(packet) {
      if (!accept) throw new Error("decision_not_requested_or_already_submitted");
      const value = structuredClone(packet), submit = accept;
      accept = undefined; reject = undefined; submit(value); return completion;
    },
    cancel() {
      if (!reject) throw new Error("no_pending_decision_to_cancel");
      const cancel = reject; accept = undefined; reject = undefined;
      cancel(new Error("native_task_cancelled")); return completion;
    },
  };
}

// The browser lease covers collection and reasoning as well as execution. The
// existing guard borrows that same lease; it cannot reenter arbitrary scopes.
function borrowedBrowserLease(ledger: Ledger): { ledger: Ledger; close(): void } {
  let active = true;
  return {
    close() { active = false; },
    ledger: {
      async exclusive<T>(scope: string, run: () => Promise<T>): Promise<T> {
        if (!active || scope !== "yahoo-native-browser") throw new Error("invalid_browser_lease");
        return run();
      },
      get: id => ledger.get(id), put: value => ledger.put(value),
      hasUnresolved: (scope, id) => ledger.hasUnresolved(scope, id),
    },
  };
}

export async function runNativeSeasonTask(options: NativeSeasonTaskOptions): Promise<NativeSeasonTaskReceipt> {
  const clock = options.clock ?? (() => new Date());
  const event = structuredClone(options.event), binding = structuredClone(options.binding);
  const policy = structuredClone(options.policy), execution = structuredClone(options.execution);
  const kind = { lineup: "set_lineup", free_agents: "add_drop", waivers: "waiver_claim" } as const;
  if (!event || !event.id?.trim() || event.id.length > 200 || !Object.hasOwn(kind, event.phase) ||
    !["review", "execute"].includes(options.mode) || !Number.isFinite(Date.parse(event.opensAt)) ||
    !Number.isFinite(Date.parse(event.closesAt)) || Date.parse(event.opensAt) >= Date.parse(event.closesAt))
    throw new Error("invalid_native_season_event");
  if (!/^\d+$/.test(binding.leagueId) || !/^\d+$/.test(binding.teamId) || !binding.teamName?.trim() ||
    execution.execution.leagueId !== binding.leagueId || execution.execution.teamId !== binding.teamId ||
    execution.execution.maxAgeMs !== binding.maxAgeMs || execution.teamName !== binding.teamName ||
    execution.profileId !== options.driver.profileId || execution.windowId !== options.driver.windowId ||
    digest(execution.execution.policy) !== digest(policy)) throw new Error("native_task_binding_conflict");
  const eventHash = digest({ event, binding, policy, mode: options.mode, execution });
  const directory = join(options.privateDirectory, "scheduled-runs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("unsafe_task_receipt_path");
  const key = digest({ eventId: event.id, leagueId: binding.leagueId, teamId: binding.teamId });
  const startedPath = join(directory, `${key}.started.json`), receiptPath = join(directory, `${key}.receipt.json`);
  const base = { schemaVersion: 1 as const, eventId: event.id, eventHash, teamId: binding.teamId,
    leagueId: binding.leagueId, mode: options.mode, checkedAt: clock().toISOString() };
  try {
    await persist(startedPath, base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const previous = JSON.parse(await readFile(startedPath, "utf8"));
    if (previous.eventHash !== eventHash) throw new Error("native_task_occurrence_conflict");
    try {
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as NativeSeasonTaskReceipt;
      if (receipt.schemaVersion !== 1 || receipt.eventHash !== eventHash || receipt.eventId !== event.id ||
        receipt.teamId !== binding.teamId || receipt.leagueId !== binding.leagueId || receipt.mode !== options.mode ||
        !["reviewed", "no_action", "verified", "blocked", "uncertain"].includes(receipt.status) ||
        typeof receipt.managementCompleted !== "boolean" || !Number.isFinite(Date.parse(receipt.checkedAt)))
        throw new Error("invalid_task_receipt");
      return { ...receipt, duplicate: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { ...base, status: "blocked", code: "interrupted_task_requires_inspection", duplicate: true,
        managementCompleted: false, manager: null };
    }
  }
  let manager: SeasonRunReceipt | null = null, status: NativeSeasonTaskReceipt["status"] = "blocked";
  let managerInvocationStarted = false;
  let code = "native_task_failed";
  const timeCheck = () => {
    const now = clock().getTime();
    if (!Number.isFinite(now) || now < Date.parse(event.opensAt) || now >= Date.parse(event.closesAt))
      throw new Error("native_task_window_closed");
  };
  const checkpoint = async () => {
    if (await readStop(options.emergencyStopPath) !== "clear") throw new Error("emergency_stop");
    timeCheck();
  };
  try {
    await checkpoint();
    const participant = join(options.privateDirectory, "participant");
    const identity = await loadManagerIdentity(participant, { platform: "yahoo", leagueId: binding.leagueId, teamId: binding.teamId });
    if (!identity) throw new Error("participant_not_initialized");
    const continuity = buildManagerContinuityContext(identity, await loadSeasonMemory(participant, identity));
    const browserLedger = new FileLedger(join(options.privateDirectory, "browser-ledger"));
    manager = await browserLedger.exclusive("yahoo-native-browser", async () => {
      const lease = borrowedBrowserLease(browserLedger);
      try {
        await checkpoint();
        const [strategyText, contractText] = await Promise.all([
          readFile(join(options.repositoryRoot, "agents/steady-manager.md"), "utf8"),
          readFile(join(options.repositoryRoot, "agents/manager-contract.md"), "utf8"),
        ]);
        const collected = structuredClone(await options.collect(checkpoint));
        await checkpoint();
        const nativeTime = Date.parse(collected.state.nativeCapturedAt ?? collected.state.snapshot.capturedAt);
        const nativeWindow = collected.state.capture.match(/^\d+ standard window [^\n]*?\bID: ([^,\n]+)/m)?.[1];
        if (collected.state.profileId !== execution.profileId || collected.state.windowId !== execution.windowId ||
          nativeWindow !== execution.windowId || !collected.state.observationId?.trim() ||
          !verifyNativeTeamCapture(collected.state.capture, binding) || !Number.isFinite(nativeTime) ||
          nativeTime < Date.parse(collected.state.snapshot.capturedAt) || nativeTime > clock().getTime() ||
          clock().getTime() - nativeTime > binding.maxAgeMs)
          throw new Error("native_task_binding_conflict");
        await persist(join(directory, key + ".sources.json"), collected);
        await checkpoint();
        const context: ManagerContext = { schemaVersion: 1, runId: event.id, phase: event.phase, strategy: "steady",
          strategyText, contractText, snapshot: collected.state.snapshot, sources: collected.sources, policy, continuity, contextHash: "" };
        context.contextHash = managerContextHash(context);
        const managerBinding = { ...binding, strategyHash: digest(strategyText), contractHash: digest(contractText) };
        validateManagerContext(context, managerBinding, clock());
        const nativeDriver = new YahooNativeDriver(options.app, { ...options.driver, binding,
          allowSubmission: execution.execution.writesEnabled, emergencyStopPath: options.emergencyStopPath, clock });
        const transport: NativeTransport = {
          async read() { await checkpoint(); const s = await nativeDriver.read(); await checkpoint(); return s; },
          async prepare(action, state) { await checkpoint(); const p = await nativeDriver.prepare(action, state); await checkpoint(); return p; },
          async commit(ticket, guard) {
            await nativeDriver.commit(ticket, async () => { await guard(); timeCheck(); });
          },
          // Readback must still be attempted after an action whose window has
          // just closed. Never abandon outcome reconciliation via Promise.race.
          readback: () => nativeDriver.readback(),
        };
        managerInvocationStarted = true;
        manager = await runSeasonManager({ context, binding: managerBinding, mode: options.mode,
          emergencyStopPath: options.emergencyStopPath, receiptDirectory: join(directory, key + ".manager"), clock,
          decide: async request => { await checkpoint(); const packet = await options.decide(request); await checkpoint(); return packet; },
          native: { config: { ...execution, browserLedger: lease.ledger, emergencyStopPath: options.emergencyStopPath },
            transport, ledger: new FileLedger(join(options.privateDirectory, "action-ledger")) },
        });
        return manager;
      } finally { lease.close(); }
    });
    status = manager.status === "already_verified" ? "verified" : manager.status;
    code = manager.code;
  } catch (error) {
    const allowed = ["emergency_stop", "participant_not_initialized", "native_task_window_closed", "native_task_binding_conflict", "wrong_team",
      "stale_snapshot", "invalid_manager_source", "stale_manager_source", "missing_manager_source", "incomplete_player_evidence",
      "manager_window_closed", "repository_contract_mismatch", "context_hash_mismatch", "snapshot_hash_mismatch"];
    if (options.mode === "execute" && managerInvocationStarted) {
      status = "uncertain"; code = "native_task_outcome_uncertain";
    } else {
      code = (error as NodeJS.ErrnoException).code === "EEXIST" ? "native_browser_already_owned" :
        error instanceof Error && allowed.includes(error.message) ? error.message : "native_task_failed";
    }
  }
  const result: NativeSeasonTaskReceipt = { ...base, status, code, checkedAt: clock().toISOString(), duplicate: false,
    managementCompleted: options.mode === "execute" && ["verified", "no_action"].includes(status), manager };
  // A failed receipt write leaves the start marker. The next trigger stops for
  // inspection; it never assumes a failed write means Yahoo was not changed.
  await persist(receiptPath, result);
  return result;
}
