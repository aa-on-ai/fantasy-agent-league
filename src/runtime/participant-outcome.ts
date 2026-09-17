import { actionFingerprint } from "../execution/coordinator.js";
import type { ManagerContext, ManagerPacket } from "../manager/codex-run.js";
import { loadManagerIdentity, type ManagerIdentity } from "../manager/identity.js";
import { appendSeasonMemoryEvent, loadSeasonMemory, type MemoryEvidence, type SeasonMemoryEvent } from "../manager/season-memory.js";
import { digest } from "../manager/season.js";
import type { OwnedActionReadback, OwnedState, OwnedTransport } from "../platforms/yahoo/guarded-owned.js";
import type { SeasonRunReceipt } from "./season-run.js";

export interface OutcomeMemoryReceipt {
  status: "recorded" | "failed";
  proposalEventId: string | null;
  outcomeEventIds: string[];
  actionAttributed: boolean;
}
export interface OwnedOutcomeCapture {
  before: OwnedState | null;
  commitEnteredAt: string | null;
  readbackRequestedAt: string | null;
  readback: OwnedActionReadback | null;
}

/** Capture only evidence actually returned to the guard. Never manufacture a
 * readback from its verdict, or turn a ledger duplicate into a new submission. */
export function captureOwnedOutcomes(transport: OwnedTransport, clock: () => Date): {
  transport: OwnedTransport; capture: OwnedOutcomeCapture;
} {
  const capture: OwnedOutcomeCapture = { before: null, commitEnteredAt: null, readbackRequestedAt: null, readback: null };
  return { capture, transport: {
    async read() { const result = await transport.read(); capture.before = structuredClone(result); return result; },
    prepare: (action, state) => transport.prepare(action, state),
    async commit(prepared, beforeCommit) {
      // Entering commit is not success. The guard/click can still fail here.
      capture.commitEnteredAt = clock().toISOString();
      await transport.commit(prepared, beforeCommit);
    },
    async readback() {
      capture.readbackRequestedAt = clock().toISOString();
      const result = await transport.readback();
      capture.readback = structuredClone(result);
      return result;
    },
  } };
}

function observation(value: OwnedState["observation"]) {
  return { observationId: value.observationId, capturedAt: value.capturedAt, profileId: value.profileId,
    url: value.url, observationHash: digest(value) };
}
/** Retain normalized facts and source hashes, never the account DOM. */
export function sanitizedOwnedOutcome(capture: OwnedOutcomeCapture | undefined) {
  if (!capture) return null;
  const readback = capture.readback;
  const snapshot = readback?.state.snapshot;
  return { commitEnteredAt: capture.commitEnteredAt, readbackRequestedAt: capture.readbackRequestedAt,
    before: capture.before ? observation(capture.before.observation) : null,
    readback: readback && snapshot ? { observation: observation(readback.state.observation), snapshot: {
      leagueId: snapshot.leagueId, teamId: snapshot.teamId, period: snapshot.period, capturedAt: snapshot.capturedAt, hash: snapshot.hash,
      slots: snapshot.slots, roster: snapshot.roster.map(player => ({ id: player.id, slot: player.slot })) },
      pendingClaims: readback.pendingClaims ? { observation: observation(readback.pendingClaims.observation),
        normalized: readback.pendingClaims.normalized, sourceHash: readback.pendingClaims.sourceHash,
        claims: readback.pendingClaims.claims } : null } : null };
}

export class ParticipantOutcomeWriter {
  private proposal: SeasonMemoryEvent | null = null;
  private packet: ManagerPacket | null = null;
  private readonly key: string;
  private readonly season: string;
  private constructor(private readonly directory: string, private readonly identity: ManagerIdentity,
    private readonly context: ManagerContext, private readonly mode: "review" | "execute") {
    this.key = `runtime:${digest({ runId: context.runId, mode })}`;
    // NFL seasons continue into the following calendar year's winter.
    const captured = new Date(context.snapshot.capturedAt);
    this.season = String(captured.getUTCFullYear() - (captured.getUTCMonth() < 6 ? 1 : 0));
  }
  static async open(directory: string, context: ManagerContext, mode: "review" | "execute") {
    const identity = await loadManagerIdentity(directory, { platform: "yahoo", leagueId: context.snapshot.leagueId, teamId: context.snapshot.teamId });
    if (!identity || !context.continuity || identity.hash !== context.continuity.identity.hash)
      throw new Error("participant_memory_binding_missing");
    await loadSeasonMemory(directory, identity);
    return new ParticipantOutcomeWriter(directory, identity, structuredClone(context), mode);
  }
  get proposalEventId() { return this.proposal?.id ?? null; }
  private evidence(kind: MemoryEvidence["kind"], reference: string, capturedAt: string, content: unknown): MemoryEvidence {
    return { kind, reference, capturedAt, content, contentHash: digest(content), scope: this.identity.scope };
  }
  async recordProposal(packet: ManagerPacket, reference: string, validatedAt: string): Promise<void> {
    const actionId = actionFingerprint(this.context.snapshot, packet.rankedActions[0]!.decision);
    const previous = (await loadSeasonMemory(this.directory, this.identity)).find(event => event.key === `${this.key}:proposal`);
    if (previous) {
      if (previous.facts.packetHash !== digest(packet) || previous.facts.contextHash !== this.context.contextHash || previous.actionId !== actionId)
        throw new Error("participant_proposal_conflict");
      this.proposal = previous; this.packet = structuredClone(packet); return;
    }
    const result = await appendSeasonMemoryEvent(this.directory, this.identity, {
      key: `${this.key}:proposal`, scope: this.identity.scope, season: this.season, period: this.context.snapshot.period,
      occurredAt: validatedAt, runId: this.context.runId, kind: "action", status: "proposed", actor: "manager",
      subject: `action:${actionId}`, summary: this.mode === "review" ? "Validated review-only decision; no execution authorized by this record." : "Validated decision before guarded execution.",
      facts: { actionKind: packet.rankedActions[0]!.decision.kind, mode: this.mode, packetHash: digest(packet), contextHash: this.context.contextHash },
      actionId, relatedEventIds: [], evidence: [this.evidence("decision_packet", reference, validatedAt,
        { actionId, packet, contextHash: this.context.contextHash, snapshotHash: this.context.snapshot.hash,
          sources: this.context.sources.map(source => ({ id: source.id, reference: source.reference, capturedAt: source.capturedAt, contentHash: source.contentHash })) })],
    });
    this.proposal = result.event; this.packet = structuredClone(packet);
  }
  async recordOutcome(receipt: SeasonRunReceipt, reference: string, capture?: OwnedOutcomeCapture): Promise<OutcomeMemoryReceipt> {
    const proposal = this.proposal, packet = this.packet;
    const ids: string[] = [];
    let actionAttributed = false;
    const action = packet?.rankedActions[0]!.decision;
    const actionId = proposal?.actionId ?? null;
    const base = { scope: this.identity.scope, season: this.season, period: this.context.snapshot.period,
      runId: this.context.runId, actionId, subject: proposal?.subject ?? `${this.key}:outcome`, actor: "manager" as const };
    const execution = receipt.execution;
    // An actual current-run commit entry AND an accepted independent readback
    // are required for successful first-person attribution. Historical ledger
    // verification alone does not prove who submitted that action.
    if (proposal && action && action.kind !== "no_action" && receipt.mode === "execute" && actionId &&
        capture?.commitEnteredAt && execution?.actionId === actionId) {
      if (receipt.status === "verified" && execution.status === "verified" && this.independentApplied(capture, actionId)) {
        const executed = await appendSeasonMemoryEvent(this.directory, this.identity, { ...base,
          key: `${this.key}:executed`, occurredAt: capture.commitEnteredAt, kind: "action", status: "executed",
          summary: "Guarded action submitted in this run; successful application is recorded separately.",
          facts: { actionKind: action.kind, submittedThisRun: true }, relatedEventIds: [proposal.id],
          evidence: [this.evidence("execution_receipt", reference, receipt.createdAt, { ...execution, attemptId: receipt.attemptId })] });
        ids.push(executed.event.id);
        const readback = sanitizedOwnedOutcome(capture)!;
        const observedAt = action.kind === "waiver_claim" ? capture.readback!.pendingClaims!.observation.capturedAt : capture.readback!.state.observation.capturedAt;
        const verified = await appendSeasonMemoryEvent(this.directory, this.identity, { ...base,
          key: `${this.key}:verified`, occurredAt: capture.commitEnteredAt, kind: "action", status: "verified",
          summary: action.kind === "waiver_claim" ? "Independent readback verified the pending waiver claim, not acquisition of the player." : "Independent readback verified the submitted roster action.",
          facts: { actionKind: action.kind, result: action.kind === "waiver_claim" ? "claim_pending" : "roster_applied" },
          relatedEventIds: [executed.event.id], evidence: [this.evidence("independent_readback",
            `owned-observation:${action.kind === "waiver_claim" ? capture.readback!.pendingClaims!.observation.observationId : capture.readback!.state.observation.observationId}`,
            observedAt, { actionId, result: "applied", ...readback })] });
        ids.push(verified.event.id); actionAttributed = true;
      } else if (receipt.status === "uncertain" && execution.status === "uncertain") {
        const uncertain = await appendSeasonMemoryEvent(this.directory, this.identity, { ...base,
          key: `${this.key}:uncertain`, occurredAt: receipt.createdAt, kind: "action", status: "uncertain",
          summary: "Submission may have occurred; no successful action is claimed and replay requires reconciliation.",
          facts: { actionKind: action.kind, outcome: "uncertain", commitEnteredThisRun: true }, relatedEventIds: [proposal.id],
          evidence: [this.evidence("execution_receipt", reference, receipt.createdAt, { ...execution, attemptId: receipt.attemptId })] });
        ids.push(uncertain.event.id);
      }
    }
    const outcome = await appendSeasonMemoryEvent(this.directory, this.identity, {
      key: `${this.key}:outcome:${receipt.attemptId}`, scope: this.identity.scope, season: this.season, period: this.context.snapshot.period,
      occurredAt: receipt.createdAt, runId: this.context.runId, kind: "observation", status: "observed", actor: "platform",
      subject: `${this.key}:outcome:${receipt.attemptId}`, summary: `Football runtime outcome: ${receipt.status}. This receipt does not itself establish a successful manager action.`,
      facts: { mode: receipt.mode, status: receipt.status, code: receipt.code, applied: receipt.applied,
        actionKind: action?.kind ?? null, commitEnteredThisRun: !!capture?.commitEnteredAt, actionAttributed },
      actionId: null, relatedEventIds: proposal ? [proposal.id, ...ids] : [], evidence: [this.evidence("source_observation", reference, receipt.createdAt,
        { receipt, ownedEvidence: sanitizedOwnedOutcome(capture) })],
    });
    ids.push(outcome.event.id);
    return { status: "recorded", proposalEventId: proposal?.id ?? null, outcomeEventIds: ids, actionAttributed };
  }
  private independentApplied(capture: OwnedOutcomeCapture, actionId: string): boolean {
    const result = capture.readback, before = capture.before, action = this.packet!.rankedActions[0]!.decision;
    if (!result || !before || !capture.readbackRequestedAt || !capture.commitEnteredAt || action.kind === "no_action") return false;
    const state = result.state, original = this.context.snapshot;
    if (state.snapshot.leagueId !== original.leagueId || state.snapshot.teamId !== original.teamId || state.snapshot.period !== original.period ||
        state.observation.observationId === before.observation.observationId ||
        Date.parse(state.observation.capturedAt) < Date.parse(capture.readbackRequestedAt) ||
        Date.parse(state.observation.capturedAt) < Date.parse(capture.commitEnteredAt) ||
        actionFingerprint(original, action) !== actionId) return false;
    if (action.kind === "set_lineup") return digest(original.roster.map(p => p.id).sort()) === digest(state.snapshot.roster.map(p => p.id).sort()) &&
      original.slots.every(slot => state.snapshot.roster.find(p => p.slot === slot.id)?.id === action.lineup[slot.id]);
    if (action.kind === "add_drop") return digest(state.snapshot.roster.map(p => p.id).sort()) ===
      digest(original.roster.filter(p => p.id !== action.dropId).map(p => p.id).concat(action.addId).sort());
    const claims = result.pendingClaims;
    return !!claims?.normalized && claims.sourceHash === digest(claims.observation) &&
      claims.observation.observationId !== before.pendingClaims?.observation.observationId &&
      Date.parse(claims.observation.capturedAt) >= Date.parse(capture.readbackRequestedAt) &&
      claims.claims.filter(c => c.leagueId === original.leagueId && c.teamId === original.teamId && c.period === original.period &&
        c.addId === action.addId && c.dropId === action.dropId).length === 1;
  }
}
