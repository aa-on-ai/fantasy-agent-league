import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionFingerprint } from "../src/execution/coordinator.js";
import { FileLedger } from "../src/execution/file-ledger.js";
import { digest, snapshotHash, type SeasonSnapshot } from "../src/manager/season.js";
import { managerContextHash, type ManagerContext, type ManagerPacket, type ManagerSource } from "../src/manager/codex-run.js";
import { loadOrCreateManagerIdentity } from "../src/manager/identity.js";
import { buildManagerContinuityContext, loadSeasonMemory } from "../src/manager/season-memory.js";
import { runSeasonManager, type SeasonRunOptions, type SeasonRunReceipt } from "../src/runtime/season-run.js";
import { ParticipantOutcomeWriter } from "../src/runtime/participant-outcome.js";
import type { OwnedObservation } from "../src/platforms/yahoo/owned-sources.js";
import type { OwnedState, OwnedActionReadback, OwnedAction } from "../src/platforms/yahoo/guarded-owned.js";

const at = "2026-09-15T22:00:00.000Z", end = "2026-09-15T23:00:00.000Z";
function observation(id: string): OwnedObservation {
  return { observationId: id, capturedAt: at, profileId: "fixture", url: "https://football.fantasysports.yahoo.com/f1/100/2",
    dom: { title: "fixture", text: "PRIVATE DOM MUST NOT ENTER MEMORY", headings: [], forms: [], controls: [], tables: [],
      links: [{ text: "My Team", href: "https://football.fantasysports.yahoo.com/f1/100/2", title: "", attributes: {} }] } };
}
async function harness(kind: OwnedAction["kind"], run: (h: {
  root: string; options: SeasonRunOptions; context: ManagerContext; packet: ManagerPacket; readback: OwnedActionReadback;
  events: () => ReturnType<typeof loadSeasonMemory>; commits: () => number;
}) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "participant-outcome-")));
  const directory = join(root, "participant");
  const identity = await loadOrCreateManagerIdentity(directory, { platform: "yahoo", leagueId: "100", teamId: "2" }, new Date(at));
  const player = (id: string, slot: string | null) => ({ id, slot, eligible: ["QB"], projectedPoints: 10,
    status: "active" as const, locked: false, dropLocked: false, canDrop: true, availability: "rostered" as const });
  const snapshot: SeasonSnapshot = { schemaVersion: 1, leagueId: "100", teamId: "2", period: "2", capturedAt: at, hash: "",
    rosterLimit: 2, waiverType: "rolling", slots: [{ id: "QB:1", position: "QB" }], roster: [player("11", "QB:1"), player("22", null)],
    available: [{ ...player("33", null), availability: kind === "waiver_claim" ? "waivers" : "free_agent" }] };
  snapshot.hash = snapshotHash(snapshot);
  const sources = ["roster", "rules", "news", "schedule", "locks", "projections", "pool", "drops", "pending_claims", "horizon", "transactions"].map(kind => {
    const content = { fixture: true };
    return { id: kind, kind: kind as ManagerSource["kind"], reference: `fixture:${kind}`, capturedAt: at, leagueId: "100", teamId: "2", period: "2",
      playerIds: ["11", "22", "33"], content, contentHash: digest(content) };
  });
  const phase = kind === "set_lineup" ? "lineup" : kind === "add_drop" ? "free_agents" : "waivers";
  const context: ManagerContext = { schemaVersion: 1, runId: "fixture-outcome", phase, strategy: "steady", strategyText: "Fixture strategy", contractText: "Fixture contract",
    snapshot, sources, continuity: buildManagerContinuityContext(identity, []), contextHash: "",
    policy: { allowedActions: [kind], tradesEnabled: false, windows: [{ kind, opensAt: at, closesAt: end }] } };
  context.contextHash = managerContextHash(context);
  const action: OwnedAction = kind === "set_lineup" ? { kind, lineup: { "QB:1": "22" }, projectedPoints: 10 } : { kind, addId: "33", dropId: "22", improvement: 2 };
  const packet: ManagerPacket = { schemaVersion: 1, runId: context.runId, contextHash: context.contextHash, snapshotHash: snapshot.hash, strategy: "steady", phase,
    createdAt: at, rankedActions: [{ decision: action, rationale: "Fixture decision only.", sourceIds: ["news", "projections"] }], unresolvedConstraints: [] };
  const claims = (id: string, applied: boolean) => { const o = observation(id); return { observation: o, sourceHash: digest(o), normalized: true,
    claims: applied ? [{ id: "claim-fixture", leagueId: "100", teamId: "2", period: "2", addId: "33", dropId: "22" }] : [] }; };
  const state: OwnedState = { observation: observation("before"), snapshot, lineupDeadlines: { "11": end, "22": end },
    acquisitionDeadlines: { "22": end, "33": end }, pendingClaims: claims("claims-before", false) };
  const after = structuredClone(snapshot);
  if (kind === "set_lineup") { after.roster[0]!.slot = null; after.roster[1]!.slot = "QB:1"; }
  if (kind === "add_drop") { after.roster[1] = { ...after.available[0]!, availability: "rostered" }; after.available = []; }
  after.hash = snapshotHash(after);
  const readback: OwnedActionReadback = { state: { ...state, observation: observation("after"), snapshot: after }, pendingClaims: claims("claims-after", kind === "waiver_claim") };
  let commits = 0;
  const options: SeasonRunOptions = { context, binding: { leagueId: "100", teamId: "2", maxAgeMs: 60000,
    strategyHash: digest(context.strategyText), contractHash: digest(context.contractText) }, participantDirectory: directory,
    emergencyStopPath: join(root, "stop"), receiptDirectory: join(root, "receipts"), clock: () => new Date(at), mode: "execute", decide: async () => packet,
    owned: { config: { profileId: "fixture", emergencyStopPath: join(root, "stop"), browserLedger: new FileLedger(join(root, "browser")),
      pendingClaimsPageUrl: "https://football.fantasysports.yahoo.com/f1/100/2", approval: { context: "disposable", leagueId: "100", teamId: "2", profileId: "fixture",
        actionId: actionFingerprint(snapshot, action), expiresAt: end, approvalReference: "fixture-only", isolatedSessionVerified: true, recoveryVerified: true },
      execution: { leagueId: "100", teamId: "2", maxAgeMs: 60000, writesEnabled: true, releaseSha: "a".repeat(40), runningSha: "a".repeat(40), verifiedCapabilities: [kind], policy: context.policy } },
      ledger: new FileLedger(join(root, "ledger")), transport: { read: async () => state,
        prepare: async () => ({ actionId: actionFingerprint(snapshot, action), observationId: "before", snapshotHash: snapshot.hash,
          leagueId: "100", teamId: "2", period: "2", atomic: true, controlsEvidenceHash: "a".repeat(64), expiresAt: end }),
        commit: async (_prepared, guard) => { await guard();
          // This checks ordering at the actual dispatch boundary, not just final state.
          assert.ok((await loadSeasonMemory(directory, identity)).some(event => event.status === "proposed")); commits++; },
        readback: async () => readback } } };
  try { await run({ root, options, context, packet, readback, events: () => loadSeasonMemory(directory, identity), commits: () => commits }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("owned lineup, pickup and pending-claim outcomes carry the actual readback through the attribution chain", async () => {
  for (const kind of ["set_lineup", "add_drop", "waiver_claim"] as const) await harness(kind, async h => {
    const receipt = await runSeasonManager(h.options);
    assert.equal(receipt.status, "verified", JSON.stringify(receipt)); assert.equal(receipt.memory?.actionAttributed, true);
    const events = await h.events(); assert.equal(events.length, 4);
    const verified = events.find(event => event.status === "verified")!;
    const executed = events.find(event => event.status === "executed")!;
    const proposal = events.find(event => event.status === "proposed")!;
    assert.deepEqual(executed.relatedEventIds, [proposal.id]); assert.deepEqual(verified.relatedEventIds, [executed.id]);
    assert.equal(verified.evidence[0]!.kind, "independent_readback");
    assert.equal((verified.evidence[0]!.content as any).readback.snapshot.hash, h.readback.state.snapshot.hash);
    assert.notEqual(verified.evidence[0]!.reference, executed.evidence[0]!.reference);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE DOM MUST NOT ENTER MEMORY/);
    if (kind === "waiver_claim") assert.equal(verified.facts.result, "claim_pending");
    assert.equal(h.commits(), 1);
    const duplicate = await runSeasonManager(h.options);
    assert.equal(duplicate.status, "already_verified"); assert.equal(h.commits(), 1);
    assert.equal((await h.events()).filter(event => event.status === "verified").length, 1);
    assert.equal((await h.events()).filter(event => event.status === "proposed").length, 1);
  });
});
test("review, blocked and justified no-action remain nonexecuted memory", async () => {
  for (const mode of ["review", "blocked", "no_action"]) await harness("set_lineup", async h => {
    if (mode === "review") h.options.mode = "review";
    if (mode === "blocked") h.options.owned!.config.execution.writesEnabled = false;
    if (mode === "no_action") h.packet.rankedActions[0]!.decision = { kind: "no_action", reason: "Keep legal lineup" };
    const receipt = await runSeasonManager(h.options);
    assert.equal(receipt.status, mode === "review" ? "reviewed" : mode);
    assert.equal(receipt.memory?.status, "recorded"); assert.equal(receipt.memory.actionAttributed, false);
    const events = await h.events(); assert.equal(events.length, 2);
    assert.equal(events.filter(event => ["verified", "executed", "uncertain"].includes(event.status)).length, 0);
    assert.equal(events.find(event => event.kind === "observation")!.facts.status, receipt.status); assert.equal(h.commits(), 0);
  });
});
test("uncertain readback remains unresolved and a duplicate does not resubmit", () => harness("set_lineup", async h => {
  h.options.owned!.transport.readback = async () => { throw new Error("fixture missing readback"); };
  const first = await runSeasonManager(h.options), second = await runSeasonManager(h.options);
  assert.equal(first.status, "uncertain"); assert.equal(second.status, "uncertain"); assert.equal(h.commits(), 1);
  const events = await h.events(); assert.equal(events.filter(event => event.status === "uncertain").length, 1);
  assert.equal(events.filter(event => event.status === "verified").length, 0);
}));
test("proposal persistence failure blocks before transport; state is never silently recreated", () => harness("set_lineup", async h => {
  h.options.decide = async () => { await rm(join(h.options.participantDirectory!, "identity.json")); return h.packet; };
  let reads = 0; h.options.owned!.transport.read = async () => { reads++; throw Error("must not read"); };
  const receipt = await runSeasonManager(h.options);
  assert.equal(receipt.status, "blocked"); assert.equal(receipt.code, "participant_proposal_persistence_failed");
  assert.equal(receipt.memory?.status, "failed"); assert.equal(h.commits(), 0); assert.equal(reads, 0);
  await assert.rejects(readFile(join(h.options.participantDirectory!, "identity.json")), { code: "ENOENT" });
}));
test("post-submission memory failure remains explicit with exact outcome artifact and no second commit", () => harness("set_lineup", async h => {
  const readback = h.options.owned!.transport.readback;
  h.options.owned!.transport.readback = async () => {
    const result = await readback();
    await writeFile(join(h.options.participantDirectory!, "events", "invalid-file"), "fixture persistence corruption");
    return result;
  };
  const receipt = await runSeasonManager(h.options);
  assert.equal(receipt.status, "uncertain"); assert.equal(receipt.code, "participant_outcome_persistence_failed");
  assert.equal(receipt.execution?.status, "verified"); assert.equal(receipt.memory?.status, "failed"); assert.equal(h.commits(), 1);
  const outcomeName = (await readdir(h.options.receiptDirectory)).find(name => name.endsWith(".outcome.json"))!;
  const stored = JSON.parse(await readFile(join(h.options.receiptDirectory, outcomeName), "utf8"));
  assert.equal(stored.receipt.status, "verified"); assert.equal(stored.ownedEvidence.readback.observation.observationId, "after");
  assert.equal((await runSeasonManager(h.options)).code, "participant_memory_unavailable"); assert.equal(h.commits(), 1);
}));
test("sandbox context cannot write into production identity", () => harness("set_lineup", async h => {
  const production = join(h.root, "production-participant");
  const identity = await loadOrCreateManagerIdentity(production, { platform: "yahoo", leagueId: "425299", teamId: "11" }, new Date(at));
  h.options.participantDirectory = production;
  let decisions = 0; h.options.decide = async () => { decisions++; return h.packet; };
  const receipt = await runSeasonManager(h.options);
  assert.equal(receipt.code, "participant_memory_unavailable"); assert.equal(decisions, 0); assert.equal(h.commits(), 0);
  assert.deepEqual(await loadSeasonMemory(production, identity), []);
}));
test("a bare verified receipt without a captured independent readback cannot confer successful-action attribution", () => harness("set_lineup", async h => {
  const writer = await ParticipantOutcomeWriter.open(h.options.participantDirectory!, h.context, "execute");
  await writer.recordProposal(h.packet, "fixture:decision", at);
  const receipt: SeasonRunReceipt = { schemaVersion: 1, attemptId: "fixture", runId: h.context.runId, contextHash: h.context.contextHash,
    packetHash: digest(h.packet), mode: "execute", status: "verified", code: "independent_readback_passed", applied: true, createdAt: at,
    execution: { status: "verified", code: "independent_readback_passed", actionId: actionFingerprint(h.context.snapshot, h.packet.rankedActions[0]!.decision) } };
  const recorded = await writer.recordOutcome(receipt, "fixture:receipt");
  assert.equal(recorded.actionAttributed, false);
  assert.deepEqual(await writer.recordOutcome(receipt, "fixture:receipt"), recorded);
  assert.equal((await h.events()).filter(event => event.status === "verified").length, 0);
  assert.equal((await h.events()).length, 2);
}));
