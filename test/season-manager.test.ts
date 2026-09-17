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
test("preserves doubtful as uncertainty without falsely declaring the player out", () => {
  const s = snapshot();
  s.roster[2]!.status = "doubtful";
  s.hash = snapshotHash(s);
  assert.equal(validateSnapshot(s, config(), now()).roster[2]!.status, "doubtful");
  const selected = bestLineup(s)!;
  assert.equal(selected.lineup.receiver, "receiver-high");
  assert.deepEqual(validateDecision(s, { kind: "set_lineup", ...selected }), []);
  s.roster[2]!.status = "out";
  assert.deepEqual(validateDecision(s, { kind: "set_lineup", ...selected }), ["unavailable_player"]);
});
test("not-active players remain represented but cannot be newly started or acquired", () => {
  const s = snapshot(), selected = bestLineup(s)!;
  s.roster[2]!.status = "not_active";
  s.available.push({...player("not-active-candidate", ["wr", "flex"], 30), status: "not_active", availability: "free_agent"});
  s.hash = snapshotHash(s);
  assert.equal(validateSnapshot(s, config(), now()).roster[2]!.status, "not_active");
  assert.ok(!Object.values(bestLineup(s)!.lineup).includes(s.roster[2]!.id));
  assert.deepEqual(validateDecision(s, {kind: "set_lineup", ...selected}), ["unavailable_player"]);
  assert.deepEqual(validateDecision(s, {kind: s.available[0]!.availability === "waivers" ? "waiver_claim" : "add_drop", addId: s.available[0]!.id, dropId: s.roster[0]!.id, improvement: 1}), ["unavailable_player"]);
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
test('first live disposable acceptance requires an exact unexpired grant and still submits only once', async () => {
  await harness(async ({ s, decision, cfg, executor, ledger, submissions }) => {
    cfg.verifiedCapabilities = [];
    const grant = { leagueId: s.leagueId, teamId: s.teamId, actionId: actionFingerprint(s, decision),
      expiresAt: '2026-09-13T16:45:00Z', approvalReference: 'owner-authorized-disposable-proof' };
    for (const bad of [{ ...grant, teamId: 'other' }, { ...grant, actionId: 'b'.repeat(64) },
      { ...grant, expiresAt: now().toISOString() }, { ...grant, approvalReference: '' }]) {
      assert.equal((await executeDecision(s, decision, { ...cfg, acceptanceTest: bad }, executor, ledger, now)).code, 'capability_unverified');
    }
    assert.equal(submissions(), 0);
    cfg.acceptanceTest = grant;
    assert.equal((await executeDecision(s, decision, cfg, executor, ledger, now)).status, 'verified');
    assert.equal((await executeDecision(s, decision, cfg, executor, ledger, now)).status, 'already_verified');
    assert.equal(submissions(), 1);
    assert.deepEqual(cfg.verifiedCapabilities, []);
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
test("an explicit evidenced not-applied reconciliation admits one fresh guarded retry", async () => {
  await harness(async ({ s, decision, cfg, executor, ledger, submissions }) => {
    const actionId = actionFingerprint(s, decision);
    await ledger.put({ actionId, scope: `${s.leagueId}:${s.teamId}`, status: "not_applied", updatedAt: now().toISOString(),
      reconciliationReference: "operator-review/independent-platform-readback.json" });
    assert.equal(await ledger.hasUnresolved(`${s.leagueId}:${s.teamId}`, "b".repeat(64)), false);
    assert.equal((await executeDecision(s, decision, cfg, executor, ledger, now)).status, "verified");
    assert.equal((await executeDecision(s, decision, cfg, executor, ledger, now)).status, "already_verified");
    assert.equal(submissions(), 1);
  });
});
test("not-applied entries without reconciliation evidence fail closed", async () => {
  await harness(async ({ s, decision, cfg, executor, ledger, submissions }) => {
    await ledger.put({ actionId: actionFingerprint(s, decision), status: "not_applied", updatedAt: now().toISOString() });
    assert.equal((await executeDecision(s, decision, cfg, executor, ledger, now)).status, "blocked");
    assert.equal(submissions(), 0);
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

test("an unresolved submission blocks different actions for the same team", async () => {
  await harness(async ({s,decision,cfg,executor,ledger,submissions}) => {
    const uncertain = {...executor,verify:async()=>"unknown" as const};
    assert.equal((await executeDecision(s,decision,cfg,uncertain,ledger,now)).status,"uncertain");
    const other = structuredClone(s); other.roster[0]!.projectedPoints=0; other.hash=snapshotHash(other);
    const next = decideLineup(other);
    assert.notEqual(actionFingerprint(other,next),actionFingerprint(s,decision));
    assert.equal((await executeDecision(other,next,cfg,{...uncertain,read:async()=>other},ledger,now)).code,"unresolved_team_action");
    assert.equal(submissions(),1);
  });
});
test("expiry during the last awaited guard prevents submission", async () => {
  await harness(async ({s,decision,cfg,executor,ledger,submissions}) => {
    let checks=0; let time=now();
    const delayed={...executor,stopped:async()=>{if(++checks===3)time=new Date('2026-09-13T17:01:00Z');return false;}};
    assert.equal((await executeDecision(s,decision,cfg,delayed,ledger,()=>time)).code,'snapshot_expired_before_submission');
    assert.equal(submissions(),0);
  });
});
test("loss of verified ledger persistence stays uncertain after submission", async () => {
  await harness(async ({s,decision,cfg,executor,ledger,submissions}) => {
    const failedLedger={exclusive:ledger.exclusive.bind(ledger),get:ledger.get.bind(ledger),
      hasUnresolved:ledger.hasUnresolved.bind(ledger),put:async(entry:Parameters<FileLedger['put']>[0])=>{
        if(entry.status==='verified')throw new Error('private disk error');await ledger.put(entry);
      }};
    const result=await executeDecision(s,decision,cfg,executor,failedLedger,now);
    assert.equal(result.status,'uncertain');assert.equal(result.code,'execution_outcome_uncertain');assert.equal(submissions(),1);
    assert.equal((await executeDecision(s,decision,cfg,executor,ledger,now)).code,'reconciled_without_resubmission');
    assert.equal(submissions(),1);
  });
});

test("observed bench-drop permission is distinct from lineup lock", () => {
 const s=snapshot();const bench=s.roster[2]!;bench.locked=true;bench.dropLocked=false;
 s.available=[{...player('addition',['wr','flex'],25),availability:'free_agent'}];
 s.hash=snapshotHash(s);assert.equal(validateSnapshot(s,config(),now()),s);
 assert.deepEqual(validateDecision(s,{kind:'add_drop',addId:'addition',dropId:bench.id,improvement:5}),[]);
 assert.ok(!Object.values(bestLineup(s)!.lineup).includes(bench.id));
 delete bench.dropLocked;
 assert.deepEqual(validateDecision(s,{kind:'add_drop',addId:'addition',dropId:bench.id,improvement:5}),['locked_player']);
});
test("a contradictory unlocked-drop flag cannot unlock a locked starter", () => {
 const s=snapshot();s.roster[0]!.locked=true;s.roster[0]!.dropLocked=false;s.hash=snapshotHash(s);
 assert.throws(()=>validateSnapshot(s,config(),now()),/conflicting_player_locks/);
});

test("legacy unresolved ledger entries conservatively block new team actions", async () => {
 await harness(async({s,decision,cfg,executor,ledger,submissions})=>{
  await ledger.put({actionId:'f'.repeat(64),status:'pending',updatedAt:now().toISOString()});
  assert.equal((await executeDecision(s,decision,cfg,executor,ledger,now)).code,'unresolved_team_action');
  assert.equal(submissions(),0);
 });
});
