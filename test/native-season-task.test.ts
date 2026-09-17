import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { digest, snapshotHash, type SeasonSnapshot } from "../src/manager/season.js";
import { type ManagerPacket, type ManagerSource } from "../src/manager/codex-run.js";
import { actionFingerprint } from "../src/execution/coordinator.js";
import { FileLedger } from "../src/execution/file-ledger.js";
import { type NativeState } from "../src/platforms/yahoo/guarded-native.js";
import { type NativeDesktopApp } from "../src/platforms/yahoo/native-driver.js";
import { runNativeSeasonTask, startNativeSeasonTask, type NativeSeasonTaskOptions } from "../src/runtime/native-season-task.js";
import { loadManagerIdentity, loadOrCreateManagerIdentity } from "../src/manager/identity.js";

const at = "2026-09-10T18:00:00.000Z", end = "2026-09-10T18:10:00.000Z";
// Sanitized simulated desktop. These tests establish integration behavior, not
// an actual Yahoo submission or proof that the native host is installed.
async function harness(run: (h: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const h = await setup();
  try { await run(h); } finally { await rm(h.root, { recursive: true, force: true }); }
}
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-season-task-")));
  await mkdir(join(root, "agents"));
  await writeFile(join(root, "agents/steady-manager.md"), "Prefer reliable workload. Fixture strategy.");
  await writeFile(join(root, "agents/manager-contract.md"), "Codex selects players; deterministic executor applies approved actions.");
  let now = new Date(at), stage = 0, decisions = 0, collections = 0;
  const clicks: number[] = [];
  const binding = { leagueId: "100", teamId: "2", teamName: "Example", maxAgeMs: 60000 };
  // Explicit fixture setup, never initialization by a normal scheduled wake.
  await loadOrCreateManagerIdentity(join(root, "private/participant"), { platform: "yahoo", leagueId: binding.leagueId, teamId: binding.teamId });
  const page = (path: string, body: string) => `0 standard window Example, ID: window, Secondary Actions: Raise\n  4 HTML content Description: Example | Yahoo! Sports, URL: football.fantasysports.yahoo.com/f1/100/${path}\n    5 link My Team, Value: football.fantasysports.yahoo.com/f1/100/2\n    7 text Example\n${body}`;
  const row = (i: number, name: string, team: string, glyph: string) => `    ${i} row (selectable)\n      ${i + 1} cell (selectable) ${glyph}\n      ${i + 2} cell (selectable) ${name}\n, Description: ${name}\n, Value: ${name}\n${team} - QB\nSun 1:00 pm vs Opp\n`;
  const roster = page("2", "    6 link Players, Value: football.fantasysports.yahoo.com/f1/100/players");
  const confirmation = page("addplayer?apid=30971", `    8 heading Claim Player From Waivers, Value: 2\n${row(20, "Baker Mayfield", "TB", "\ue035")}${row(30, "Cairo Santos", "Chi", "\ue033")}    40 link Stats, Value: football.fantasysports.yahoo.com/f1/100/2/addplayer?stage=2&apid=30971&dpid=28227\n    41 link Baker Mayfield, Value: sports.yahoo.com/nfl/players/30971\n    42 link Cairo Santos, Value: sports.yahoo.com/nfl/players/28227\n    169 text If successful, this waiver claim will be reflected in your lineup for  Week 1 on Friday, Sep 11 .\n    170 button Create claim to Add Baker Mayfield, Drop Cairo Santos`);
  const pages = [roster, page("players", row(20, "Baker Mayfield", "TB", "\ue035")),
    page("addplayer?apid=30971", `    8 heading Claim Player From Waivers, Value: 2\n${row(30, "Cairo Santos", "Chi", "—")}`), confirmation, roster];
  const player = (id: string, slot: string | null) => ({ id, slot, eligible: ["QB"], projectedPoints: 10,
    status: "active" as const, locked: false, dropLocked: false, canDrop: true, availability: "rostered" as const });
  const snapshot: SeasonSnapshot = { schemaVersion: 1, leagueId: "100", teamId: "2", period: "1", capturedAt: at, hash: "",
    slots: [{ id: "QB:1", position: "QB" }], rosterLimit: 2, waiverType: "rolling",
    roster: [player("X:Starter", "QB:1"), player("Chi:Cairo Santos", null)],
    available: [{ ...player("TB:Baker Mayfield", null), availability: "waivers" }] };
  snapshot.hash = snapshotHash(snapshot);
  const state: NativeState = { observationId: "collected", profileId: "profile", windowId: "window", capture: roster, snapshot,
    lineupDeadlines: {}, acquisitionDeadlines: { "TB:Baker Mayfield": end, "Chi:Cairo Santos": end } };
  const sources: ManagerSource[] = ["roster", "rules", "schedule", "locks", "news", "projections", "pool", "drops", "pending_claims", "horizon", "transactions"].map(kind => {
    const content = { fixture: "Sanitized simulation, not a live observation." };
    return { id: kind, kind: kind as ManagerSource["kind"], reference: "fixture:" + kind,
      capturedAt: at, leagueId: "100", teamId: "2", period: "1", playerIds: [...snapshot.roster, ...snapshot.available].map(p => p.id), content, contentHash: digest(content) };
  });
  const action = { kind: "waiver_claim" as const, addId: "TB:Baker Mayfield", dropId: "Chi:Cairo Santos", improvement: 1 };
  const policy = { tradesEnabled: false, allowedActions: ["waiver_claim" as const], windows: [{ kind: "waiver_claim" as const, opensAt: at, closesAt: end }] };
  const app: NativeDesktopApp = {
    getAXStateAndScreenshot: async () => ({ state: pages[stage]!, screenshot: new Uint8Array([1]) }),
    getAXState: async () => pages[stage]!, pressKey: async () => {},
    click: async index => { clicks.push(index); stage = Math.min(stage + 1, 4); },
  };
  const pending = page("2/pending", "    8 text Fixture pending claim");
  const options: NativeSeasonTaskOptions = {
    event: { id: "waiver-2026-09-10", phase: "waivers", opensAt: at, closesAt: end }, repositoryRoot: root,
    privateDirectory: join(root, "private"), emergencyStopPath: join(root, "stop"), binding, policy, mode: "execute", app, clock: () => now,
    collect: async checkpoint => { collections++; await checkpoint(); await app.getAXStateAndScreenshot({ disableDiffing: true }); return { state, sources }; },
    decide: async ({ context }) => {
      decisions++;
      return { schemaVersion: 1, runId: context.runId, contextHash: context.contextHash, snapshotHash: context.snapshot.hash,
        phase: context.phase, strategy: "steady", createdAt: now.toISOString(), unresolvedConstraints: [],
        rankedActions: [{ decision: action, rationale: "Fixture manager selected the action.", sourceIds: ["news", "pool"] }] } satisfies ManagerPacket;
    },
    driver: { profileId: "profile", windowId: "window", atomicSwapVerified: false, atomicAcquisitionVerified: true,
      normalize: async observation => ({ ...structuredClone(state), capture: observation.capture }), record: async () => {},
      collectPendingClaims: async () => ({ pendingClaims: [{ id: "fixture-claim", leagueId: "100", teamId: "2", period: "1", addId: action.addId, dropId: action.dropId }],
        pendingClaimsCapture: pending, pendingClaimsCapturedAt: now.toISOString(), pendingClaimsNormalized: true, pendingClaimsSourceHash: digest(pending) }),
    },
    execution: { teamName: "Example", profileId: "profile", windowId: "window", pendingClaimsPageUrl: "football.fantasysports.yahoo.com/f1/100/2/pending",
      execution: { ...binding, writesEnabled: true, runningSha: "a".repeat(40), releaseSha: "a".repeat(40), verifiedCapabilities: ["waiver_claim"], policy },
      approval: { context: "disposable", leagueId: "100", teamId: "2", profileId: "profile", actionId: actionFingerprint(snapshot, action),
        expiresAt: end, approvalReference: "fixture-only", isolatedSessionVerified: true, recoveryVerified: true } },
  };
  return { root, options, state, sources, clicks, counts: () => ({ decisions, collections }), setTime: (value: string) => { now = new Date(value); } };
}

test("scheduled entry integrates source collection, Codex decision, real driver and independent readback", async () => harness(async h => {
  const result = await runNativeSeasonTask(h.options);
  assert.equal(result.status, "verified", JSON.stringify(result));
  assert.equal(result.managementCompleted, true);
  assert.deepEqual(h.clicks, [6, 21, 31, 170]);
  assert.deepEqual(h.counts(), { decisions: 1, collections: 1 });
  const again = await runNativeSeasonTask(h.options);
  assert.equal(again.duplicate, true);
  assert.deepEqual(h.counts(), { decisions: 1, collections: 1 });
  assert.equal(h.clicks.length, 4);
  for (const name of await readdir(join(h.options.privateDirectory, "scheduled-runs"))) {
    const p = join(h.options.privateDirectory, "scheduled-runs", name);
    if ((await stat(p)).isFile()) assert.equal((await stat(p)).mode & 0o777, 0o600);
  }
}));
test("a read-only review cannot claim management completion or invoke native action controls", async () => harness(async h => {
  h.options.mode = "review";
  const decide = h.options.decide;
  h.options.decide = async request => {
    const identity = await loadManagerIdentity(join(h.options.privateDirectory, "participant"), { platform: "yahoo", leagueId: "100", teamId: "2" });
    assert.ok(identity);
    assert.equal(request.context.continuity?.identity.hash, identity.hash);
    assert.equal(request.context.continuity?.identity.id, "yahoo:f1:100:team:2");
    return decide(request);
  };
  const result = await runNativeSeasonTask(h.options);
  assert.equal(result.status, "reviewed"); assert.equal(result.managementCompleted, false); assert.deepEqual(h.clicks, []);
}));
test("native continuity corruption blocks before a decision or action and preserves the identity file", async () => harness(async h => {
  const directory = join(h.options.privateDirectory, "participant");
  await loadOrCreateManagerIdentity(directory, { platform: "yahoo", leagueId: "100", teamId: "2" });
  const path = join(directory, "identity.json");
  await writeFile(path, "invalid fixture identity");
  const result = await runNativeSeasonTask(h.options);
  assert.equal(result.status, "blocked");
  assert.equal(h.counts().decisions, 0);
  assert.deepEqual(h.clicks, []);
  assert.equal(await readFile(path, "utf8"), "invalid fixture identity");
}));
test("normal native wakes never recreate a missing participant", async () => {
  for (const emptyDirectory of [false, true]) await harness(async h => {
    const directory = join(h.options.privateDirectory, "participant");
    await rm(directory, { recursive: true });
    if (emptyDirectory) await mkdir(directory, { mode: 0o700 });
    const result = await runNativeSeasonTask(h.options);
    assert.equal(result.status, "blocked");
    assert.equal(result.code, "participant_not_initialized");
    assert.deepEqual(h.counts(), { decisions: 0, collections: 0 });
    assert.deepEqual(h.clicks, []);
    await assert.rejects(readFile(join(directory, "identity.json")), { code: "ENOENT" });
    if (emptyDirectory) assert.deepEqual(await readdir(directory), []);
    else await assert.rejects(stat(directory), { code: "ENOENT" });
  });
});
test("unsupported source collection, conflicting team and stale sources stop before a model decision", async () => {
  for (const fault of ["source-error", "wrong-native-team", "stale", "missing"]) await harness(async h => {
    if (fault === "source-error") h.options.collect = async () => { throw new Error("private account details must not be logged"); };
    if (fault === "wrong-native-team") h.state.capture = h.state.capture.replace("link My Team, Value: football.fantasysports.yahoo.com/f1/100/2", "link My Team, Value: football.fantasysports.yahoo.com/f1/100/3");
    if (fault === "stale") h.sources[0]!.capturedAt = "2026-09-09T18:00:00Z";
    if (fault === "missing") h.sources.pop();
    const result = await runNativeSeasonTask(h.options);
    assert.equal(result.status, "blocked"); assert.equal(h.counts().decisions, 0); assert.deepEqual(h.clicks, []);
    assert.doesNotMatch(JSON.stringify(result), /private account details/);
  });
});
test("stop and closed occurrence prevent collection; expiry during reasoning prevents action", async () => {
  for (const fault of ["stop", "late", "late-model"]) await harness(async h => {
    if (fault === "stop") await writeFile(h.options.emergencyStopPath, "stop");
    if (fault === "late") h.setTime(end);
    if (fault === "late-model") { const decide = h.options.decide; h.options.decide = async r => { const packet = await decide(r); h.setTime(end); return packet; }; }
    const result = await runNativeSeasonTask(h.options);
    assert.equal(result.status, "blocked"); assert.deepEqual(h.clicks, []);
    assert.equal(h.counts().collections, fault === "late-model" ? 1 : 0);
  });
});
test("the browser lease covers source collection, not only submission", async () => harness(async h => {
  const ledger = new FileLedger(join(h.options.privateDirectory, "browser-ledger"));
  await ledger.exclusive("yahoo-native-browser", async () => {
    const result = await runNativeSeasonTask(h.options);
    assert.equal(result.code, "native_browser_already_owned");
    assert.deepEqual(h.counts(), { decisions: 0, collections: 0 });
  });
}));
test("interrupted occurrence is not silently retried and changed occurrence authority is rejected", async () => harness(async h => {
  await runNativeSeasonTask(h.options);
  const directory = join(h.options.privateDirectory, "scheduled-runs");
  const name = (await readdir(directory)).find(n => n.endsWith(".receipt.json"))!;
  await rm(join(directory, name));
  const result = await runNativeSeasonTask(h.options);
  assert.equal(result.code, "interrupted_task_requires_inspection"); assert.equal(result.managementCompleted, false);
  assert.deepEqual(h.counts(), { decisions: 1, collections: 1 });
  h.options.execution.execution.writesEnabled = false;
  await assert.rejects(runNativeSeasonTask(h.options), /native_task_occurrence_conflict/);
}));
test("uncertain action remains uncertain on a repeated trigger without resubmission", async () => harness(async h => {
  h.options.driver.collectPendingClaims = async () => { throw new Error("readback failed"); };
  const first = await runNativeSeasonTask(h.options);
  assert.equal(first.status, "uncertain"); assert.equal(first.managementCompleted, false);
  const again = await runNativeSeasonTask(h.options);
  assert.equal(again.status, "uncertain"); assert.equal(again.duplicate, true); assert.equal(h.clicks.length, 4);
}));

test("browser-lease cleanup failure after a verified action never reports no action or a preflight block", async () => harness(async h => {
  const decide = h.options.decide;
  h.options.decide = async request => {
    const lock = join(h.options.privateDirectory, "browser-ledger", digest("yahoo-native-browser") + ".lock");
    await writeFile(join(lock, "fixture-cleanup-fault"), "preserve lock for inspection");
    return decide(request);
  };
  const result = await runNativeSeasonTask(h.options);
  assert.equal(result.status, "uncertain"); assert.equal(result.code, "native_task_outcome_uncertain");
  assert.equal(result.manager?.status, "verified"); assert.equal(result.managementCompleted, false);
  assert.equal(h.clicks.length, 4);
}));

test("persistent desktop session yields a request to its admitted model and accepts exactly one packet", async () => harness(async h => {
  const { decide, ...options } = h.options;
  const session = startNativeSeasonTask(options), step = await session.next;
  assert.equal(step.kind, "decision_requested"); assert.deepEqual(h.clicks, []);
  if (step.kind !== "decision_requested") assert.fail("Missing manager request");
  const packet = await decide(step.request);
  const result = await session.submit(packet);
  assert.equal(result.status, "verified"); assert.equal(result.managementCompleted, true);
  assert.throws(() => session.submit(packet), /already_submitted/);
  assert.deepEqual(h.clicks, [6, 21, 31, 170]);
}));
test("desktop session can cancel an unanswered request and release the browser without a gesture", async () => harness(async h => {
  const { decide: _decide, ...options } = h.options;
  const session = startNativeSeasonTask(options);
  assert.equal((await session.next).kind, "decision_requested");
  const result = await session.cancel();
  assert.equal(result.status, "blocked"); assert.equal(result.code, "native_task_cancelled"); assert.deepEqual(h.clicks, []);
  assert.throws(() => session.submit({}), /already_submitted/);
  assert.ok(!(await readdir(join(h.options.privateDirectory, "browser-ledger"))).some(n => n.endsWith(".lock")));
}));
test("desktop session returns a terminal preflight failure without waiting for a model packet", async () => harness(async h => {
  await writeFile(h.options.emergencyStopPath, "stop");
  const { decide: _decide, ...options } = h.options;
  const step = await startNativeSeasonTask(options).next;
  assert.equal(step.kind, "finished");
  if (step.kind !== "finished") assert.fail("Should stop before a decision request");
  assert.equal(step.receipt.status, "blocked"); assert.equal(h.counts().collections, 0);
}));
