import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, readdir, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { digest, snapshotHash, type SeasonSnapshot } from "../src/manager/season.js";
import { DEFAULT_MANAGER_SCOPE, loadManagerIdentity, loadOrCreateManagerIdentity, managerIdentityHash,
  type ManagerIdentity, type ManagerScope } from "../src/manager/identity.js";
import { appendSeasonMemoryEvent, buildManagerContinuityContext, buildManagerWritingRequest, loadSeasonMemory,
  validateManagerContinuityContext, type MemoryEvidence, type SeasonMemoryEventInput } from "../src/manager/season-memory.js";
import { codexDecisionInstructions, managerContextHash, validateManagerContext, type ManagerContext } from "../src/manager/codex-run.js";

const at = "2026-09-15T22:40:00.000Z", later = "2026-09-15T22:41:00.000Z";
const scope: ManagerScope = { ...DEFAULT_MANAGER_SCOPE };
const actionId = digest("sanitized-lineup-action-fixture");
async function fixture(run: (root: string, identity: ManagerIdentity) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "manager-memory-")));
  await chmod(root, 0o700);
  try { await run(root, await loadOrCreateManagerIdentity(join(root, "participant"), scope, new Date(at))); }
  finally { await rm(root, { recursive: true, force: true }); }
}
function evidence(kind: MemoryEvidence["kind"], suffix = kind): MemoryEvidence {
  const content = { fixture: true, kind, note: suffix, actionId, status: "verified", result: "applied" };
  return { kind, scope: { ...scope }, reference: `fixture:${suffix}`, capturedAt: at, content, contentHash: digest(content) };
}
function report(): SeasonMemoryEventInput {
  return { key: "owner-report-week-one", scope: { ...scope }, season: "2026", period: "1", occurredAt: at, runId: null,
    kind: "matchup", status: "reported", actor: "owner", subject: "matchup:week1:result", summary: "Owner reports the debut was a loss; score and opponent are not verified.",
    facts: { outcome: "loss", score: null, opponent: null }, actionId: null, relatedEventIds: [], evidence: [evidence("owner_report")] };
}
function proposal(): SeasonMemoryEventInput {
  return { key: "run-1:lineup:proposed", scope: { ...scope }, season: "2026", period: "2", occurredAt: at, runId: "run-1",
    kind: "action", status: "proposed", actor: "manager", subject: "action:lineup:one", summary: "Fixture lineup proposal, not a live move.",
    facts: { kind: "set_lineup" }, actionId, relatedEventIds: [], evidence: [evidence("decision_packet")] };
}

test("independent cold-start processes share one scoped identity, factual history, reflection and intention", async () => fixture(async (root, identity) => {
  const directory = join(root, "participant");
  const first = (await appendSeasonMemoryEvent(directory, identity, report())).event;
  await appendSeasonMemoryEvent(directory, identity, { ...report(), key: "debut-reflection", kind: "reflection", status: "authored", actor: "manager",
    summary: "Authored fixture reaction: I want to understand what happened before promising a comeback.", facts: {}, relatedEventIds: [first.id], evidence: [] });
  await appendSeasonMemoryEvent(directory, identity, { ...report(), key: "name-intention", kind: "intention", status: "authored", actor: "manager",
    summary: "Fixture preference retained for a later turn, not an applied team rename.", facts: { proposedName: "Fixture name", applied: false }, relatedEventIds: [first.id], evidence: [] });
  const code = `import { loadManagerIdentity } from './dist/src/manager/identity.js';
    import { loadSeasonMemory, buildManagerContinuityContext } from './dist/src/manager/season-memory.js';
    const identity = await loadManagerIdentity(process.argv[1]);
    console.log(JSON.stringify(buildManagerContinuityContext(identity, await loadSeasonMemory(process.argv[1], identity))));`;
  const cold = spawnSync(process.execPath, ["--input-type=module", "-e", code, directory], { encoding: "utf8" });
  assert.equal(cold.status, 0, cold.stderr);
  const resumed = JSON.parse(cold.stdout);
  assert.equal(resumed.identity.id, identity.id); assert.equal(resumed.events.length, 3);
  assert.equal(resumed.events.find((e: any) => e.status === "reported").facts.outcome, "loss");
  assert.ok(resumed.issues.some((issue: any) => issue.code === "unverified_report"));
  assert.equal(resumed.events.find((e: any) => e.kind === "intention").facts.applied, false);
  assert.equal((await loadOrCreateManagerIdentity(directory, scope, new Date(later))).hash, identity.hash);
}));

test("identity is private, stable and character-seeded from owner direction without inventing history", async () => fixture(async (root, identity) => {
  assert.equal(identity.id, "yahoo:f1:425299:team:11");
  assert.match(identity.character.origin, /unfamiliar world/);
  assert.equal(identity.expression.publication, "review_required");
  assert.equal(identity.displayName, null);
  assert.equal((await stat(join(root, "participant"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, "participant", "identity.json"))).mode & 0o777, 0o600);
  const empty = buildManagerContinuityContext(identity, await loadSeasonMemory(join(root, "participant"), identity));
  assert.equal(empty.evidenceState, "empty"); assert.equal(empty.issues[0]!.code, "missing_season_history");
  assert.deepEqual(empty.verifiedManagerActionIds, []);
}));

test("repeated source intake deduplicates; same occurrence with changed facts is a conflict, never an overwrite", async () => fixture(async (root, identity) => {
  const directory = join(root, "participant"), input = report();
  const first = await appendSeasonMemoryEvent(directory, identity, input), second = await appendSeasonMemoryEvent(directory, identity, input);
  assert.equal(first.duplicate, false); assert.equal(second.duplicate, true); assert.equal(first.event.hash, second.event.hash);
  await assert.rejects(appendSeasonMemoryEvent(directory, identity, { ...input, facts: { outcome: "win" } }), /occurrence_conflict/);
  const events = await loadSeasonMemory(directory, identity); assert.equal(events.length, 1); assert.equal(events[0]!.facts.outcome, "loss");
  assert.equal((await stat(join(directory, "events", `${first.event.id}.json`))).mode & 0o777, 0o600);
}));

test("identity, input and provenance cannot cross league/team boundaries", async () => fixture(async (root, identity) => {
  const directory = join(root, "participant"), other = { ...scope, teamId: "12" };
  await assert.rejects(loadOrCreateManagerIdentity(directory, other), /scope_mismatch/);
  await assert.rejects(appendSeasonMemoryEvent(directory, identity, { ...report(), scope: other }), /scope_mismatch/);
  const wrongEvidence = report(); wrongEvidence.evidence[0]!.scope = other;
  await assert.rejects(appendSeasonMemoryEvent(directory, identity, wrongEvidence), /scope_mismatch/);
  const differentIdentity = structuredClone(identity); differentIdentity.createdAt = later; differentIdentity.hash = managerIdentityHash(differentIdentity);
  await assert.rejects(appendSeasonMemoryEvent(directory, differentIdentity, report()), /store_mismatch/);
}));

test("missing and tampered provenance are rejected, source observation times remain unchanged", async () => fixture(async (root, identity) => {
  const directory = join(root, "participant");
  await assert.rejects(appendSeasonMemoryEvent(directory, identity, { ...report(), evidence: [] }), /missing_memory_evidence/);
  const bad = report(); bad.evidence[0]!.content = { changed: "without rehash" };
  await assert.rejects(appendSeasonMemoryEvent(directory, identity, bad), /invalid_memory_evidence/);
  const valid = report(); valid.evidence[0]!.capturedAt = "2026-09-14T22:00:00.000Z";
  await appendSeasonMemoryEvent(directory, identity, valid);
  assert.equal((await loadSeasonMemory(directory, identity))[0]!.evidence[0]!.capturedAt, valid.evidence[0]!.capturedAt);
}));

test("a proposal or owner-reported result cannot become a successful manager action without execution and independent readback", async () => fixture(async (root, identity) => {
  const directory = join(root, "participant"), input = proposal();
  const proposed = (await appendSeasonMemoryEvent(directory, identity, input)).event;
  const verified = { ...input, key: "run-1:lineup:verified", status: "verified" as const, relatedEventIds: [proposed.id], evidence: [evidence("independent_readback")] };
  await assert.rejects(appendSeasonMemoryEvent(directory, identity, verified), /unproven_manager_action_attribution/);
  const executed = (await appendSeasonMemoryEvent(directory, identity, { ...input, key: "run-1:lineup:executed", status: "executed",
    relatedEventIds: [proposed.id], evidence: [evidence("execution_receipt")] })).event;
  let context = buildManagerContinuityContext(identity, await loadSeasonMemory(directory, identity));
  assert.deepEqual(context.verifiedManagerActionIds, []); assert.ok(context.issues.some(issue => issue.code === "unresolved_action"));
  const copiedReceipt = { ...evidence("execution_receipt"), kind: "independent_readback" as const };
  await assert.rejects(appendSeasonMemoryEvent(directory, identity, { ...verified, relatedEventIds: [executed.id], evidence: [copiedReceipt] }), /not_independent/);
  await appendSeasonMemoryEvent(directory, identity, { ...verified, relatedEventIds: [executed.id] });
  context = buildManagerContinuityContext(identity, await loadSeasonMemory(directory, identity));
  assert.deepEqual(context.verifiedManagerActionIds, [actionId]);
  assert.equal(context.issues.some(issue => issue.code === "unresolved_action"), false);
}));

test("uncertain submissions retain uncertainty; historical platform moves never become the manager's own moves", async () => fixture(async (root, identity) => {
  const directory = join(root, "participant"), input = proposal();
  const proposed = (await appendSeasonMemoryEvent(directory, identity, input)).event;
  const uncertain = evidence("execution_receipt"); uncertain.content = { actionId, status: "uncertain" }; uncertain.contentHash = digest(uncertain.content);
  await appendSeasonMemoryEvent(directory, identity, { ...input, key: "uncertain", status: "uncertain", relatedEventIds: [proposed.id], evidence: [uncertain] });
  const historical = evidence("independent_readback"); historical.content = { actionId, result: "applied" }; historical.contentHash = digest(historical.content);
  await appendSeasonMemoryEvent(directory, identity, { ...input, key: "historical-action", runId: null,
    status: "verified", actor: "unknown", evidence: [historical] });
  const context = buildManagerContinuityContext(identity, await loadSeasonMemory(directory, identity));
  assert.deepEqual(context.verifiedManagerActionIds, []); assert.ok(context.issues.some(issue => issue.code === "unresolved_action"));
  const request = buildManagerWritingRequest(context, { season: "2026", period: "1", brief: "Personal debut draft." });
  assert.equal(request.publish, false); assert.match(request.instructions, /Unknown or human actors are not your actions/);
}));

test("oversized source bundles are rejected before writing unreadable season state", async () => fixture(async (root, identity) => {
  const input = report();
  input.evidence = Array.from({ length: 20 }, () => {
    const source = evidence("owner_report"); source.content = { text: "x".repeat(90000) }; source.contentHash = digest(source.content); return source;
  });
  await assert.rejects(appendSeasonMemoryEvent(join(root, "participant"), identity, input), /event_too_large/);
  assert.deepEqual(await loadSeasonMemory(join(root, "participant"), identity), []);
}));

test("contradictory match facts remain visible rather than newest source silently winning", async () => fixture(async (root, identity) => {
  const directory = join(root, "participant");
  await appendSeasonMemoryEvent(directory, identity, report());
  await appendSeasonMemoryEvent(directory, identity, { ...report(), key: "platform-result", status: "verified", actor: "platform", facts: { outcome: "win" }, evidence: [evidence("independent_readback")] });
  const context = buildManagerContinuityContext(identity, await loadSeasonMemory(directory, identity));
  assert.equal(context.evidenceState, "conflict"); assert.equal(context.issues.find(issue => issue.code === "conflicting_facts")!.eventIds.length, 2);
}));

test("a verified score resolves null unknowns without manufacturing a fact conflict", async () => fixture(async (root, identity) => {
  const directory = join(root, "participant");
  await appendSeasonMemoryEvent(directory, identity, report());
  await appendSeasonMemoryEvent(directory, identity, { ...report(), key: "platform-score", status: "verified", actor: "platform",
    facts: { outcome: "loss", score: 42.5, opponent: "Fixture opponent" }, evidence: [evidence("independent_readback")] });
  assert.equal(buildManagerContinuityContext(identity, await loadSeasonMemory(directory, identity)).evidenceState, "found");
}));

test("blocked or no-action receipts, wrong actions and negative readbacks cannot be promoted to successful execution", async () => fixture(async (root, identity) => {
  const directory = join(root, "participant"), input = proposal();
  const proposed = (await appendSeasonMemoryEvent(directory, identity, input)).event;
  for (const status of ["blocked", "no_action", "already_verified"]) {
    const source = evidence("execution_receipt"); source.content = { actionId, status }; source.contentHash = digest(source.content);
    await assert.rejects(appendSeasonMemoryEvent(directory, identity, { ...input, key: status, status: "executed", relatedEventIds: [proposed.id], evidence: [source] }), /execution_status_mismatch/);
  }
  const wrongAction = evidence("execution_receipt"); wrongAction.content = { actionId: digest("wrong"), status: "verified" }; wrongAction.contentHash = digest(wrongAction.content);
  await assert.rejects(appendSeasonMemoryEvent(directory, identity, { ...input, key: "wrong-action", status: "executed", relatedEventIds: [proposed.id], evidence: [wrongAction] }), /action_evidence_mismatch/);
  const negative = evidence("independent_readback"); negative.content = { actionId, result: "not_applied" }; negative.contentHash = digest(negative.content);
  await assert.rejects(appendSeasonMemoryEvent(directory, identity, { ...input, key: "negative-readback", status: "verified", evidence: [negative] }), /does_not_verify_action/);
}));

test("a reaction requires recorded experience and cannot be passed off as an observed fact", async () => fixture(async (root, identity) => {
  const directory = join(root, "participant");
  await assert.rejects(appendSeasonMemoryEvent(directory, identity, { ...report(), kind: "reflection", status: "observed", actor: "manager" }), /invalid_authored_memory/);
  await assert.rejects(appendSeasonMemoryEvent(directory, identity, { ...report(), kind: "reflection", status: "authored", actor: "manager", evidence: [], relatedEventIds: [digest("missing")] }), /missing_or_future_memory_reference/);
}));

test("stored history tampering, missing identity and symlinked memory cannot silently recreate the manager", async () => fixture(async (root, identity) => {
  const directory = join(root, "participant");
  const event = (await appendSeasonMemoryEvent(directory, identity, report())).event;
  const path = join(directory, "events", `${event.id}.json`);
  const changed = JSON.parse(await readFile(path, "utf8")); changed.summary = "Tampered";
  await writeFile(path, JSON.stringify(changed));
  await assert.rejects(loadSeasonMemory(directory, identity), /integrity_mismatch/);
  const alias = join(root, "alias"); await symlink(directory, alias);
  await assert.rejects(loadOrCreateManagerIdentity(alias), /unsafe_manager_memory_path/);
  await rm(join(directory, "identity.json"));
  await assert.rejects(loadOrCreateManagerIdentity(directory), /missing_with_existing_state/);
}));

function decisionContext(identity: ManagerIdentity): ManagerContext {
  const snapshot: SeasonSnapshot = { schemaVersion: 1, leagueId: scope.leagueId, teamId: scope.teamId, period: "2", capturedAt: at, hash: "",
    roster: [{ id: "fixture-player", eligible: ["QB"], slot: "QB:1", projectedPoints: 10, locked: false, canDrop: false, status: "active", availability: "rostered" }],
    available: [], slots: [{ id: "QB:1", position: "QB" }], rosterLimit: 1, waiverType: "rolling" };
  snapshot.hash = snapshotHash(snapshot);
  const context: ManagerContext = { schemaVersion: 1, runId: "continuity-fixture", phase: "lineup", strategy: "steady", strategyText: "Fixture strategy", contractText: "Fixture contract",
    continuity: buildManagerContinuityContext(identity, []), snapshot,
    sources: ["roster", "rules", "schedule", "locks", "news", "projections"].map(kind => ({ id: kind, kind: kind as any, reference: "fixture:" + kind,
      capturedAt: at, leagueId: scope.leagueId, teamId: scope.teamId, period: "2", playerIds: ["fixture-player"], content: { fixture: true }, contentHash: digest({ fixture: true }) })),
    policy: { allowedActions: ["set_lineup"], tradesEnabled: false, windows: [{ kind: "set_lineup", opensAt: at, closesAt: later }] }, contextHash: "" };
  context.contextHash = managerContextHash(context); return context;
}

test("decision and writing paths consume the same hash-bound identity/history; neither gets a second persona", async () => fixture(async (root, identity) => {
  const directory = join(root, "participant"), context = decisionContext(identity);
  await appendSeasonMemoryEvent(directory, identity, report());
  context.continuity = buildManagerContinuityContext(identity, await loadSeasonMemory(directory, identity));
  context.contextHash = managerContextHash(context);
  const binding = { ...scope, maxAgeMs: 60000, strategyHash: digest(context.strategyText), contractHash: digest(context.contractText) };
  assert.equal(validateManagerContext(context, binding, new Date(at)), context);
  assert.match(codexDecisionInstructions(context), /persistent league participant yahoo:f1:425299:team:11/);
  const writing = buildManagerWritingRequest(context.continuity, { season: "2026", period: "1", brief: "Draft the debut." });
  assert.equal(writing.continuity.hash, context.continuity.hash); assert.equal(writing.continuity.identity.id, identity.id);
  writing.continuity.events[0]!.facts.outcome = "win";
  assert.equal(context.continuity.events[0]!.facts.outcome, "loss");
  assert.throws(() => validateManagerContinuityContext(writing.continuity, scope), /integrity_mismatch/);
  const wrongScope = { ...scope, teamId: "2" };
  assert.throws(() => validateManagerContinuityContext(context.continuity, wrongScope), /scope_mismatch/);
  context.continuity.verifiedManagerActionIds = [actionId]; context.contextHash = managerContextHash(context);
  assert.throws(() => validateManagerContext(context, binding, new Date(at)), /continuity_integrity_mismatch/);
}));

test("unprivate existing state is rejected without changing host permissions", async () => fixture(async (root, identity) => {
  const directory = join(root, "participant"); await chmod(directory, 0o755);
  await assert.rejects(loadManagerIdentity(directory, identity.scope), /permissions_not_private/);
  assert.equal((await stat(directory)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(directory), ["identity.json"]);
}));
