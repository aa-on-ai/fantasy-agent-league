import { execFile } from "node:child_process";
import { mkdir, lstat, open, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { digest } from "../manager/season.js";
import { managerContextHash } from "../manager/codex-run.js";
import { readStop } from "./native-read-proof.js";
import type { SeasonRunOptions } from "./season-run.js";

export const MANAGER_ACTOR = "fantasy-manager";
export const MANAGER_SESSION = "agent:fantasy-manager:main";
export type ManagerRpcMethod = "chat.history" | "agent" | "agent.wait";
export type ManagerRpc = (method: ManagerRpcMethod, params: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const fail = (code: string): never => { throw new Error(code); };

/** Uses the installed CLI's inherited Gateway authorization; no credential/config reads or fallback. */
export function createOpenClawCliRpc(options: { executable?: string } = {}): ManagerRpc {
  return async (method, params, timeoutMs) => new Promise((resolve, reject) => {
    execFile(options.executable ?? "openclaw", ["gateway", "call", method, "--json", "--timeout", String(timeoutMs), "--params", JSON.stringify(params)],
      { timeout: timeoutMs + 5_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
        // Do not expose raw source text, stderr, environment or authentication details in errors.
        if (error) return reject(new Error("manager_gateway_rpc_failed"));
        if (stderr.trim()) return reject(new Error("manager_gateway_rpc_warning"));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error("manager_gateway_rpc_invalid_json")); }
      });
  });
}

export interface OpenClawManagerOptions {
  directory: string;
  emergencyStopPath: string;
  rpc?: ManagerRpc;
  clock?: () => Date;
  timeoutMs?: number;
  waitMs?: number;
}

/**
 * Exactly one dispatch per football occurrence. Output remains untrusted and is
 * returned only to runSeasonManager's existing context/packet validation.
 * Unknown dispatches retain the actor lock until an owner reconciles them.
 */
export function createOpenClawManagerDecide(options: OpenClawManagerOptions): SeasonRunOptions["decide"] {
  const rpc = options.rpc ?? createOpenClawCliRpc();
  const clock = options.clock ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 240_000, waitMs = options.waitMs ?? 25_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || !Number.isInteger(waitMs) || waitMs < 1 || waitMs > 30_000)
    fail("manager_transport_invalid_options");
  return async input => {
    const request = structuredClone(input), c = request.context;
    if (c.snapshot.leagueId !== "425299" || c.snapshot.teamId !== "11" || !c.continuity ||
        c.continuity.identity.id !== "yahoo:f1:425299:team:11" || c.contextHash !== managerContextHash(c) ||
        typeof c.runId !== "string" || !c.runId.trim() || c.runId.length > 200)
      fail("manager_transport_binding_conflict");
    const startMs = clock().getTime();
    const kind = { lineup: "set_lineup", free_agents: "add_drop", waivers: "waiver_claim" }[c.phase];
    const window = c.policy.windows.find(w => w.kind === kind && Date.parse(w.opensAt) <= startMs && startMs < Date.parse(w.closesAt));
    if (!window) throw new Error("manager_window_closed");
    const deadline = Math.min(startMs + timeoutMs, Date.parse(window.closesAt));
    const checkpoint = async () => {
      if (await readStop(options.emergencyStopPath) !== "clear") fail("emergency_stop");
      if (clock().getTime() >= deadline) fail("manager_transport_wait_expired");
    };
    await checkpoint();
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(options.directory)).isSymbolicLink()) fail("manager_transport_unsafe_directory");
    const key = digest({ actor: MANAGER_ACTOR, runId: c.runId });
    const directory = join(options.directory, key);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("manager_transport_occurrence_exists"); throw error; }
    const syncParent = async () => {
      const fd = await open(options.directory, "r"); try { await fd.sync(); } finally { await fd.close(); }
    };
    await syncParent();
    const save = async (name: string, value: unknown) => {
      await writeFile(join(directory, name), JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600, flush: true });
      const fd = await open(directory, "r"); try { await fd.sync(); } finally { await fd.close(); }
    };
    const dispatchId = "fantasy-manager-" + key;
    const provenance = { schemaVersion: 1, actor: MANAGER_ACTOR, sessionKey: MANAGER_SESSION, footballRunId: c.runId,
      contextHash: c.contextHash, snapshotHash: c.snapshot.hash, requestHash: digest(request), dispatchId, startedAt: clock().toISOString() };
    await save("request.json", { ...provenance, request });
    const lock = join(options.directory, "actor-inflight.json");
    let ownsLock = false, dispatched = false, terminal = false, sessionId: string | null = null;
    try {
      try { await writeFile(lock, JSON.stringify(provenance) + "\n", { flag: "wx", mode: 0o600, flush: true }); ownsLock = true; await syncParent(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("manager_transport_actor_unresolved"); throw error; }
      const history = object(await rpc("chat.history", { sessionKey: MANAGER_SESSION, agentId: MANAGER_ACTOR, limit: 1 }, 15_000));
      const info = object(history.sessionInfo);
      const pending = object(history.pendingInputs);
      if (history.sessionKey !== MANAGER_SESSION || typeof history.sessionId !== "string" || !history.sessionId || info.hasActiveRun !== false)
        fail("manager_transport_actor_missing_or_busy");
      // The public history includes cancelled/interrupted inputs for display.
      // They never replay automatically. Require a complete page and reject any
      // queued or unknown state, rather than treating terminal history as busy.
      if (history.pendingInputs !== undefined && (!Array.isArray(pending.items) || pending.total !== pending.items.length ||
          pending.nextBefore !== undefined || pending.items.some(item => !["cancelled", "interrupted"].includes(String(object(item).state)))))
        fail("manager_transport_actor_missing_or_busy");
      sessionId = history.sessionId as string;
      await save("actor.json", { sessionKey: MANAGER_SESSION, sessionId, hasActiveRun: false, checkedAt: clock().toISOString() });
      await checkpoint();
      const message = [request.instructions,
        "This is a decision handoff to the existing participant, not permission to execute or publish anything.",
        "Return only one compact JSON ManagerPacket, under 3500 characters, with concise rationale. No markdown, acknowledgement, or extra text.",
        "You may use a read-only clock or session_status solely to obtain the actual current UTC time for createdAt. Do not guess a timestamp.",
        "Do not use other tools, browse, write files, send messages, rename, change the roster, or ask another actor. The host validates and executes separately.",
        `Host dispatched at ${clock().toISOString()}; this is not your creation timestamp. Use the supplied hash-bound context, not old football facts in this conversation.`,
        "CONTEXT_JSON", JSON.stringify(c)].join("\n");
      await save("dispatch.json", { ...provenance, sessionId, message });
      // Public sessionId resolves an already-existing session. The backend-only
      // expectedExistingSessionId field is intentionally NOT forged by this CLI.
      dispatched = true;
      const accepted = object(await rpc("agent", { agentId: MANAGER_ACTOR, sessionId, message,
        idempotencyKey: dispatchId, deliver: false, channel: "webchat", disableMessageTool: true,
        // Same supported target-specific lane as sessions_send. The default
        // main lane can be occupied by this caller waiting for its own child.
        lane: `nested:${MANAGER_SESSION}`,
        timeout: Math.max(1, Math.ceil((deadline - clock().getTime()) / 1000)) }, 20_000));
      await save("acceptance.json", accepted);
      if (accepted.runId !== dispatchId || !["accepted", "ok"].includes(String(accepted.status)) ||
          (accepted.sessionKey !== undefined && accepted.sessionKey !== MANAGER_SESSION) ||
          (accepted.agentId !== undefined && accepted.agentId !== MANAGER_ACTOR)) fail("manager_transport_dispatch_unconfirmed");
      // agent.wait, never another agent request. A cache miss/observation timeout
      // is not proof that the actor ended. All attempts remain one bounded wait.
      const maxWaits = Math.ceil(timeoutMs / waitMs) + 1;
      for (let attempt = 0; attempt < maxWaits; attempt++) {
        await checkpoint();
        const budget = Math.max(1, Math.min(waitMs, deadline - clock().getTime()));
        const result = object(await rpc("agent.wait", { runId: dispatchId, timeoutMs: budget }, budget + 10_000));
        await save(`wait-${attempt}.json`, result);
        if (result.runId !== dispatchId) fail("manager_transport_wrong_run");
        if (result.status === "pending" || (result.status === "timeout" && result.endedAt === undefined && result.stopReason === undefined && result.timeoutPhase === undefined)) {
          if (result.status === "pending") await pause(Math.min(1_000, budget));
          continue;
        }
        terminal = typeof result.endedAt === "number" && Number.isFinite(result.endedAt);
        const reply = object(result.terminalReply), receipt = object(result.terminalReceipt);
        if (typeof reply.text === "string") await writeFile(join(directory, "reply.txt"), reply.text, { flag: "wx", mode: 0o600, flush: true });
        // Codex's successful terminal envelope includes stopReason:"stop".
        // A normal generation finish is not an abort or a runtime failure.
        if (result.status !== "ok" || !terminal || result.pendingError === true || result.yielded === true || result.error ||
            (result.stopReason !== undefined && result.stopReason !== "stop"))
          fail("manager_transport_terminal_failure");
        const requested = object(receipt.requested), effective = object(receipt.effective);
        // A normal idle/daily transcript rollover preserves the canonical actor
        // key but may occur after preflight. Accept it only when supported
        // history explicitly links both sessions and the exact terminal reply.
        if (typeof receipt.sessionId === "string" && receipt.sessionId !== sessionId) {
          await checkpoint();
          const history = object(await rpc("chat.history", {sessionKey: MANAGER_SESSION, agentId: MANAGER_ACTOR, limit: 4}, 15_000));
          const info = object(history.sessionInfo), pending = object(history.pendingInputs);
          const messages = Array.isArray(history.messages) ? history.messages.map(object) : [];
          const matches = messages.filter(message => {
            const meta = object(message.__openclaw);
            const content = typeof message.content === "string" ? message.content : Array.isArray(message.content)
              ? message.content.map(object).filter(part => part.type === "text").map(part => part.text).join("") : null;
            return message.role === "assistant" && meta.runId === dispatchId && meta.runTerminal === true && content === reply.text;
          });
          if (history.sessionKey !== MANAGER_SESSION || history.sessionId !== receipt.sessionId || info.sessionId !== receipt.sessionId ||
              info.previousSessionId !== sessionId || info.agentId !== MANAGER_ACTOR || info.key !== MANAGER_SESSION ||
              info.lastRunId !== dispatchId || info.hasActiveRun !== false || pending.total !== 0 ||
              !Array.isArray(pending.items) || pending.items.length !== 0 || pending.nextBefore !== undefined || matches.length !== 1)
            fail("manager_transport_provenance_failed");
          await save("session-rotation.json", {sessionKey: MANAGER_SESSION, actor: MANAGER_ACTOR, previousSessionId: sessionId,
            sessionId: receipt.sessionId, runId: dispatchId, replyHash: digest(reply.text), checkedAt: clock().toISOString()});
          sessionId = receipt.sessionId;
        }
        if (receipt.runId !== dispatchId || receipt.sessionId !== sessionId || receipt.rerouted !== false ||
            typeof receipt.turnId !== "string" || !receipt.turnId || receipt.sourceReplyDelivered === true ||
            requested.provider !== "openai" || requested.model !== "gpt-6-astra" ||
            effective.provider !== requested.provider || effective.model !== requested.model || reply.modelRouteChange)
          fail("manager_transport_provenance_failed");
        if (reply.disposition !== "visible" || typeof reply.text !== "string" || reply.text.length >= 4096)
          fail("manager_transport_missing_or_truncated_reply");
        let packet: unknown;
        try { packet = JSON.parse(reply.text as string); } catch { fail("manager_transport_invalid_reply_json"); }
        const p = object(packet);
        if (p.runId !== c.runId || p.contextHash !== c.contextHash || p.snapshotHash !== c.snapshot.hash)
          fail("manager_transport_packet_binding_conflict");
        await checkpoint();
        await save("packet.json", packet);
        await save("receipt.json", { ...provenance, sessionId, status: "returned_untrusted_packet", packetHash: digest(packet),
          replyHash: digest(reply.text), terminal: result, completedAt: clock().toISOString(), executed: false });
        return packet;
      }
      fail("manager_transport_wait_expired");
    } catch (error) {
      const code = error instanceof Error && /^(manager_transport_[a-z_]+|manager_gateway_[a-z_]+|emergency_stop)$/.test(error.message)
        ? error.message : "manager_transport_failed";
      await save("failure.json", { ...provenance, sessionId, code, dispatched, terminal, checkedAt: clock().toISOString(),
        requiresInspection: dispatched && !terminal, executed: false });
      throw new Error(code);
    } finally {
      if (ownsLock && (!dispatched || terminal)) {
        const held = JSON.parse(await readFile(lock, "utf8"));
        if (held.dispatchId !== dispatchId) fail("manager_transport_lock_conflict");
        await unlink(lock);
        await syncParent();
      }
    }
  };
}
