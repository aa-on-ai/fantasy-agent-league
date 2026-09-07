import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bestLineup, decideAcquisition, decideLineup, snapshotHash, validateSnapshot, validateDecision,
  type Player, type SeasonSnapshot, type Decision } from "../src/manager/season.js";
import { executeDecision, actionFingerprint, type ExecutionConfig, type Executor } from "../src/execution/coordinator.js";
import { FileLedger } from "../src/execution/file-ledger.js";

const now = () => new Date("2026-09-13T16:30:00Z");
function player(id: string, eligible: string[], projectedPoints: number, slot: string | null = null): Player {
  return { id, eligible, projectedPoints, slot, status: "active", locked: false, canDrop: true, availability: "rostered" };
}
function snapshot(): SeasonSnapshot {
  const s: SeasonSnapshot = { schemaVersion: 1, leagueId: "example-league", teamId: "agent-1", period: "week-1",
    capturedAt: now().toISOString(), hash: "", rosterLimit: 8, waiverType: "rolling",
    slots: [{ id: "runner", position: "rb" }, { id: "receiver", position: "wr" }, { id: "flex", position: "flex" }],
    roster: [player("runner-high", ["rb", "flex"], 20, "flex"), player("runner-low", ["rb", "flex"], 12, "runner"),
      player("receiver-high", ["wr", "flex"], 19), player("receiver-low", ["wr", "flex"], 5, "receiver")],
    available: [] };
  s.hash = snapshotHash(s);
  return s;
}
function config(): ExecutionConfig {
  return { leagueId: "example-league", teamId: "agent-1", maxAgeMs: 900000, writesEnabled: true,
    releaseSha: "a".repeat(40), runningSha: "a".repeat(40), verifiedCapabilities: ["set_lineup", "add_drop", "waiver_claim"],
    policy: { allowedActions: ["set_lineup", "add_drop", "waiver_claim"], tradesEnabled: false,
      windows: ["set_lineup", "add_drop", "waiver_claim"].map(kind => ({ kind: kind as "set_lineup" | "add_drop" | "waiver_claim",
        opensAt: "2026-09-13T16:00:00Z", closesAt: "2026-09-13T17:00:00Z" })) } };
}
test("finds the exact lineup across flex competition instead of picking greedily", () => {
  const s = snapshot();
  const result = bestLineup(s)!;
  assert.equal(result.projectedPoints, 51);
  assert.equal(result.lineup.receiver, "receiver-high");
  assert.equal(new Set(Object.values(result.lineup)).size, 3);
  assert.deepEqual(validateDecision(s, { kind: "set_lineup", ...result }), []);
});
test("keeps locked starters and locked bench players in place, even if projections favor a move", () => {
  const s = snapshot();
  s.roster[3]!.locked = true;
  s.roster[2]!.locked = true;
  const result = bestLineup(s)!;
  assert.equal(result.lineup.receiver, "receiver-low");
  assert.ok(!Object.values(result.lineup).includes("receiver-high"));
  assert.deepEqual(validateDecision(s, { kind: "set_lineup", lineup: { runner: "runner-high", receiver: "receiver-high", flex: "runner-low" }, projectedPoints: 51 }), ["locked_player"]);
});
test("does not select unavailable players and explicitly reports an impossible lineup", () => {
  const s = snapshot();
  s.roster.filter(p => p.eligible.includes("wr")).forEach(p => { p.status = "out"; });
  assert.deepEqual(decideLineup(s), { kind: "no_action", reason: "no_complete_legal_lineup" });
});
test("preserves an already optimal lineup, including ties", () => {
  const s = snapshot();
  s.roster[3]!.projectedPoints = 19;
  s.roster[2]!.projectedPoints = 12;
  assert.equal(decideLineup(s).kind, "no_action");
});
test("checks identity, freshness, integrity and unique ownership before planning", () => {
  const s = snapshot();
  assert.equal(validateSnapshot(s, config(), now()), s);
  assert.throws(() => validateSnapshot(s, { ...config(), teamId: "another-team" }, now()), /wrong_team/);
  assert.throws(() => validateSnapshot(s, config(), new Date("2026-09-14T00:00:00Z")), /stale_snapshot/);
  const changed = structuredClone(s); changed.roster[0]!.projectedPoints++;
  assert.throws(() => validateSnapshot(changed, config(), now()), /hash_mismatch/);
  const duplicated = structuredClone(s); duplicated.roster.push(duplicated.roster[0]!); duplicated.hash = snapshotHash(duplicated);
  assert.throws(() => validateSnapshot(duplicated, config(), now()), /invalid_player/);
});
test("rolling claims use legal replaceable players and do not invent waiver bids", () => {
  const s = snapshot();
  s.available = [{ ...player("waiver-runner", ["rb", "flex"], 25), availability: "waivers" }];
  const result = decideAcquisition(s, "waiver_claim", 2);
  assert.equal(result.kind, "waiver_claim");
  assert.ok(!("bid" in result));
  assert.deepEqual(validateDecision(s, result), []);
  assert.equal(decideAcquisition(s, "add_drop", 2).kind, "no_action");
  s.roster.forEach(p => { p.canDrop = false; });
  assert.equal(decideAcquisition(s, "waiver_claim", 2).kind, "no_action");
});

async function harness(run: (args: { s: SeasonSnapshot; decision: Decision; cfg: ExecutionConfig;
  executor: Executor; ledger: FileLedger; root: string; submissions: () => number }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "fantasy-ledger-test-"));
  const s = snapshot();
  let submitted = 0;
  const executor: Executor = { read: async () => structuredClone(s), stopped: async () => false,
    submit: async () => { submitted++; }, verify: async () => "applied" };
  try { await run({ s, decision: decideLineup(s), cfg: config(), executor, ledger: new FileLedger(root), root, submissions: () => submitted }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
test("writes are gated by capability proof, release pin, emergency stop and published window", async () => {
  await harness(async ({ s, decision, cfg, executor, ledger, submissions }) => {
    assert.equal((await executeDecision(s, decision, { ...cfg, writesEnabled: false }, executor, ledger, now)).code, "writes_disabled");
    assert.equal((await executeDecision(s, decision, { ...cfg, verifiedCapabilities: [] }, executor, ledger, now)).code, "capability_unverified");
    assert.equal((await executeDecision(s, decision, { ...cfg, runningSha: "b".repeat(40) }, executor, ledger, now)).code, "release_mismatch");
    assert.equal((await executeDecision(s, decision, cfg, { ...executor, stopped: async () => true }, ledger, now)).code, "emergency_stop");
    assert.equal((await executeDecision(s, decision, { ...cfg, policy: { ...cfg.policy, windows: [] } }, executor, ledger, now)).code, "outside_action_window");
    assert.equal(submissions(), 0);
  });
});
test("changed live state invalidates a previously legal decision", async () => {
  await harness(async ({ s, decision, cfg, executor, ledger, submissions }) => {
    const changed = structuredClone(s); changed.roster[0]!.locked = true; changed.hash = snapshotHash(changed);
    const result = await executeDecision(s, decision, cfg, { ...executor, read: async () => changed }, ledger, now);
    assert.equal(result.code, "state_changed_replan_required");
    assert.equal(submissions(), 0);
  });
});
test("an unchanged fresh read with a newer capture timestamp remains executable", async () => {
  await harness(async ({ s, decision, cfg, executor, ledger, submissions }) => {
    const fresh = structuredClone(s); fresh.capturedAt = "2026-09-13T16:31:00Z"; fresh.hash = snapshotHash(fresh);
    const result = await executeDecision(s, decision, cfg, { ...executor, read: async () => fresh }, ledger,
      () => new Date("2026-09-13T16:31:00Z"));
    assert.equal(result.status, "verified");
    assert.equal(submissions(), 1);
  });
});
test("a successful click is not success without independent readback", async () => {
  await harness(async ({ s, decision, cfg, executor, ledger, submissions }) => {
    const uncertain = { ...executor, verify: async () => "unknown" as const };
    const result = await executeDecision(s, decision, cfg, uncertain, ledger, now);
    assert.equal(result.status, "uncertain");
    const again = await executeDecision(s, decision, cfg, uncertain, ledger, now);
    assert.equal(again.code, "manual_reconciliation_required");
    assert.equal(submissions(), 1);
  });
});
test("a timeout after a successful submission reconciles without resubmitting after restart", async () => {
  await harness(async ({ s, decision, cfg, executor, ledger, root }) => {
    let submissions = 0;
    const ambiguous = { ...executor, submit: async () => { submissions++; throw new Error("private_transport_payload"); }, verify: async () => "unknown" as const };
    const first = await executeDecision(s, decision, cfg, ambiguous, ledger, now);
    assert.equal(first.status, "uncertain");
    assert.ok(!JSON.stringify(first).includes("private_transport_payload"));
    const second = await executeDecision(s, decision, cfg, { ...ambiguous, verify: async () => "applied" }, new FileLedger(root), now);
    assert.equal(second.code, "reconciled_without_resubmission");
    assert.equal(submissions, 1);
  });
});
test("duplicate triggers produce one submission and durable private verification", async () => {
  await harness(async ({ s, decision, cfg, executor, ledger, root, submissions }) => {
    assert.equal((await executeDecision(s, decision, cfg, executor, ledger, now)).status, "verified");
    const fresh = structuredClone(s); fresh.capturedAt = "2026-09-13T16:31:00Z"; fresh.hash = snapshotHash(fresh);
    assert.equal(actionFingerprint(fresh, decision), actionFingerprint(s, decision));
    const duplicate = await executeDecision(s, decision, cfg, executor, new FileLedger(root), now);
    assert.equal(duplicate.status, "already_verified");
    assert.equal(submissions(), 1);
    const path = join(root, `${actionFingerprint(s, decision)}.json`);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(path, "utf8")).status, "verified");
  });
});
test("concurrent processes sharing a team scope cannot enter the submission critical section together", async () => {
  await harness(async ({ ledger, root }) => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const first = ledger.exclusive("team", async () => { entered(); await pending; });
    await ready;
    try { await assert.rejects(new FileLedger(root).exclusive("team", async () => "must not enter"), { code: "EEXIST" }); }
    finally { finish(); await first; }
  });
});
