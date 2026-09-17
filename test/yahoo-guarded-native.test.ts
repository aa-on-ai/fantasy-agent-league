import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLedger } from "../src/execution/file-ledger.js";
import { actionFingerprint } from "../src/execution/coordinator.js";
import { digest, snapshotHash, type Decision, type SeasonSnapshot } from "../src/manager/season.js";
import { runGuardedNativeAction, type GuardedNativeConfig, type NativeTransport, type NativeState, type NativeActionReadback } from "../src/platforms/yahoo/guarded-native.js";

const at = "2026-09-09T03:00:00Z", end = "2026-09-09T04:00:00Z";
const capture = (suffix = "") => `0 standard window Example, ID: disposable-window, Secondary Actions: Raise
  4 HTML content Description: Example | Yahoo! Sports, URL: football.fantasysports.yahoo.com/f1/100/2${suffix}
    24 link My Team, Value: football.fantasysports.yahoo.com/f1/100/2
    65 text Example`;
function snapshot(): SeasonSnapshot {
  const p = (id: string, slot: string | null) => ({ id, slot, eligible: ["QB"], projectedPoints: 10, status: "active" as const, locked: false, dropLocked: false, canDrop: true, availability: "rostered" as const });
  const s: SeasonSnapshot = { schemaVersion: 1, leagueId: "100", teamId: "2", period: "1", capturedAt: at, hash: "", slots: [{ id: "QB:1", position: "QB" }], rosterLimit: 2, waiverType: "rolling",
    roster: [p("one", "QB:1"), p("two", null)], available: [{ ...p("three", null), availability: "free_agent" }] };
  s.hash = snapshotHash(s); return s;
}
async function harness(kind: "set_lineup" | "add_drop" | "waiver_claim", run: (h: {
  s: SeasonSnapshot; action: Decision; config: GuardedNativeConfig; transport: NativeTransport; ledger: FileLedger;
  state: NativeState; readback: NativeActionReadback; clock: () => Date; setTime: (s: string) => void; commits: () => number;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "yahoo-native-guard-"));
  const s = snapshot();
  if (kind === "waiver_claim") { s.available[0]!.availability = "waivers"; s.hash = snapshotHash(s); }
  const action: Decision = kind === "set_lineup" ? { kind, lineup: { "QB:1": "two" }, projectedPoints: 10 } : { kind, addId: "three", dropId: "two", improvement: 2 };
  const config: GuardedNativeConfig = { teamName: "Example", profileId: "disposable-profile", windowId: "disposable-window", emergencyStopPath: join(root, "stop"), browserLedger: new FileLedger(join(root, "browser")), pendingClaimsPageUrl: null,
    execution: { leagueId: "100", teamId: "2", maxAgeMs: 60000, writesEnabled: true, releaseSha: "a".repeat(40), runningSha: "a".repeat(40), verifiedCapabilities: [kind],
      policy: { allowedActions: [kind], tradesEnabled: false, windows: [{ kind, opensAt: at, closesAt: end }] } },
    approval: { context: "disposable", leagueId: "100", teamId: "2", profileId: "disposable-profile", actionId: actionFingerprint(s, action), approvalReference: "sanitized-owner-test-approval", expiresAt: end, isolatedSessionVerified: true, recoveryVerified: true } };
  const state: NativeState = { observationId: "before", profileId: config.profileId, windowId: config.windowId, capture: capture(), snapshot: structuredClone(s), lineupDeadlines: { one: end, two: end }, acquisitionDeadlines: { two: end, three: end } };
  const readback: NativeActionReadback = { state: { ...structuredClone(state), observationId: "after" }, pendingClaims: [], pendingClaimsCapture: null, pendingClaimsCapturedAt: null, pendingClaimsNormalized: false, pendingClaimsSourceHash: null };
  let commits = 0, current = at;
  const transport: NativeTransport = {
    read: async () => state,
    prepare: async () => ({ actionId: actionFingerprint(s, action), observationId: state.observationId, snapshotHash: state.snapshot.hash, atomic: true, controlsEvidenceHash: "b".repeat(64), expiresAt: end }),
    commit: async (_p, guard) => { await guard(); commits++; },
    readback: async () => readback
  };
  try { await run({ s, action, config, transport, ledger: new FileLedger(join(root, "actions")), state, readback, clock: () => new Date(current), setTime: t => { current = t; }, commits: () => commits }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
test("real league cannot be enabled by toggling the write flag or supplying test approval", async () => {
  await harness("set_lineup", async h => {
    h.config.execution.leagueId = "425299";
    const r = await runGuardedNativeAction(h.s, h.action, h.config, h.transport, h.ledger, h.clock);
    assert.equal(r.code, "real_team_writes_disabled"); assert.equal(h.commits(), 0);
  });
});
test("requires exact disposable identity, action, isolation, recovery and unexpired approval", async () => {
  for (const change of ["missing", "action", "profile", "expired", "isolation", "recovery"]) await harness("set_lineup", async h => {
    if (change === "missing") h.config.approval = null;
    if (change === "action") h.config.approval!.actionId = "different";
    if (change === "profile") h.config.approval!.profileId = "observer";
    if (change === "expired") h.config.approval!.expiresAt = at;
    if (change === "isolation") h.config.approval!.isolatedSessionVerified = false;
    if (change === "recovery") h.config.approval!.recoveryVerified = false;
    assert.equal((await runGuardedNativeAction(h.s, h.action, h.config, h.transport, h.ledger, h.clock)).code, "disposable_approval_required"); assert.equal(h.commits(), 0);
  });
});
test("fresh identity and player deadlines are checked before any submission", async () => {
  for (const change of ["identity", "profile", "window", "missing-lock", "closed-lock"]) await harness("set_lineup", async h => {
    if (change === "identity") h.state.capture = capture().replace("/100/2\n", "/100/9\n");
    if (change === "profile") h.state.profileId = "observer";
    if (change === "window") h.state.windowId = "different-window";
    if (change === "missing-lock") delete h.state.lineupDeadlines.two;
    if (change === "closed-lock") h.state.lineupDeadlines.two = at;
    assert.equal((await runGuardedNativeAction(h.s, h.action, h.config, h.transport, h.ledger, h.clock)).status, "blocked"); assert.equal(h.commits(), 0);
  });
});
test("a click without independent applied lineup readback is uncertain and never retried", async () => {
  await harness("set_lineup", async h => {
    const first = await runGuardedNativeAction(h.s, h.action, h.config, h.transport, h.ledger, h.clock);
    assert.equal(first.status, "uncertain");
    const second = await runGuardedNativeAction(h.s, h.action, h.config, h.transport, h.ledger, h.clock);
    assert.equal(second.code, "manual_reconciliation_required"); assert.equal(h.commits(), 1);
  });
});
test("lineup verifies exact independent assignments; cached observation cannot verify", async () => {
  for (const cached of [true, false]) await harness("set_lineup", async h => {
    const s = h.readback.state.snapshot; s.roster[0]!.slot = null; s.roster[1]!.slot = "QB:1"; s.hash = snapshotHash(s);
    if (cached) h.readback.state.observationId = "before";
    assert.equal((await runGuardedNativeAction(h.s, h.action, h.config, h.transport, h.ledger, h.clock)).status, cached ? "uncertain" : "verified");
  });
});
test("atomicity and prepared snapshot binding fail before commit", async () => {
  for (const change of ["atomic", "snapshot"]) await harness("set_lineup", async h => {
    const prepare = h.transport.prepare;
    h.transport.prepare = async (...args) => ({ ...await prepare(...args), ...(change === "atomic" ? { atomic: false } : { snapshotHash: "wrong" }) });
    const r = await runGuardedNativeAction(h.s, h.action, h.config, h.transport, h.ledger, h.clock);
    assert.equal(r.status, "uncertain"); assert.equal(h.commits(), 0);
  });
});
test("stop, source expiry and action-window closure during preparation block the final gesture", async () => {
  for (const change of ["stop", "stale", "window"]) await harness("set_lineup", async h => {
    const prepare = h.transport.prepare;
    h.transport.prepare = async (...args) => {
      if (change === "stop") await writeFile(h.config.emergencyStopPath, "stop");
      if (change === "stale") h.setTime("2026-09-09T03:02:00Z");
      if (change === "window") { h.config.execution.policy.windows[0]!.closesAt = "2026-09-09T03:00:01Z"; h.setTime("2026-09-09T03:00:02Z"); }
      return prepare(...args);
    };
    assert.equal((await runGuardedNativeAction(h.s, h.action, h.config, h.transport, h.ledger, h.clock)).status, "uncertain"); assert.equal(h.commits(), 0);
  });
});
test("add/drop requires both ownership changes and preserves all other roster identities", async () => {
  for (const complete of [false, true]) await harness("add_drop", async h => {
    const s = h.readback.state.snapshot;
    s.roster = s.roster.filter(p => p.id !== "two");
    if (complete) { s.roster.push({ ...s.available[0]!, availability: "rostered" }); s.available = []; }
    s.hash = snapshotHash(s);
    assert.equal((await runGuardedNativeAction(h.s, h.action, h.config, h.transport, h.ledger, h.clock)).status, complete ? "verified" : "uncertain");
  });
});
test("waiver acceptance needs an owned, fresh, independently normalized pending-claim capture", async () => {
  for (const proven of [false, true]) await harness("waiver_claim", async h => {
    h.readback.pendingClaims = [{ leagueId: "100", teamId: "2", period: "1", addId: "three", dropId: "two", id: "sanitized-claim" }];
    if (proven) {
      // Sanitized host-port contract fixture; this is not a claim that this route
      // or confirmation control was observed in Yahoo's competitive account.
      h.config.pendingClaimsPageUrl = "football.fantasysports.yahoo.com/f1/100/2/test-claims";
      h.readback.pendingClaimsCapture = capture("/test-claims"); h.readback.pendingClaimsCapturedAt = at;
      h.readback.pendingClaimsNormalized = true; h.readback.pendingClaimsSourceHash = digest(h.readback.pendingClaimsCapture);
    }
    assert.equal((await runGuardedNativeAction(h.s, h.action, h.config, h.transport, h.ledger, h.clock)).status, proven ? "verified" : "uncertain");
  });
});
test("uncertain pending operation reconciles applied state without another commit", async () => {
  await harness("add_drop", async h => {
    assert.equal((await runGuardedNativeAction(h.s, h.action, h.config, h.transport, h.ledger, h.clock)).status, "uncertain");
    const s = h.readback.state.snapshot; s.roster[1] = { ...s.available[0]!, availability: "rostered" }; s.available = []; s.hash = snapshotHash(s);
    const r = await runGuardedNativeAction(h.s, h.action, h.config, h.transport, h.ledger, h.clock);
    assert.equal(r.code, "reconciled_without_resubmission"); assert.equal(h.commits(), 1);
  });
});

test("fresh native readback retains the oldest supporting source age", async () => {
  await harness("set_lineup", async h => {
    const s = h.readback.state.snapshot;
    s.roster[0]!.slot = null; s.roster[1]!.slot = "QB:1"; s.hash = snapshotHash(s);
    h.setTime("2026-09-09T03:00:10Z");
    h.readback.state.nativeCapturedAt = "2026-09-09T03:00:10Z";
    assert.equal((await runGuardedNativeAction(h.s, h.action, h.config, h.transport, h.ledger, h.clock)).status, "verified");
  });
});
test("future native readback timestamp cannot validate a transaction", async () => {
  await harness("set_lineup", async h => {
    h.readback.state.nativeCapturedAt = end;
    assert.notEqual((await runGuardedNativeAction(h.s, h.action, h.config, h.transport, h.ledger, h.clock)).status, "verified");
  });
});
