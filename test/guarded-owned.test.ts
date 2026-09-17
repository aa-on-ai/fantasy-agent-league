import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLedger } from "../src/execution/file-ledger.js";
import { actionFingerprint } from "../src/execution/coordinator.js";
import { digest, snapshotHash, type SeasonSnapshot } from "../src/manager/season.js";
import { runGuardedOwnedAction, type GuardedOwnedConfig, type OwnedAction, type OwnedState, type OwnedTransport, type OwnedActionReadback, type OwnedClaimsEvidence } from "../src/platforms/yahoo/guarded-owned.js";
import type { OwnedObservation } from "../src/platforms/yahoo/owned-sources.js";
const at = "2026-09-15T22:00:00Z", end = "2026-09-15T23:00:00Z";
function observation(id = "before", suffix = ""): OwnedObservation {
  return { observationId: id, capturedAt: at, profileId: "test-owned", url: `https://football.fantasysports.yahoo.com/f1/100/2${suffix}`,
    dom: { title: "Test fixture", text: "", headings: [], forms: [], controls: [], tables: [],
      links: [{ text: "My Team", href: "https://football.fantasysports.yahoo.com/f1/100/2", title: "", attributes: {} }] } };
}
function snapshot(): SeasonSnapshot {
  const p = (id: string, slot: string | null) => ({ id, slot, eligible: ["QB"], projectedPoints: 10, status: "active" as const,
    locked: false, dropLocked: false, canDrop: true, availability: "rostered" as const });
  const s: SeasonSnapshot = { schemaVersion: 1, leagueId: "100", teamId: "2", period: "2", capturedAt: at, hash: "", slots: [{ id: "QB:1", position: "QB" }],
    rosterLimit: 2, waiverType: "rolling", roster: [p("11", "QB:1"), p("22", null)], available: [{ ...p("33", null), availability: "free_agent" }] };
  s.hash = snapshotHash(s); return s;
}
function claims(id: string, applied = false): OwnedClaimsEvidence {
  const o = observation(id, "/claims-fixture");
  return { observation: o, sourceHash: digest(o), normalized: true,
    claims: applied ? [{ id: "claim-1", leagueId: "100", teamId: "2", period: "2", addId: "33", dropId: "22" }] : [] };
}
async function harness(kind: OwnedAction["kind"], run: (h: {
  original: SeasonSnapshot; action: OwnedAction; config: GuardedOwnedConfig; state: OwnedState; readback: OwnedActionReadback;
  transport: OwnedTransport; ledger: FileLedger; clock: () => Date; setTime: (at: string) => void; commits: () => number; applied: () => void;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "owned-guard-test-"));
  const original = snapshot();
  if (kind === "waiver_claim") { original.available[0]!.availability = "waivers"; original.hash = snapshotHash(original); }
  const action: OwnedAction = kind === "set_lineup" ? { kind, lineup: { "QB:1": "22" }, projectedPoints: 10 } : { kind, addId: "33", dropId: "22", improvement: 2 };
  const config: GuardedOwnedConfig = { profileId: "test-owned", emergencyStopPath: join(root, "stop"), browserLedger: new FileLedger(join(root, "browser")),
    pendingClaimsPageUrl: "https://football.fantasysports.yahoo.com/f1/100/2/claims-fixture",
    execution: { leagueId: "100", teamId: "2", maxAgeMs: 60000, writesEnabled: true, releaseSha: "a".repeat(40), runningSha: "a".repeat(40), verifiedCapabilities: [kind],
      policy: { allowedActions: [kind], tradesEnabled: false, windows: [{ kind, opensAt: at, closesAt: end }] } },
    approval: { context: "disposable", leagueId: "100", teamId: "2", profileId: "test-owned", actionId: actionFingerprint(original, action), expiresAt: end,
      approvalReference: "contract-fixture-only", isolatedSessionVerified: true, recoveryVerified: true } };
  const state: OwnedState = { observation: observation(), snapshot: structuredClone(original), lineupDeadlines: { "11": end, "22": end }, acquisitionDeadlines: { "22": end, "33": end }, pendingClaims: claims("claims-before") };
  const readback: OwnedActionReadback = { state: { ...structuredClone(state), observation: observation("after") }, pendingClaims: claims("claims-after") };
  let commits = 0, current = at;
  const transport: OwnedTransport = { read: async () => state,
    prepare: async () => ({ actionId: actionFingerprint(original, action), observationId: state.observation.observationId, snapshotHash: state.snapshot.hash,
      leagueId: "100", teamId: "2", period: "2", atomic: true, controlsEvidenceHash: "b".repeat(64), expiresAt: end }),
    commit: async (_ticket, guard) => { await guard(); commits++; }, readback: async () => readback };
  function applied() {
    const s = readback.state.snapshot;
    if (kind === "set_lineup") { s.roster[0]!.slot = null; s.roster[1]!.slot = "QB:1"; }
    else if (kind === "add_drop") { s.roster[1] = { ...s.available[0]!, availability: "rostered" }; s.available = []; }
    else readback.pendingClaims = claims("claims-after", true);
    s.hash = snapshotHash(s);
  }
  try { await run({ original, action, config, state, readback, transport, ledger: new FileLedger(join(root, "actions")), clock: () => new Date(current), setTime: t => { current = t; }, commits: () => commits, applied }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
test("owned actions retain production hard block despite flags and test grant", async () => {
  await harness("set_lineup", async h => { h.config.execution.leagueId = "425299";
    assert.equal((await runGuardedOwnedAction(h.original, h.action, h.config, h.transport, h.ledger, h.clock)).code, "real_team_writes_disabled"); assert.equal(h.commits(), 0); });
});
test("exact action approval, profile, release and recovery are required", async () => {
  for (const change of ["action", "profile", "approval", "release", "expired", "recovery"]) await harness("set_lineup", async h => {
    if (change === "action") h.config.approval!.actionId = "other";
    if (change === "profile") h.config.approval!.profileId = "personal";
    if (change === "approval") h.config.approval = null;
    if (change === "release") h.config.execution.runningSha = "b".repeat(40);
    if (change === "expired") h.config.approval!.expiresAt = at;
    if (change === "recovery") h.config.approval!.recoveryVerified = false;
    assert.equal((await runGuardedOwnedAction(h.original, h.action, h.config, h.transport, h.ledger, h.clock)).status, "blocked"); assert.equal(h.commits(), 0);
  });
});
test("owned DOM identity, capture freshness, source clocks and deadlines fail closed", async () => {
  for (const change of ["owner", "profile", "url", "capture", "source", "deadline", "state"]) await harness("set_lineup", async h => {
    if (change === "owner") h.state.observation.dom.links[0]!.href = "https://football.fantasysports.yahoo.com/f1/100/3";
    if (change === "profile") h.state.observation.profileId = "other";
    if (change === "url") h.state.observation.url = "https://login.yahoo.com/";
    if (change === "capture") h.state.observation.capturedAt = "2026-09-15T21:00:00Z";
    if (change === "source") { h.state.snapshot.capturedAt = "2026-09-15T21:00:00Z"; h.state.snapshot.hash = snapshotHash(h.state.snapshot); }
    if (change === "deadline") delete h.state.lineupDeadlines["22"];
    if (change === "state") { h.state.snapshot.roster[0]!.projectedPoints = 99; h.state.snapshot.hash = snapshotHash(h.state.snapshot); }
    assert.equal((await runGuardedOwnedAction(h.original, h.action, h.config, h.transport, h.ledger, h.clock)).status, "blocked"); assert.equal(h.commits(), 0);
  });
});
test("each capability needs exact independent readback; replay does not resubmit", async () => {
  for (const kind of ["set_lineup", "add_drop", "waiver_claim"] as const) await harness(kind, async h => {
    h.applied();
    assert.equal((await runGuardedOwnedAction(h.original, h.action, h.config, h.transport, h.ledger, h.clock)).status, "verified");
    assert.equal((await runGuardedOwnedAction(h.original, h.action, h.config, h.transport, h.ledger, h.clock)).status, "already_verified"); assert.equal(h.commits(), 1);
  });
});
test("pending claims may be bound to My Team itself, without interpreting missing queue as empty", async () => {
  await harness("waiver_claim", async h => {
    const teamUrl = "https://football.fantasysports.yahoo.com/f1/100/2";
    h.config.pendingClaimsPageUrl = teamUrl;
    h.applied();
    for (const evidence of [h.state.pendingClaims!, h.readback.pendingClaims!]) {
      evidence.observation.url = teamUrl;
      evidence.sourceHash = digest(evidence.observation);
    }
    assert.equal((await runGuardedOwnedAction(h.original,h.action,h.config,h.transport,h.ledger,h.clock)).status,"verified");
    assert.equal(h.commits(),1);
  });
  await harness("waiver_claim", async h => {
    h.config.pendingClaimsPageUrl = "https://football.fantasysports.yahoo.com/f1/100/2";
    h.state.pendingClaims = null;
    assert.equal((await runGuardedOwnedAction(h.original,h.action,h.config,h.transport,h.ledger,h.clock)).status,"blocked");
    assert.equal(h.commits(),0);
  });
});
test("timeout after submit is uncertain, can reconcile, and never resubmits", async () => {
  await harness("add_drop", async h => {
    const commit = h.transport.commit;
    h.transport.commit = async (...args) => { await commit(...args); throw new Error("transport_timeout"); };
    assert.equal((await runGuardedOwnedAction(h.original, h.action, h.config, h.transport, h.ledger, h.clock)).status, "uncertain");
    assert.equal((await runGuardedOwnedAction(h.original, h.action, h.config, h.transport, h.ledger, h.clock)).code, "manual_reconciliation_required");
    h.applied();
    assert.equal((await runGuardedOwnedAction(h.original, h.action, h.config, h.transport, h.ledger, h.clock)).code, "reconciled_without_resubmission"); assert.equal(h.commits(), 1);
  });
});
test("atomicity, exact period/identity and ticket hash are checked before transport commit", async () => {
  for (const change of ["atomic", "hash", "team", "week", "evidence", "expired"]) await harness("set_lineup", async h => {
    const prepare = h.transport.prepare;
    h.transport.prepare = async (...args) => ({ ...await prepare(...args), ...(change === "atomic" ? { atomic: false } : change === "hash" ? { snapshotHash: "wrong" } :
      change === "team" ? { teamId: "3" } : change === "week" ? { period: "3" } : change === "evidence" ? { controlsEvidenceHash: "not-proof" } : { expiresAt: at }) });
    assert.notEqual((await runGuardedOwnedAction(h.original, h.action, h.config, h.transport, h.ledger, h.clock)).status, "verified"); assert.equal(h.commits(), 0);
  });
});
test("stop and expiring source/window/approval during prepare prevent final gesture", async () => {
  for (const change of ["stop", "stale", "window", "approval"]) await harness("set_lineup", async h => {
    const prepare = h.transport.prepare;
    h.transport.prepare = async (...args) => { const ticket = await prepare(...args);
      if (change === "stop") await writeFile(h.config.emergencyStopPath, "stop");
      if (change === "stale") h.setTime("2026-09-15T22:02:00Z");
      if (change === "window") h.config.execution.policy.windows[0]!.closesAt = "2026-09-15T21:59:00Z";
      if (change === "approval") h.config.approval!.expiresAt = at;
      return ticket; };
    assert.notEqual((await runGuardedOwnedAction(h.original, h.action, h.config, h.transport, h.ledger, h.clock)).status, "verified"); assert.equal(h.commits(), 0);
  });
});
test("stop introduced by transport immediately before its callback prevents final gesture", async () => {
  await harness("set_lineup", async h => { const commit = h.transport.commit;
    h.transport.commit = async (...args) => { await writeFile(h.config.emergencyStopPath, "stop"); await commit(...args); };
    assert.notEqual((await runGuardedOwnedAction(h.original, h.action, h.config, h.transport, h.ledger, h.clock)).status, "verified"); assert.equal(h.commits(), 0); });
});
test("waivers require known initial queue and reject an equivalent already pending claim", async () => {
  for (const initial of ["unknown", "existing"]) await harness("waiver_claim", async h => {
    h.state.pendingClaims = initial === "unknown" ? null : claims("before", true);
    assert.equal((await runGuardedOwnedAction(h.original, h.action, h.config, h.transport, h.ledger, h.clock)).status, "blocked"); assert.equal(h.commits(), 0);
  });
});
test("cached, stale, unnormalized or wrong pending-page proof cannot verify a claim", async () => {
  for (const change of ["cached", "stale", "normalized", "wrong-page", "wrong-owner", "hash"]) await harness("waiver_claim", async h => {
    h.applied(); const proof = h.readback.pendingClaims!;
    if (change === "cached") proof.observation.observationId = "claims-before";
    if (change === "stale") proof.observation.capturedAt = "2026-09-15T21:00:00Z";
    if (change === "normalized") proof.normalized = false;
    if (change === "wrong-page") proof.observation.url = "https://football.fantasysports.yahoo.com/f1/100/2/transactions";
    if (change === "wrong-owner") proof.observation.dom.links[0]!.href = "https://football.fantasysports.yahoo.com/f1/100/3";
    proof.sourceHash = change === "hash" ? "wrong" : digest(proof.observation);
    assert.equal((await runGuardedOwnedAction(h.original, h.action, h.config, h.transport, h.ledger, h.clock)).status, "uncertain");
  });
});
test("one unresolved team action blocks a different fingerprint", async () => {
  await harness("set_lineup", async h => {
    await h.ledger.exclusive("100:2", async () => h.ledger.put({ actionId: "c".repeat(64), scope: "100:2", status: "uncertain", updatedAt: at }));
    assert.equal((await runGuardedOwnedAction(h.original, h.action, h.config, h.transport, h.ledger, h.clock)).code, "unresolved_team_action"); assert.equal(h.commits(), 0);
  });
});
