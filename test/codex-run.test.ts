import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { digest, snapshotHash, type SeasonSnapshot } from "../src/manager/season.js";
import { managerContextHash, validateManagerContext, validateManagerPacket, type ManagerContext, type ManagerPacket, type ManagerSource } from "../src/manager/codex-run.js";
import { runSeasonManager, type SeasonRunOptions } from "../src/runtime/season-run.js";
import { FileLedger } from "../src/execution/file-ledger.js";
import { actionFingerprint } from "../src/execution/coordinator.js";
import type { GuardedNativeConfig, NativeState, NativeTransport } from "../src/platforms/yahoo/guarded-native.js";

const at = "2026-09-09T18:00:00.000Z", end = "2026-09-09T19:00:00.000Z";
function fixture() {
  const player = (id: string, slot: string | null) => ({ id, slot, eligible: ["QB"], projectedPoints: 10, status: "active" as const,
    locked: false, canDrop: false, availability: "rostered" as const });
  const s: SeasonSnapshot = { schemaVersion: 1, leagueId: "100", teamId: "2", period: "1", capturedAt: at, hash: "",
    roster: [player("starter", "QB:1"), player("bench", null)], available: [], slots: [{ id: "QB:1", position: "QB" }], rosterLimit: 2, waiverType: "rolling" };
  s.hash = snapshotHash(s);
  const content = { observation: "Sanitized source fixture, not a Yahoo observation." };
  const sources: ManagerSource[] = ["roster", "rules", "schedule", "locks", "news", "projections"].map(kind => ({ id: kind,
    kind: kind as ManagerSource["kind"], reference: "fixture:" + kind, capturedAt: at, leagueId: s.leagueId, teamId: s.teamId, period: s.period,
    playerIds: s.roster.map(p => p.id), content, contentHash: digest(content) }));
  const context: ManagerContext = { schemaVersion: 1, runId: "fixture-run", phase: "lineup", strategy: "steady",
    strategyText: "Steady fixture strategy", contractText: "Fixture: agent decisions, deterministic executor", snapshot: s, sources,
    policy: { allowedActions: ["set_lineup"], tradesEnabled: false, windows: [{ kind: "set_lineup", opensAt: at, closesAt: end }] }, contextHash: "" };
  context.contextHash = managerContextHash(context);
  const binding = { leagueId: s.leagueId, teamId: s.teamId, maxAgeMs: 60000, strategyHash: digest(context.strategyText), contractHash: digest(context.contractText) };
  const packet: ManagerPacket = { schemaVersion: 1, runId: context.runId, contextHash: context.contextHash, snapshotHash: s.hash,
    strategy: "steady", phase: "lineup", createdAt: at, rankedActions: [{ decision: { kind: "set_lineup", lineup: { "QB:1": "bench" }, projectedPoints: 10 },
      rationale: "Fixture decision from the manager, not a baseline substitution.", sourceIds: ["news", "projections"] }], unresolvedConstraints: [] };
  return { context, binding, packet };
}

test("accepts a sourced Codex packet without asking the commissioner for player weights", () => {
  const { context, binding, packet } = fixture();
  assert.equal(validateManagerPacket(packet, context, binding, new Date(at)).rankedActions[0]!.decision.kind, "set_lineup");
});

test("rejects wrong repository strategy even if the caller rehashes its context", () => {
  const { context, binding } = fixture();
  context.strategyText = "Changed strategy"; context.contextHash = managerContextHash(context);
  assert.throws(() => validateManagerContext(context, binding, new Date(at)), /repository_contract_mismatch/);
});

test("rejects missing, stale, tampered, wrong-team and incomplete player sources", () => {
  for (const change of ["missing", "stale", "tampered", "team", "player"]) {
    const { context, binding } = fixture();
    if (change === "missing") context.sources.pop();
    if (change === "stale") context.sources[0]!.capturedAt = "2026-09-09T17:00:00Z";
    if (change === "tampered") context.sources[0]!.content = "different data";
    if (change === "team") context.sources[0]!.teamId = "1";
    if (change === "player") context.sources.find(s => s.kind === "news")!.playerIds = ["starter"];
    context.contextHash = managerContextHash(context);
    assert.throws(() => validateManagerContext(context, binding, new Date(at)), /source|evidence/);
  }
});

test("lineup-only inputs cannot establish a waiver review or an empty pending queue", () => {
  const { context, binding } = fixture(); context.phase = "waivers"; context.contextHash = managerContextHash(context);
  assert.throws(() => validateManagerContext(context, binding, new Date(at)), /missing_manager_source/);
});

test("a no-move decision cannot conceal an empty or unavailable starter slot", () => {
  for (const change of ["empty", "out"]) {
    const { context, binding, packet } = fixture();
    if (change === "empty") context.snapshot.roster[0]!.slot = null;
    else context.snapshot.roster[0]!.status = "out";
    context.snapshot.hash = snapshotHash(context.snapshot); context.contextHash = managerContextHash(context);
    packet.snapshotHash = context.snapshot.hash; packet.contextHash = context.contextHash;
    packet.rankedActions[0]!.decision = { kind: "no_action", reason: "Nothing to change" };
    assert.throws(() => validateManagerPacket(packet, context, binding, new Date(at)), /no_action_lineup_invalid/);
  }
});

test("sourced rolling-waiver judgment accepts a legal drop or an explicit no-claim without invented bids", () => {
  for (const noClaim of [false, true]) {
    const { context, binding, packet } = fixture(), s = context.snapshot;
    s.roster[1]!.canDrop = true;
    s.available = [{ ...structuredClone(s.roster[1]!), id: "candidate", availability: "waivers" }];
    s.hash = snapshotHash(s); context.phase = "waivers";
    context.sources.forEach(source => source.playerIds.push("candidate"));
    for (const kind of ["pool", "drops", "pending_claims", "horizon", "transactions"] as const)
      context.sources.push({ ...structuredClone(context.sources[0]!), id: kind, kind });
    context.policy = { allowedActions: ["waiver_claim"], tradesEnabled: false, windows: [{ kind: "waiver_claim", opensAt: at, closesAt: end }] };
    context.contextHash = managerContextHash(context);
    packet.phase = "waivers"; packet.snapshotHash = s.hash; packet.contextHash = context.contextHash;
    packet.rankedActions[0]!.decision = noClaim ? { kind: "no_action", reason: "Preserve rolling priority" } :
      { kind: "waiver_claim", addId: "candidate", dropId: "bench", improvement: 3 };
    assert.equal(validateManagerPacket(packet, context, binding, new Date(at)).rankedActions[0]!.decision.kind, noClaim ? "no_action" : "waiver_claim");
  }
});

test("rejects illegal, malformed, uncited and unresolved packets, including bad lower-ranked fallbacks", () => {
  for (const change of ["trade", "missing-lineup", "duplicate-player", "points", "citation", "constraints", "binding", "extra-bid", "second"]) {
    const { context, binding, packet } = fixture();
    if (change === "trade") (packet.rankedActions[0]!.decision as any).kind = "trade";
    if (change === "missing-lineup") delete (packet.rankedActions[0]!.decision as any).lineup;
    if (change === "duplicate-player") (packet.rankedActions[0]!.decision as any).lineup = { "QB:1": "not-owned" };
    if (change === "points") (packet.rankedActions[0]!.decision as any).projectedPoints = 999;
    if (change === "citation") packet.rankedActions[0]!.sourceIds = ["imaginary"];
    if (change === "constraints") packet.unresolvedConstraints.push("Player lock unobserved");
    if (change === "binding") packet.contextHash = "a".repeat(64);
    if (change === "extra-bid") (packet.rankedActions[0]!.decision as any).bid = 5;
    if (change === "second") packet.rankedActions.push({ decision: { kind: "add_drop", addId: "x", dropId: "y", improvement: 1 }, rationale: "invalid", sourceIds: ["news"] });
    assert.throws(() => validateManagerPacket(packet, context, binding, new Date(at)));
  }
});

async function harness(run: (options: SeasonRunOptions, f: ReturnType<typeof fixture>, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "codex-season-run-")), f = fixture();
  try {
    await run({ context: f.context, binding: f.binding, emergencyStopPath: join(root, "stop"), receiptDirectory: join(root, "receipts"),
      mode: "review", clock: () => new Date(at), decide: async () => f.packet }, f, root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("review persists private packet and receipt and never invokes a transport", async () => harness(async (options, _f, root) => {
  const receipt = await runSeasonManager(options);
  assert.equal(receipt.status, "reviewed"); assert.equal(receipt.applied, false); assert.equal(receipt.execution, null);
  const files = await readdir(join(root, "receipts")); assert.equal(files.length, 2);
  for (const name of files) assert.equal((await stat(join(root, "receipts", name))).mode & 0o777, 0o600);
}));

test("stop before/during reasoning and source expiry after reasoning cannot reach execution", async () => {
  for (const change of ["stop-before", "stop-during", "expiry", "bad-model"]) await harness(async (options, f) => {
    let calls = 0;
    if (change === "stop-before") await writeFile(options.emergencyStopPath, "stop");
    options.decide = async () => {
      calls++;
      if (change === "stop-during") await writeFile(options.emergencyStopPath, "stop");
      if (change === "expiry") options.clock = () => new Date("2026-09-09T18:02:00Z");
      if (change === "bad-model") throw new Error("private-secret-shaped-test-error");
      return f.packet;
    };
    // A stable injected clock can advance while the model is awaited.
    let late = false;
    if (change === "expiry") {
      options.clock = () => new Date(late ? "2026-09-09T18:02:00Z" : at);
      options.decide = async () => { calls++; late = true; return f.packet; };
    }
    const r = await runSeasonManager(options);
    assert.equal(r.status, "blocked"); assert.equal(r.applied, false);
    assert.equal(calls, change === "stop-before" ? 0 : 1);
    assert.equal(JSON.stringify(r).includes("private-secret"), false);
  });
});

test("mutation of the model's context copy cannot change authoritative state", async () => harness(async (options, f) => {
  options.decide = async request => {
    request.context.snapshot.roster[0]!.projectedPoints = 999;
    return f.packet;
  };
  assert.equal((await runSeasonManager(options)).status, "reviewed");
  assert.equal(options.context.snapshot.roster[0]!.projectedPoints, 10);
}));

function native(options: SeasonRunOptions, f: ReturnType<typeof fixture>, root: string) {
  const s = f.context.snapshot, decision = f.packet.rankedActions[0]!.decision;
  const capture = "0 standard window Example, ID: test-window, Secondary Actions: Raise\n  1 HTML content Description: Example | Yahoo, URL: football.fantasysports.yahoo.com/f1/100/2\n    2 link My Team, Value: football.fantasysports.yahoo.com/f1/100/2\n    3 text Example";
  const config: GuardedNativeConfig = { teamName: "Example", profileId: "test-profile", windowId: "test-window", emergencyStopPath: options.emergencyStopPath,
    pendingClaimsPageUrl: null, browserLedger: new FileLedger(join(root, "browser")),
    execution: { ...f.binding, policy: f.context.policy, writesEnabled: true, releaseSha: "a".repeat(40), runningSha: "a".repeat(40), verifiedCapabilities: ["set_lineup"] },
    approval: { context: "disposable", leagueId: "100", teamId: "2", profileId: "test-profile", actionId: actionFingerprint(s, decision), expiresAt: end,
      approvalReference: "sanitized-test-approval", isolatedSessionVerified: true, recoveryVerified: true } };
  let commits = 0;
  const state: NativeState = { snapshot: structuredClone(s), observationId: "before", profileId: config.profileId, windowId: config.windowId,
    capture, lineupDeadlines: { starter: end, bench: end }, acquisitionDeadlines: {} };
  const transport: NativeTransport = {
    read: async () => structuredClone(state),
    prepare: async () => ({ actionId: actionFingerprint(s, decision), observationId: state.observationId, snapshotHash: s.hash, atomic: true, controlsEvidenceHash: "b".repeat(64), expiresAt: end }),
    commit: async (_p, guard) => { await guard(); commits++; },
    readback: async () => {
      const after = structuredClone(state); after.observationId = "after";
      after.snapshot.roster[0]!.slot = null; after.snapshot.roster[1]!.slot = "QB:1"; after.snapshot.hash = snapshotHash(after.snapshot);
      return { state: after, pendingClaims: [], pendingClaimsCapture: null, pendingClaimsCapturedAt: null, pendingClaimsNormalized: false, pendingClaimsSourceHash: null };
    }
  };
  options.mode = "execute"; options.native = { config, transport, ledger: new FileLedger(join(root, "actions")) };
  return { commits: () => commits, transport, config };
}

test("full sourced decision reaches guarded executor; duplicate triggers do not resubmit", async () => harness(async (options, f, root) => {
  const h = native(options, f, root);
  const first = await runSeasonManager(options), second = await runSeasonManager(options);
  assert.equal(first.status, "verified"); assert.equal(first.applied, true);
  assert.equal(second.status, "already_verified"); assert.equal(h.commits(), 1);
}));

test("unknown applied state stays uncertain and never runs a lower-ranked action", async () => harness(async (options, f, root) => {
  const h = native(options, f, root);
  h.transport.readback = async () => { throw new Error("ambiguous native read"); };
  const r = await runSeasonManager(options);
  assert.equal(r.status, "uncertain"); assert.equal(r.applied, null);
  assert.equal((await runSeasonManager(options)).status, "uncertain"); assert.equal(h.commits(), 1);
}));

test("real team hard block is preserved by the integrated runner", async () => harness(async (options, f, root) => {
  f.context.snapshot.leagueId = "425299"; f.binding.leagueId = "425299";
  f.context.sources.forEach(s => s.leagueId = "425299"); f.context.snapshot.hash = snapshotHash(f.context.snapshot);
  f.context.contextHash = managerContextHash(f.context); f.packet.contextHash = f.context.contextHash; f.packet.snapshotHash = f.context.snapshot.hash;
  const h = native(options, f, root);
  const r = await runSeasonManager(options);
  assert.equal(r.code, "real_team_writes_disabled"); assert.equal(r.applied, false); assert.equal(h.commits(), 0);
}));

test("CLI emits a private bound request and validates one packet with no write switch", async () => harness(async (options, f, root) => {
  const current = new Date().toISOString();
  f.context.snapshot.capturedAt = current; f.context.snapshot.hash = snapshotHash(f.context.snapshot);
  f.context.sources.forEach(s => s.capturedAt = current);
  f.context.policy.windows = [{ kind: "set_lineup", opensAt: current, closesAt: new Date(Date.now() + 60000).toISOString() }];
  f.context.contextHash = managerContextHash(f.context); f.packet.createdAt = current;
  f.packet.contextHash = f.context.contextHash; f.packet.snapshotHash = f.context.snapshot.hash;
  for (const [name, value] of Object.entries({ context: f.context, binding: f.binding, packet: f.packet })) await writeFile(join(root, name + ".json"), JSON.stringify(value));
  const cli = resolve("dist/src/cli/season-review.js");
  const args = [cli, "--context", join(root, "context.json"), "--binding", join(root, "binding.json"), "--stop", options.emergencyStopPath];
  const request = spawnSync(process.execPath, [...args, "--request", join(root, "request.json")], { encoding: "utf8" });
  assert.equal(request.status, 0, request.stderr); assert.equal(JSON.parse(request.stdout).executed, false);
  const content = JSON.parse(await readFile(join(root, "request.json"), "utf8"));
  assert.ok(content.instructions.includes("commissioner does not select players"));
  const review = spawnSync(process.execPath, [...args, "--packet", join(root, "packet.json"), "--receipts", options.receiptDirectory], { encoding: "utf8" });
  assert.equal(review.status, 0, review.stderr); assert.equal(JSON.parse(review.stdout).status, "reviewed");
  assert.notEqual(spawnSync(process.execPath, [...args, "--execute"], { encoding: "utf8" }).status, 0);
}));
