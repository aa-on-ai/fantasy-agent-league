import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "../src/manager/season.js";
import { loadManagerIdentity } from "../src/manager/identity.js";
import { loadSeasonMemory } from "../src/manager/season-memory.js";
import type { ParticipantAuthoredResponse, ParticipantOwnerReport } from "../src/runtime/participant-wake.js";

const cliPath = fileURLToPath(new URL("../src/cli/participant.js", import.meta.url));
const sourceAt = "2026-09-14T18:00:00.000Z";
async function fixture(run: (root: string, directory: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "participant-wake-")));
  await chmod(root, 0o700);
  try { await run(root, join(root, "participant")); }
  finally { await rm(root, { recursive: true, force: true }); }
}
function invoke(...args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", timeout: 15000 });
}
function success(...args: string[]): any {
  const result = invoke(...args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function blocked(...args: string[]) {
  const result = invoke(...args);
  assert.equal(result.status, 2, result.stdout);
  assert.equal(result.stdout, "");
  return JSON.parse(result.stderr).error as string;
}
async function privateJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}
async function events(directory: string) {
  const identity = await loadManagerIdentity(directory);
  assert.ok(identity);
  return loadSeasonMemory(directory, identity);
}
function report(): ParticipantOwnerReport {
  return { schemaVersion: 1, key: "fixture-owner-debut", season: "2026", period: "1", occurredAt: sourceAt,
    kind: "matchup", subject: "matchup:2026:week1:result", summary: "Fictional test fixture: owner reports a loss; score and opponent unknown.",
    facts: { outcome: "loss", score: null, opponent: null }, source: { author: "Aaron", reference: "fixture:authenticated-host-intake",
      capturedAt: sourceAt, content: "Fictional test input only: the participant lost its debut. No Yahoo observation occurred." } };
}
async function seed(root: string, directory: string) {
  success("init", "--directory", directory);
  const path = join(root, "owner-report.json");
  await privateJson(path, report());
  const result = success("import-report", "--directory", directory, "--file", path, "--trusted-owner-report");
  return result.eventId as string;
}
async function wake(root: string, directory: string, filename = "wake.json") {
  const output = join(root, filename);
  const result = success("prepare-wake", "--directory", directory, "--season", "2026", "--period", "1",
    "--brief", "Fixture task only: draft a personal debut account.", "--output", output);
  return { result, output, payload: JSON.parse(await readFile(output, "utf8")) };
}
function authored(payload: any, eventId: string): ParticipantAuthoredResponse {
  return { schemaVersion: 1, wakeId: payload.wakeId, identityId: payload.identityId, sourceEventIds: [eventId],
    reflection: "Fixture-authored reaction: the rules are familiar; having something at stake is new.",
    intention: "Fixture intention: understand the actual result before promising a comeback.", namePreference: "Fixture Field Notes",
    draft: { title: "Fixture debut", body: "Fixture-authored personal account. ".repeat(65),
      factCheck: `The loss is an unverified owner report: ${eventId}. This fixture does not claim a live model wake.`,
      unresolvedFacts: "Exact score, opponent and who set the lineup remain unknown in this fixture." }, reviewOnly: true };
}

test("separate CLI processes retain identity, provenance, full draft, reflection, intention and unapplied name", async () => fixture(async (root, directory) => {
  const eventId = await seed(root, directory);
  const prepared = await wake(root, directory);
  assert.equal(prepared.payload.continuity.events.length, 1);
  assert.equal(prepared.payload.continuity.events[0].evidence[0].capturedAt, sourceAt);
  assert.equal(prepared.payload.continuity.events[0].facts.score, null);
  assert.equal(prepared.payload.publish, false);
  assert.equal(prepared.payload.reviewRequired, true);
  assert.equal(prepared.payload.capabilities.importFacts, false);
  const response = authored(prepared.payload, eventId), path = join(root, "response.json");
  await privateJson(path, response);
  const recorded = success("record-authored", "--directory", directory, "--file", path, "--run-id", "fixture-model-run-not-live");
  assert.equal(recorded.duplicate, false);
  assert.equal(recorded.published, false);
  assert.equal(recorded.nameApplied, false);
  const second = await wake(root, directory, "cold-wake.json");
  assert.equal(second.payload.identityId, "yahoo:f1:425299:team:11");
  assert.equal(second.payload.continuity.identity.hash, prepared.payload.continuity.identity.hash);
  assert.equal(second.payload.authoredHistory.length, 1);
  assert.equal(second.payload.authoredHistory[0].draft.body, response.draft.body);
  assert.equal(second.payload.authoredHistory[0].reflection, response.reflection);
  assert.equal(second.payload.authoredHistory[0].intention, response.intention);
  assert.equal(second.payload.authoredHistory[0].namePreference, response.namePreference);
  assert.ok(second.payload.continuity.issues.some((issue: any) => issue.code === "unverified_report"));
  assert.deepEqual(second.payload.continuity.verifiedManagerActionIds, []);
  const stored = await events(directory), expression = stored.find(event => event.id === recorded.eventId)!;
  assert.equal(expression.status, "authored"); assert.equal(expression.kind, "reflection");
  assert.deepEqual(expression.evidence, []); assert.equal(expression.actionId, null);
  assert.deepEqual(expression.relatedEventIds, [eventId]);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const file of [join(directory, "identity.json"), join(directory, "events", `${recorded.eventId}.json`),
    join(directory, "wakes", `${prepared.payload.wakeId}.json`), prepared.output])
    assert.equal((await stat(file)).mode & 0o777, 0o600);
}));

test("normal wake fails closed on missing identity and never creates participant state", async () => fixture(async (root, directory) => {
  assert.equal(blocked("prepare-wake", "--directory", directory, "--season", "2026", "--period", "1", "--brief", "No history", "--output", join(root, "wake.json")), "participant_not_initialized");
  assert.deepEqual(await readdir(root), []);
  success("init", "--directory", directory);
  const prepared = await wake(root, directory);
  assert.equal(prepared.payload.continuity.evidenceState, "empty");
  const path = join(root, "response.json");
  await privateJson(path, authored(prepared.payload, digest("nonexistent fixture source")));
  assert.equal(blocked("record-authored", "--directory", directory, "--file", path, "--run-id", "fixture-empty"), "participant_source_not_in_wake");
  assert.equal((await events(directory)).length, 0);
}));

test("source import is explicit trusted host intake and cannot mint observed/verified/action records", async () => fixture(async (root, directory) => {
  success("init", "--directory", directory);
  const path = join(root, "report.json");
  await privateJson(path, report());
  assert.equal(blocked("import-report", "--directory", directory, "--file", path), "missing_participant_argument");
  for (const mutation of [{ status: "verified" }, { evidence: [] }, { actor: "platform" }, { kind: "action" }]) {
    await privateJson(path, { ...report(), ...mutation });
    assert.equal(blocked("import-report", "--directory", directory, "--file", path, "--trusted-owner-report"), "invalid_participant_owner_report");
  }
  assert.equal((await events(directory)).length, 0);
  await privateJson(path, report());
  const first = success("import-report", "--directory", directory, "--file", path, "--trusted-owner-report");
  const second = success("import-report", "--directory", directory, "--file", path, "--trusted-owner-report");
  assert.equal(first.verified, false); assert.equal(second.duplicate, true);
  assert.equal((await events(directory))[0]!.evidence[0]!.contentHash, digest({ author: "Aaron", text: report().source.content }));
}));

test("model-authored input cannot inject facts, authority, cross-team identity or altered source fields", async () => fixture(async (root, directory) => {
  const eventId = await seed(root, directory), prepared = await wake(root, directory), path = join(root, "response.json");
  const valid = authored(prepared.payload, eventId);
  for (const mutation of [{ status: "verified" }, { facts: { score: 999 } }, { evidence: [report().source] },
    { publish: true }, { reviewOnly: false }, { identityId: "yahoo:f1:425299:team:12" }, { sourceEventIds: [digest("invented")] }]) {
    await privateJson(path, { ...valid, ...mutation });
    blocked("record-authored", "--directory", directory, "--file", path, "--run-id", "fixture-host-run");
  }
  assert.equal((await events(directory)).length, 1);
  // Unsupported factual claims in prose stay authored text; they never become observation evidence.
  await privateJson(path, { ...valid, reflection: "Fixture prose claims a score of 999. This is not platform evidence." });
  success("record-authored", "--directory", directory, "--file", path, "--run-id", "fixture-host-run");
  const saved = await events(directory);
  assert.equal(saved.filter(event => event.status === "reported").length, 1);
  assert.equal(saved.filter(event => ["observed", "verified"].includes(event.status)).length, 0);
}));

test("same response retries idempotently; changes to an admitted response require a new wake", async () => fixture(async (root, directory) => {
  const eventId = await seed(root, directory), prepared = await wake(root, directory), path = join(root, "response.json");
  const response = authored(prepared.payload, eventId);
  await privateJson(path, response);
  const first = success("record-authored", "--directory", directory, "--file", path, "--run-id", "fixture-run");
  const second = success("record-authored", "--directory", directory, "--file", path, "--run-id", "fixture-run");
  assert.equal(first.eventHash, second.eventHash); assert.equal(second.duplicate, true);
  await privateJson(path, { ...response, namePreference: "Changed fixture" });
  assert.equal(blocked("record-authored", "--directory", directory, "--file", path, "--run-id", "fixture-run"), "participant_authored_occurrence_conflict");
  assert.equal((await events(directory)).length, 2);
}));

test("response may cite only intact events actually present in its wake", async () => fixture(async (root, directory) => {
  const eventId = await seed(root, directory), prepared = await wake(root, directory), reportPath = join(root, "new-report.json");
  await privateJson(reportPath, { ...report(), key: "fixture-later-source" });
  const later = success("import-report", "--directory", directory, "--file", reportPath, "--trusted-owner-report");
  const path = join(root, "response.json");
  await privateJson(path, authored(prepared.payload, later.eventId));
  assert.equal(blocked("record-authored", "--directory", directory, "--file", path, "--run-id", "fixture-run"), "participant_source_not_in_wake");
  await privateJson(path, authored(prepared.payload, eventId));
  success("record-authored", "--directory", directory, "--file", path, "--run-id", "fixture-run");
  const another = await wake(root, directory, "next-wake.json");
  const receiptPath = join(directory, "wakes", `${another.payload.wakeId}.json`);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")); receipt.continuityHash = digest("tampered");
  await privateJson(receiptPath, receipt);
  await privateJson(path, authored(another.payload, eventId));
  assert.equal(blocked("record-authored", "--directory", directory, "--file", path, "--run-id", "fixture-run-2"), "invalid_participant_wake_receipt");
}));

test("private input and canonical paths reject world-readable files and symlink shortcuts", async () => fixture(async (root, directory) => {
  await seed(root, directory);
  const path = join(root, "unsafe-report.json"); await privateJson(path, report()); await chmod(path, 0o644);
  assert.equal(blocked("import-report", "--directory", directory, "--file", path, "--trusted-owner-report"), "unsafe_manager_memory_file");
  const alias = join(root, "participant-alias"); await symlink(directory, alias);
  assert.equal(blocked("prepare-wake", "--directory", alias, "--season", "2026", "--period", "1", "--brief", "Fixture", "--output", join(root, "wake.json")), "unsafe_manager_memory_path");
  assert.equal((await events(directory)).length, 1);
}));
