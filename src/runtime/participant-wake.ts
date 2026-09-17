import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createPrivateMemoryJson, DEFAULT_MANAGER_SCOPE, loadManagerIdentity,
  loadOrCreateManagerIdentity, privateMemoryDirectory, readPrivateMemoryJson } from "../manager/identity.js";
import { appendSeasonMemoryEvent, buildManagerContinuityContext, buildManagerWritingRequest,
  loadSeasonMemory, type SeasonMemoryEvent } from "../manager/season-memory.js";
import { digest } from "../manager/season.js";

const hashPattern = /^[a-f0-9]{64}$/;
const wakePattern = /^[a-f0-9-]{36}$/;
const marker = "participant-authored-v1";
function fail(code: string): never { throw new Error(code); }
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= max;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: unknown, keys: string[], code: string): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(code);
}

export interface ParticipantOwnerReport {
  schemaVersion: 1;
  key: string;
  season: string;
  period: string;
  occurredAt: string;
  kind: "matchup" | "observation";
  subject: string;
  summary: string;
  facts: Record<string, string | number | boolean | null>;
  source: { author: "Aaron"; reference: string; capturedAt: string; content: string };
}

export interface ParticipantAuthoredResponse {
  schemaVersion: 1;
  wakeId: string;
  identityId: string;
  sourceEventIds: string[];
  reflection: string;
  intention: string | null;
  namePreference: string | null;
  draft: { title: string; body: string; factCheck: string; unresolvedFacts: string };
  reviewOnly: true;
}

interface WakeReceipt {
  schemaVersion: 1;
  wakeId: string;
  identityId: string;
  identityHash: string;
  continuityHash: string;
  sourceEvents: Array<{ id: string; hash: string }>;
  preparedAt: string;
  request: { season: string; period: string; brief: string };
  publish: false;
  hash: string;
}

export const PARTICIPANT_RESPONSE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "wakeId", "identityId", "sourceEventIds", "reflection", "intention", "namePreference", "draft", "reviewOnly"],
  properties: {
    schemaVersion: { const: 1 }, wakeId: { type: "string" }, identityId: { const: "yahoo:f1:425299:team:11" },
    sourceEventIds: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: { type: "string", pattern: "^[a-f0-9]{64}$" } },
    reflection: { type: "string", minLength: 1, maxLength: 2000 },
    intention: { type: ["string", "null"], minLength: 1, maxLength: 1000 },
    namePreference: { type: ["string", "null"], minLength: 1, maxLength: 80 },
    draft: { type: "object", additionalProperties: false, required: ["title", "body", "factCheck", "unresolvedFacts"], properties: {
      title: { type: "string", minLength: 1, maxLength: 160 }, body: { type: "string", minLength: 1, maxLength: 12000 },
      factCheck: { type: "string", minLength: 1, maxLength: 1000 }, unresolvedFacts: { type: "string", minLength: 1, maxLength: 1000 },
    } },
    reviewOnly: { const: true },
  },
} as const;

export async function readParticipantInput(path: string): Promise<unknown> {
  if (!isAbsolute(path)) fail("participant_input_requires_absolute_path");
  await privateMemoryDirectory(dirname(path));
  return readPrivateMemoryJson(path);
}

export async function writeParticipantOutput(path: string, value: unknown): Promise<void> {
  if (!isAbsolute(path)) fail("participant_output_requires_absolute_path");
  await privateMemoryDirectory(dirname(path), true);
  await createPrivateMemoryJson(dirname(path), basename(path), value);
}

export async function initializeParticipant(directory: string) {
  const identity = await loadOrCreateManagerIdentity(directory, DEFAULT_MANAGER_SCOPE);
  // Initialization also inspects any existing history; corrupt history is never reset.
  const events = await loadSeasonMemory(directory, identity);
  return { identityId: identity.id, identityHash: identity.hash, directory, eventCount: events.length, externalWrites: false };
}

async function continuityAt(directory: string) {
  const identity = await loadManagerIdentity(directory, DEFAULT_MANAGER_SCOPE);
  if (!identity) fail("participant_not_initialized");
  return buildManagerContinuityContext(identity, await loadSeasonMemory(directory, identity));
}

/** Trusted host intake only. Caller authenticates the owner/source outside this library.
 * This deliberately cannot import platform observations, verified facts or actions. */
export async function importParticipantOwnerReport(directory: string, value: unknown) {
  exactKeys(value, ["schemaVersion", "key", "season", "period", "occurredAt", "kind", "subject", "summary", "facts", "source"], "invalid_participant_owner_report");
  exactKeys(value.source, ["author", "reference", "capturedAt", "content"], "invalid_participant_report_source");
  const report = value as unknown as ParticipantOwnerReport;
  if (report.schemaVersion !== 1 || !["matchup", "observation"].includes(report.kind) || report.source.author !== "Aaron" ||
      !text(report.source.content, 50000) || !text(report.source.reference, 2000) ||
      !Number.isFinite(Date.parse(report.source.capturedAt))) fail("invalid_participant_owner_report");
  const continuity = await continuityAt(directory);
  const content = { author: report.source.author, text: report.source.content };
  const result = await appendSeasonMemoryEvent(directory, continuity.identity, {
    key: report.key, scope: { ...DEFAULT_MANAGER_SCOPE }, season: report.season, period: report.period,
    occurredAt: report.occurredAt, runId: null, kind: report.kind, status: "reported", actor: "owner",
    subject: report.subject, summary: report.summary, facts: report.facts, actionId: null, relatedEventIds: [],
    evidence: [{ kind: "owner_report", scope: { ...DEFAULT_MANAGER_SCOPE }, reference: report.source.reference,
      capturedAt: report.source.capturedAt, content, contentHash: digest(content) }],
  });
  return { identityId: continuity.identity.id, eventId: result.event.id, eventHash: result.event.hash,
    duplicate: result.duplicate, status: "reported", verified: false, externalWrites: false };
}

function receiptHash(receipt: WakeReceipt): string {
  const { hash: _, ...body } = receipt;
  return digest(body);
}

/** A projection, not another narrative store. Full draft text lives in one authored memory event. */
export function participantAuthoredHistory(events: SeasonMemoryEvent[]) {
  return events.filter(event => event.kind === "reflection" && event.status === "authored" && event.facts.format === marker).map(event => {
    const count = event.facts.draftPartCount;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 12) fail("invalid_participant_draft_parts");
    const parts = Array.from({ length: count }, (_, index) => event.facts[`draftPart${String(index + 1).padStart(2, "0")}`]);
    if (parts.some(part => typeof part !== "string")) fail("invalid_participant_draft_parts");
    return { eventId: event.id, authoredAt: event.occurredAt, runId: event.runId, reflection: event.summary,
      intention: event.facts.intention, namePreference: event.facts.namePreference,
      draft: { title: event.facts.draftTitle, body: parts.join(""), factCheck: event.facts.factCheck, unresolvedFacts: event.facts.unresolvedFacts },
      reviewOnly: true, published: false, nameApplied: false };
  });
}

export async function prepareParticipantWake(directory: string, request: WakeReceipt["request"]) {
  const continuity = await continuityAt(directory);
  const writing = buildManagerWritingRequest(continuity, request);
  const receipt: WakeReceipt = { schemaVersion: 1, wakeId: randomUUID(), identityId: continuity.identity.id,
    identityHash: continuity.identity.hash, continuityHash: continuity.hash,
    sourceEvents: continuity.events.map(event => ({ id: event.id, hash: event.hash })),
    preparedAt: new Date().toISOString(), request: structuredClone(request), publish: false, hash: "" };
  receipt.hash = receiptHash(receipt);
  await privateMemoryDirectory(join(directory, "wakes"), true);
  await createPrivateMemoryJson(join(directory, "wakes"), `${receipt.wakeId}.json`, receipt);
  return { schemaVersion: 1, wakeId: receipt.wakeId, preparedAt: receipt.preparedAt, identityId: receipt.identityId,
    continuityHash: receipt.continuityHash, instructions: [writing.instructions,
      "You are this league participant, not Clawc and not a separate commentator. Originate your own concise expression from this continuity.",
      "Return only one JSON object matching responseSchema, including this wakeId and identityId. Do not include private chain-of-thought.",
      "sourceEventIds names the recorded experiences supporting this response. factCheck maps public factual claims to those event IDs; unresolvedFacts retains what remains unknown. Both are private review material.",
      "reflection and intention are concise authored expression. namePreference is null or an unapplied preference, not a rename instruction.",
      "An empty history is a real blocker to grounded expression: request trusted host intake; do not invent sourceEventIds or first-match facts.",
      "No tools in this writing wake may import factual evidence, mutate Yahoo, publish, change an avatar or schedule another worker. Return the authored response to the host for persistence and Aaron's review.",
    ].join("\n"),
    continuity: writing.continuity, request: writing.request, authoredHistory: participantAuthoredHistory(continuity.events),
    responseSchema: PARTICIPANT_RESPONSE_SCHEMA,
    capabilities: { recordAuthoredResponse: true, importFacts: false, rename: false, publish: false, avatar: false },
    publish: false, reviewRequired: true };
}

function validateAuthoredResponse(value: unknown): ParticipantAuthoredResponse {
  exactKeys(value, ["schemaVersion", "wakeId", "identityId", "sourceEventIds", "reflection", "intention", "namePreference", "draft", "reviewOnly"], "invalid_participant_authored_response");
  exactKeys(value.draft, ["title", "body", "factCheck", "unresolvedFacts"], "invalid_participant_draft");
  const response = value as unknown as ParticipantAuthoredResponse;
  if (response.schemaVersion !== 1 || response.reviewOnly !== true || !wakePattern.test(response.wakeId) ||
      response.identityId !== "yahoo:f1:425299:team:11" || !Array.isArray(response.sourceEventIds) ||
      response.sourceEventIds.length < 1 || response.sourceEventIds.length > 20 ||
      response.sourceEventIds.some(id => !hashPattern.test(id)) || new Set(response.sourceEventIds).size !== response.sourceEventIds.length ||
      !text(response.reflection, 2000) || !(response.intention === null || text(response.intention, 1000)) ||
      !(response.namePreference === null || text(response.namePreference, 80)) || !text(response.draft.title, 160) ||
      !text(response.draft.body, 12000) || !text(response.draft.factCheck, 1000) || !text(response.draft.unresolvedFacts, 1000))
    fail("invalid_participant_authored_response");
  return structuredClone(response);
}

export async function recordParticipantAuthored(directory: string, value: unknown, runId: string) {
  if (!text(runId, 200)) fail("participant_run_id_required");
  const response = validateAuthoredResponse(value), continuity = await continuityAt(directory);
  await privateMemoryDirectory(join(directory, "wakes"));
  const receipt = await readPrivateMemoryJson(join(directory, "wakes", `${response.wakeId}.json`)) as WakeReceipt;
  if (!receipt || receipt.schemaVersion !== 1 || receipt.wakeId !== response.wakeId || receipt.identityId !== continuity.identity.id ||
      receipt.identityHash !== continuity.identity.hash || receipt.publish !== false || !Array.isArray(receipt.sourceEvents) ||
      !Number.isFinite(Date.parse(receipt.preparedAt)) || receipt.hash !== receiptHash(receipt)) fail("invalid_participant_wake_receipt");
  // New events may have arrived, but every source in the admitted wake must still be intact.
  if (receipt.sourceEvents.some(source => !continuity.events.some(event => event.id === source.id && event.hash === source.hash)) ||
      response.sourceEventIds.some(id => !receipt.sourceEvents.some(source => source.id === id))) fail("participant_source_not_in_wake");
  const admittedEvents = continuity.events.filter(event => receipt.sourceEvents.some(source => source.id === event.id));
  if (buildManagerContinuityContext(continuity.identity, admittedEvents).hash !== receipt.continuityHash) fail("participant_wake_context_mismatch");
  const key = `participant-authored:${response.wakeId}`;
  response.sourceEventIds.sort();
  const responseHash = digest({ response, runId });
  const existing = continuity.events.find(event => event.key === key);
  if (existing && existing.facts.responseHash !== responseHash) fail("participant_authored_occurrence_conflict");
  const facts: SeasonMemoryEvent["facts"] = { format: marker, wakeId: response.wakeId, responseHash,
    draftTitle: response.draft.title, draftPartCount: Math.ceil(response.draft.body.length / 1000),
    factCheck: response.draft.factCheck, unresolvedFacts: response.draft.unresolvedFacts,
    intention: response.intention, namePreference: response.namePreference, published: false, nameApplied: false };
  for (let offset = 0; offset < response.draft.body.length; offset += 1000)
    facts[`draftPart${String(offset / 1000 + 1).padStart(2, "0")}`] = response.draft.body.slice(offset, offset + 1000);
  const result = await appendSeasonMemoryEvent(directory, continuity.identity, {
    key, scope: { ...DEFAULT_MANAGER_SCOPE }, season: receipt.request.season, period: receipt.request.period,
    occurredAt: existing?.occurredAt ?? new Date().toISOString(), runId, kind: "reflection", status: "authored", actor: "manager",
    subject: `participant:expression:${response.wakeId}`, summary: response.reflection, facts,
    actionId: null, relatedEventIds: response.sourceEventIds, evidence: [],
  });
  // One append is atomic at the event level: draft, reaction, intention and name preference cannot split across writes.
  const stored = await continuityAt(directory);
  const authored = participantAuthoredHistory(stored.events).find(item => item.eventId === result.event.id);
  if (!authored || authored.draft.body !== response.draft.body) fail("participant_authored_readback_failed");
  return { identityId: continuity.identity.id, wakeId: response.wakeId, eventId: result.event.id,
    eventHash: result.event.hash, duplicate: result.duplicate, reviewOnly: true, published: false, nameApplied: false, externalWrites: false };
}
