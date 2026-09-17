import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenClawManagerDecide, MANAGER_SESSION, type ManagerRpc } from "../src/runtime/openclaw-manager.js";
import { managerContextHash, type ManagerContext } from "../src/manager/codex-run.js";
import { digest, snapshotHash, type SeasonSnapshot } from "../src/manager/season.js";
import { loadOrCreateManagerIdentity } from "../src/manager/identity.js";
import { buildManagerContinuityContext, loadSeasonMemory } from "../src/manager/season-memory.js";
import { runSeasonManager } from "../src/runtime/season-run.js";

const at = "2026-09-16T02:00:00Z", end = "2026-09-16T02:05:00Z";
async function harness(run: (h: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const h = await setup(); try { await run(h); } finally { await rm(h.root, { recursive: true, force: true }); }
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "manager-transport-"));
  const identity = await loadOrCreateManagerIdentity(join(root, "participant"), { platform: "yahoo", leagueId: "425299", teamId: "11" });
  const snapshot: SeasonSnapshot = { schemaVersion: 1, leagueId: "425299", teamId: "11", period: "2", capturedAt: at, hash: "",
    slots: [{ id: "QB:1", position: "QB" }], rosterLimit: 1, waiverType: "rolling", available: [],
    roster: [{ id: "123", eligible: ["QB"], slot: "QB:1", projectedPoints: 10, status: "active", locked: false, canDrop: false, availability: "rostered" }] };
  snapshot.hash = snapshotHash(snapshot);
  const context: ManagerContext = { schemaVersion: 1, runId: "fixture-occurrence", phase: "lineup", strategy: "steady", strategyText: "Fixture strategy", contractText: "Fixture contract", snapshot,
    policy: { tradesEnabled: false, allowedActions: ["set_lineup"], windows: [{ kind: "set_lineup", opensAt: at, closesAt: end }] },
    sources: ["rules", "roster", "news", "schedule", "locks", "projections"].map(kind => ({ id: kind, kind: kind as any,
      reference: "fixture:" + kind, capturedAt: at, leagueId: "425299", teamId: "11", period: "2", playerIds: ["123"], content: { fixture: true }, contentHash: digest({ fixture: true }) })),
    continuity: buildManagerContinuityContext(identity, await loadSeasonMemory(join(root, "participant"), identity)), contextHash: "" };
  context.contextHash = managerContextHash(context);
  const packet = { schemaVersion: 1, runId: context.runId, contextHash: context.contextHash, snapshotHash: snapshot.hash, strategy: "steady", phase: "lineup", createdAt: at,
    rankedActions: [{ decision: { kind: "no_action", reason: "Fixture legal lineup remains." }, rationale: "Fixture evidence supports no change.", sourceIds: ["roster"] }], unresolvedConstraints: [] };
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const state = { terminalStatus: "ok", error: "", wrongRun: false, wrongSession: false, routeChange: false, active: false, queued: false,
    reply: JSON.stringify(packet), pendingOnly: false, throwDispatch: false, stopAfterDispatch: false, waitCount: 0,
    pendingPage: undefined as undefined | Record<string, unknown>, stopReason: "stop" };
  const directory = join(root, "transport"), stop = join(root, "stop");
  const rpc: ManagerRpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "chat.history") return { sessionKey: MANAGER_SESSION, sessionId: "existing-session", sessionInfo: { hasActiveRun: state.active },
      pendingInputs: state.pendingPage ?? { items: state.queued ? [{ state: "queued" }] : [], total: state.queued ? 1 : 0 } };
    if (method === "agent") {
      if (state.throwDispatch) throw Error("private-runtime-error");
      if (state.stopAfterDispatch) await writeFile(stop, "stop");
      return { runId: params.idempotencyKey, status: "accepted", agentId: "fantasy-manager", sessionKey: MANAGER_SESSION };
    }
    state.waitCount++;
    if (state.pendingOnly) return { runId: params.runId, status: "timeout" };
    return { runId: state.wrongRun ? "unrelated-run" : params.runId, status: state.terminalStatus, startedAt: Date.parse(at), endedAt: Date.parse(at), stopReason: state.stopReason,
      ...(state.error ? { error: state.error } : {}), terminalReply: { disposition: "visible", text: state.reply },
      terminalReceipt: { runId: params.runId, sessionId: state.wrongSession ? "replacement-session" : "existing-session", turnId: "turn-fixture",
        requested: { provider: "openai", model: "gpt-6-astra" }, effective: { provider: "openai", model: "gpt-6-astra", responseModel: "gpt-6-astra" },
        rerouted: state.routeChange, successfulToolNames: ["session_status"], terminalDisposition: "visible" } };
  };
  const request = { instructions: "Fixture request", context };
  const decide = createOpenClawManagerDecide({ directory, emergencyStopPath: stop, rpc, clock: () => new Date(at), timeoutMs: 10, waitMs: 5 });
  return { root, directory, stop, context, packet, calls, state, request, decide, rpc };
}

test("one mocked same-actor dispatch, exact terminal text retained, packet validated by existing runner", () => harness(async h => {
  const binding = { leagueId: "425299", teamId: "11", maxAgeMs: 900000, strategyHash: digest(h.context.strategyText), contractHash: digest(h.context.contractText) };
  const result = await runSeasonManager({ context: h.context, binding, mode: "review", emergencyStopPath: h.stop,
    receiptDirectory: join(h.root, "runner"), decide: h.decide, clock: () => new Date(at) });
  assert.equal(result.status, "reviewed"); assert.equal(result.applied, false); assert.equal(result.execution, null);
  const send = h.calls.find(c => c.method === "agent")!.params;
  assert.equal(send.agentId, "fantasy-manager"); assert.equal(send.sessionId, "existing-session"); assert.equal(send.deliver, false);
  assert.equal(send.disableMessageTool, true); assert.equal(send.channel, "webchat");
  assert.equal(send.lane, `nested:${MANAGER_SESSION}`, "a waiting parent must not occupy the target's execution lane");
  for (const key of ["provider", "model", "expectedExistingSessionId", "sessionKey"]) assert.equal(key in send, false);
  assert.match(String(send.message), /read-only clock/);
  const dir = (await readdir(h.directory)).find(n => n !== "actor-inflight.json")!;
  assert.equal(await readFile(join(h.directory, dir, "reply.txt"), "utf8"), h.state.reply);
  assert.deepEqual(JSON.parse(await readFile(join(h.directory, dir, "packet.json"), "utf8")), h.packet);
  await assert.rejects(h.decide(h.request), /occurrence_exists/);
  assert.equal(h.calls.filter(c => c.method === "agent").length, 1);
}));
test("busy or queued actor blocks before dispatch", async () => {
  for (const field of ["active", "queued"] as const) await harness(async h => {
    h.state[field] = true; await assert.rejects(h.decide(h.request), /missing_or_busy/);
    assert.equal(h.calls.filter(c => c.method === "agent").length, 0);
  });
});
test("terminal pending-input display history is not replayed; incomplete or unknown pages block", async () => {
  for (const state of ["cancelled", "interrupted"]) await harness(async h => {
    h.state.pendingPage = { total: 1, items: [{ state, runId: "old-input" }] };
    await h.decide(h.request);
    assert.equal(h.calls.filter(c => c.method === "agent").length, 1);
    assert.notEqual(h.calls.find(c => c.method === "agent")!.params.idempotencyKey, "old-input");
  });
  for (const page of [
    { total: 2, items: [{ state: "cancelled" }] },
    { total: 1, items: [{ state: "unknown" }] },
    { total: 0, items: [], nextBefore: 123 }
  ]) await harness(async h => {
    h.state.pendingPage = page;
    await assert.rejects(h.decide(h.request), /missing_or_busy/);
    assert.equal(h.calls.filter(c => c.method === "agent").length, 0);
  });
});
test("unknown submission consumes occurrence and retains actor lock across new run IDs", () => harness(async h => {
  h.state.throwDispatch = true; await assert.rejects(h.decide(h.request), /manager_transport_failed/);
  const lock = JSON.parse(await readFile(join(h.directory, "actor-inflight.json"), "utf8")); assert.ok(lock.dispatchId);
  h.context.runId = "second-occurrence"; h.context.contextHash = managerContextHash(h.context);
  await assert.rejects(h.decide(h.request), /actor_unresolved/);
  assert.equal(h.calls.filter(c => c.method === "agent").length, 1);
}));
test("wait cache miss remains unknown; bounded observation never resubmits", () => harness(async h => {
  h.state.pendingOnly = true; await assert.rejects(h.decide(h.request), /wait_expired/);
  assert.equal(h.state.waitCount, 3); assert.equal(h.calls.filter(c => c.method === "agent").length, 1);
  assert.ok(await readFile(join(h.directory, "actor-inflight.json"), "utf8"));
}));
test("post-reply runtime error preserves text but never returns valid-looking packet", () => harness(async h => {
  h.state.terminalStatus = "error"; h.state.error = "runtime-plugin-generation fixture failure";
  await assert.rejects(h.decide(h.request), /terminal_failure/);
  const dir = (await readdir(h.directory))[0]!;
  assert.equal(await readFile(join(h.directory, dir, "reply.txt"), "utf8"), h.state.reply);
  await assert.rejects(readFile(join(h.directory, dir, "packet.json")), { code: "ENOENT" });
}));
test("aborted, timed-out and length-limited replies cannot pass as normal completion", async () => {
  for (const reason of ["aborted", "timeout", "length", "unknown"]) await harness(async h => {
    h.state.stopReason = reason;
    await assert.rejects(h.decide(h.request), /terminal_failure/);
  });
});
test("unrelated run cannot supply reply or clear unresolved lock", () => harness(async h => {
  h.state.wrongRun = true; await assert.rejects(h.decide(h.request), /wrong_run/);
  assert.ok(await readFile(join(h.directory, "actor-inflight.json"), "utf8"));
}));
test("replacement session and model fallback fail provenance", async () => {
  for (const field of ["wrongSession", "routeChange"] as const) await harness(async h => {
    h.state[field] = true; await assert.rejects(h.decide(h.request), /provenance_failed/);
  });
});
test("canonical transcript rollover requires an explicit predecessor and exact terminal reply", async () => {
  for (const defect of [null, "previous", "actor", "reply", "pending", "run"] as const) await harness(async h => {
    h.state.wrongSession = true;
    let dispatchId = "";
    const rpc: ManagerRpc = async (method, params, timeout) => {
      if (method === "agent") dispatchId = String(params.idempotencyKey);
      if (method === "chat.history" && dispatchId) return {sessionKey: MANAGER_SESSION, sessionId: "replacement-session",
        sessionInfo: {key: MANAGER_SESSION, sessionId: "replacement-session", previousSessionId: defect === "previous" ? "other" : "existing-session",
          agentId: defect === "actor" ? "other" : "fantasy-manager", lastRunId: defect === "run" ? "other" : dispatchId, hasActiveRun: false},
        pendingInputs: {total: defect === "pending" ? 1 : 0, items: defect === "pending" ? [{state: "queued"}] : []},
        messages: [{role: "assistant", __openclaw: {runId: dispatchId, runTerminal: true}, content: [{type: "text", text: defect === "reply" ? "other" : h.state.reply}]}]};
      return h.rpc(method, params, timeout);
    };
    const decide = createOpenClawManagerDecide({directory: h.directory, emergencyStopPath: h.stop, rpc, clock: () => new Date(at), timeoutMs: 10, waitMs: 5});
    if (defect) await assert.rejects(decide(h.request), /provenance_failed/);
    else {
      assert.deepEqual(await decide(h.request), h.packet);
      const dir = (await readdir(h.directory))[0]!;
      const rotation = JSON.parse(await readFile(join(h.directory, dir, "session-rotation.json"), "utf8"));
      assert.equal(rotation.previousSessionId, "existing-session"); assert.equal(rotation.sessionId, "replacement-session");
    }
    assert.equal(h.calls.filter(c => c.method === "agent").length, 1);
  });
});
test("wrong football run/hash is rejected without adopting or repairing judgment", () => harness(async h => {
  h.state.reply = JSON.stringify({ ...h.packet, runId: "stale-football-run" });
  await assert.rejects(h.decide(h.request), /packet_binding_conflict/);
}));
test("truncation and markdown/non-JSON responses fail closed", async () => {
  for (const reply of ["x".repeat(4096), "```json\n{}\n```", "{\"truncated\":…"]) await harness(async h => {
    h.state.reply = reply; await assert.rejects(h.decide(h.request), /missing_or_truncated_reply|invalid_reply_json/);
  });
});
test("stop before dispatch sends nothing; stop after dispatch retains unresolved run", async () => {
  await harness(async h => { await writeFile(h.stop, "stop"); await assert.rejects(h.decide(h.request), /emergency_stop/); assert.equal(h.calls.length, 0); });
  await harness(async h => { h.state.stopAfterDispatch = true; await assert.rejects(h.decide(h.request), /emergency_stop/);
    assert.equal(h.state.waitCount, 0); assert.ok(await readFile(join(h.directory, "actor-inflight.json"), "utf8")); });
});
test("forged context or different team never dispatches", () => harness(async h => {
  h.context.snapshot.teamId = "99"; await assert.rejects(h.decide(h.request), /binding_conflict/); assert.equal(h.calls.length, 0);
}));
