import { actionFingerprint, type ExecutionReceipt } from "../execution/coordinator.js";
import { digest, validateDecision, validateSnapshot, type Decision, type SeasonSnapshot } from "../manager/season.js";
import { parseOwnedAcquisitionConfirmation } from "../platforms/yahoo/owned-browser.js";
import { normalizeOwnedAssessment, readOwnedPendingClaims, readOwnedRoster, readOwnedRules, validateOwnedObservation,
  type OwnedBinding, type OwnedObservation } from "../platforms/yahoo/owned-sources.js";
import type { OwnedClaimsEvidence, OwnedState } from "../platforms/yahoo/guarded-owned.js";
import { OWNED_CANONICAL_REPOSITORY, OWNED_LINEUP_SCOPE, type OwnedLineupReleaseEnvironment } from "./owned-lineup-release.js";

export type OwnedAcquisitionKind = "waiver_claim" | "add_drop";
export type OwnedAcquisitionAction = Extract<Decision, { addId: string }>;
const fail = (code: string): never => { throw Error(code); };
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const reference = (v: unknown): v is string => typeof v === "string" && !!v.trim() && v.length <= 2000;
const origin = "https://football.fantasysports.yahoo.com";
export interface OwnedAcquisitionAcceptanceReceipt extends ExecutionReceipt { submittedRequests: number; previewRequests: number }
/** Actual capture artifacts and the original one-submit receipt, preserved even
 * when a later zero-submit reconciliation completed the independent readback. */
export interface OwnedAcquisitionCapabilityEvidence {
  schemaVersion: 1;
  binding: OwnedBinding;
  acceptanceReleaseSha: string;
  before: OwnedObservation;
  rules: OwnedObservation;
  pools: OwnedObservation[];
  drops: OwnedObservation;
  beforeClaims: OwnedClaimsEvidence;
  beforeClaimDetails: OwnedObservation[];
  confirmation: OwnedObservation;
  snapshot: SeasonSnapshot;
  action: OwnedAcquisitionAction;
  submission: OwnedAcquisitionAcceptanceReceipt;
  readback: OwnedObservation;
  claimDetails: OwnedObservation[];
  receipt: OwnedAcquisitionAcceptanceReceipt;
}
export interface OwnedAcquisitionReleaseManifest {
  schemaVersion: 1; enabled: boolean; repositoryRoot: string; releaseSha: string; sourceHash: string;
  scope: typeof OWNED_LINEUP_SCOPE & { period: string; teamName: string };
  capabilities: OwnedAcquisitionKind[];
  opensAt: string; expiresAt: string;
  approval: { reference: string; releaseSha: string; scopeHash: string };
  review: { reference: string; releaseSha: string; sourceHash: string; evidenceHash: string };
  evidence: Partial<Record<OwnedAcquisitionKind, { path: string; hash: string; acceptanceReleaseSha: string }>>;
}
export type OwnedAcquisitionEvidenceBundle = Partial<Record<OwnedAcquisitionKind, OwnedAcquisitionCapabilityEvidence>>;
export interface OwnedAcquisitionReleaseInspection {
  manifestHash: string; evidenceHash: string;
  evidenceHashes: Partial<Record<OwnedAcquisitionKind, string>>;
  actionIds: Partial<Record<OwnedAcquisitionKind, string>>;
  verifiedCapabilities: OwnedAcquisitionKind[];
  activationBlockers: string[];
}

export function assertOwnedAcquisitionAction(snapshot: SeasonSnapshot, action: Decision): asserts action is OwnedAcquisitionAction {
  if (!["add_drop", "waiver_claim"].includes(action.kind)) fail("acquisition_release_action_not_supported");
  if (validateDecision(snapshot, action).length) fail("acquisition_release_invalid_action");
}

/** Both acquisition kinds preserve already-pending roster obligations. An absent
 * queue is unknown, never empty, and a priority number is not a claim identity. */
export function assertOwnedAcquisitionClaims(state: OwnedState, action: OwnedAcquisitionAction,
  binding: Pick<OwnedBinding, "leagueId" | "teamId" | "profileId" | "maxAgeMs">, now = new Date()): void {
  const evidence = state.pendingClaims;
  if (!evidence || evidence.normalized !== true || evidence.sourceHash !== digest(evidence.observation) ||
      evidence.observation.url !== `${origin}/f1/${binding.leagueId}/${binding.teamId}` ||
      !["observed_empty", "explicitly_empty", "observed_claims"].includes(evidence.interpretation ?? "") ||
      !Array.isArray(evidence.claims)) fail("acquisition_pending_claims_unknown");
  const observation = evidence!.observation, age = now.getTime() - Date.parse(observation.capturedAt);
  const owners = observation.dom.links.filter(l => l.text.trim() === "My Team");
  if (!observation.observationId || observation.profileId !== binding.profileId || !Number.isFinite(age) || age < 0 || age > binding.maxAgeMs ||
      !owners.length || owners.some(l => l.href !== observation.url)) fail("acquisition_pending_claims_unbound");
  const claims = evidence!.claims;
  if (claims.some(c => !/^\d+_\d+_\d+$/.test(c.id) || c.id.split("_")[1] !== c.addId || c.id.split("_")[2] !== c.dropId ||
      c.leagueId !== binding.leagueId || c.teamId !== binding.teamId || c.period !== state.snapshot.period ||
      !/^\d+$/.test(c.addId) || !/^\d+$/.test(c.dropId) || c.addId === c.dropId) ||
      new Set(claims.map(c => c.id)).size !== claims.length) fail("acquisition_pending_claims_invalid");
  if (claims.some(c => c.addId === action.addId || c.dropId === action.dropId)) fail("acquisition_pending_claim_conflict");
}

/** Replays original DOM, numeric identities and independent outcome. Merely
 * changing a capability label or verified receipt cannot prove another kind. */
export function verifyOwnedAcquisitionCapability(e: OwnedAcquisitionCapabilityEvidence): { actionId: string; evidenceHash: string; kind: OwnedAcquisitionKind; claimId?: string } {
  const b = e.binding;
  if (e.schemaVersion !== 1 || !sha(e.acceptanceReleaseSha) || b.leagueId !== "1659459" || b.teamId !== "1" ||
      b.profileId !== OWNED_LINEUP_SCOPE.profileId || b.season !== 2026 || !/^(?:[1-9]|1[0-8])$/.test(b.period ?? "") ||
      !reference(b.teamName) || b.maxAgeMs !== 900000) fail("acquisition_capability_scope_conflict");
  const beforeAt = Date.parse(e.before.capturedAt), stagedAt = Date.parse(e.confirmation.capturedAt), afterAt = Date.parse(e.readback.capturedAt);
  if (!(beforeAt < stagedAt && stagedAt < afterAt) || afterAt - beforeAt > 900000 ||
      new Set([e.before.observationId, e.confirmation.observationId, e.readback.observationId]).size !== 3)
    fail("acquisition_capability_not_independent");
  const at = new Date(afterAt), teamUrl = `${origin}/f1/${b.leagueId}/${b.teamId}`;
  for (const o of [e.before, e.confirmation, e.readback, e.rules, e.drops, ...e.pools, ...e.claimDetails]) validateOwnedObservation(o, b, at);
  if (e.before.url !== teamUrl || e.readback.url !== teamUrl || e.before.dom.readyState !== "complete" || e.readback.dom.readyState !== "complete")
    fail("acquisition_capability_unbound_roster");
  const normalized = normalizeOwnedAssessment({ roster: e.before, rules: e.rules, pools: e.pools, drops: e.drops }, b,
    e.action.kind === "waiver_claim" ? "waivers" : "free_agents", at);
  if (!normalized.snapshot || digest(normalized.snapshot) !== digest(e.snapshot)) fail("acquisition_capability_snapshot_conflict");
  validateSnapshot(e.snapshot, b, at); assertOwnedAcquisitionAction(e.snapshot, e.action);
  const rules = readOwnedRules(e.rules, b, at);
  const roster = (o: OwnedObservation) => readOwnedRoster(o, rules, b, at);
  const beforeRoster = roster(e.before), afterRoster = roster(e.readback);
  if (beforeRoster.gaps.length || afterRoster.gaps.length || beforeRoster.period !== b.period || afterRoster.period !== b.period ||
      beforeRoster.players.length !== rules.rosterLimit || afterRoster.players.length !== rules.rosterLimit)
    fail("acquisition_capability_roster_incomplete");
  const beforeClaims = e.beforeClaims;
  if (!beforeClaims || beforeClaims.normalized !== true || beforeClaims.sourceHash !== digest(beforeClaims.observation) ||
      !Array.isArray(beforeClaims.claims) || !Array.isArray(e.beforeClaimDetails) ||
      beforeClaims.observation.observationId === e.before.observationId || beforeClaims.observation.url !== teamUrl ||
      !(beforeAt < Date.parse(beforeClaims.observation.capturedAt) && Date.parse(beforeClaims.observation.capturedAt) < stagedAt) ||
      digest(roster(beforeClaims.observation).players.map(p => [p.id,p.slot])) !== digest(beforeRoster.players.map(p => [p.id,p.slot])))
    fail("acquisition_capability_prior_queue_unverified");
  validateOwnedObservation(beforeClaims.observation, b, at);
  if (beforeClaims.interpretation === "observed_empty") {
    if (beforeClaims.claims.length !== 0 || e.beforeClaimDetails.length !== 0 || new Set(beforeClaims.supportingDocumentIds).size !== 2 ||
        beforeClaims.supportingDocumentIds?.length !== 2 || [e.before, beforeClaims.observation].some(o => o.dom.claimMarkerCount !== 0 ||
          o.dom.readyState !== "complete" || !!o.dom.pendingTransactionCount || !!o.dom.pendingTransactionLinks?.length ||
          /Pending Transactions|Edit Waiver Priority/i.test(o.dom.text))) fail("acquisition_capability_prior_queue_unverified");
  } else if (beforeClaims.interpretation === "observed_claims") {
    if (!beforeClaims.claims.length || !e.beforeClaimDetails.length || e.beforeClaimDetails.some(d =>
        Date.parse(d.capturedAt) < beforeAt || Date.parse(d.capturedAt) > Date.parse(beforeClaims.observation.capturedAt)))
      fail("acquisition_capability_prior_claims_unverified");
    const parsed = readOwnedPendingClaims(beforeClaims.observation, b, teamUrl, at, e.beforeClaimDetails);
    const canonical = beforeClaims.claims.map(c => ({id:c.id,addId:c.addId,dropId:c.dropId}));
    if (parsed.status !== "observed" || digest(parsed.claims) !== digest(canonical)) fail("acquisition_capability_prior_claims_unverified");
  } else fail("acquisition_capability_prior_queue_unverified");
  assertOwnedAcquisitionClaims({observation:e.before,snapshot:e.snapshot,lineupDeadlines:{},acquisitionDeadlines:{},pendingClaims:beforeClaims},e.action,b,at);
  parseOwnedAcquisitionConfirmation(e.confirmation, b, e.action, b.period!);
  const actionId = actionFingerprint(e.snapshot, e.action);
  if (e.submission.actionId !== actionId || e.submission.submittedRequests !== 1 || e.submission.previewRequests !== 1 ||
      !["verified", "uncertain"].includes(e.submission.status) || e.receipt.status !== "verified" || e.receipt.actionId !== actionId)
    fail("acquisition_capability_submission_conflict");
  if (e.receipt.code === "reconciled_without_resubmission") {
    if (e.receipt.submittedRequests !== 0 || e.receipt.previewRequests !== 0 || e.submission.status !== "uncertain" ||
        e.submission.code !== "submission_not_verified") fail("acquisition_capability_reconciliation_conflict");
  } else if (e.receipt.code !== "independent_readback_passed" || e.receipt.submittedRequests !== 1 || e.receipt.previewRequests !== 1 ||
      digest(e.submission) !== digest(e.receipt)) fail("acquisition_capability_receipt_conflict");
  let claimId: string | undefined;
  const slots = (o: ReturnType<typeof roster>) => o.players.map(p => [p.id,p.slot]).sort(([a],[c]) => String(a).localeCompare(String(c)));
  if (e.action.kind === "waiver_claim") {
    if (digest(slots(beforeRoster)) !== digest(slots(afterRoster))) fail("acquisition_capability_waiver_roster_changed");
    if (!e.claimDetails.length || e.claimDetails.some(d => Date.parse(d.capturedAt) <= stagedAt || Date.parse(d.capturedAt) > afterAt ||
        d.observationId === e.confirmation.observationId)) fail("acquisition_capability_claim_not_independent");
    const parsed = readOwnedPendingClaims(e.readback, b, teamUrl, at, e.claimDetails);
    const claims = parsed.status === "observed" ? parsed.claims : [];
    const added = claims.filter(c => c.addId === e.action.addId && c.dropId === e.action.dropId);
    if (claims.length !== beforeClaims.claims.length + 1 || added.length !== 1 || !/^\d+_\d+_\d+$/.test(added[0]!.id) ||
        beforeClaims.claims.some(prior => !claims.some(c => c.id === prior.id && c.addId === prior.addId && c.dropId === prior.dropId)))
      fail("acquisition_capability_claim_unverified");
    claimId = added[0]!.id;
  } else {
    if (beforeClaims.claims.length) {
      if (e.claimDetails.some(d => Date.parse(d.capturedAt) <= stagedAt || Date.parse(d.capturedAt) > afterAt)) fail("acquisition_capability_claim_not_independent");
      const afterClaims = readOwnedPendingClaims(e.readback,b,teamUrl,at,e.claimDetails);
      if (afterClaims.status !== "observed" || afterClaims.claims.length !== beforeClaims.claims.length ||
          beforeClaims.claims.some(prior => !afterClaims.claims.some(c => c.id === prior.id && c.addId === prior.addId && c.dropId === prior.dropId)))
        fail("acquisition_capability_prior_claims_changed");
    } else if (e.claimDetails.length || e.readback.dom.claimMarkerCount !== 0 || !!e.readback.dom.pendingTransactionCount ||
        !!e.readback.dom.pendingTransactionLinks?.length) fail("acquisition_capability_pickup_not_claim");
    const expected = beforeRoster.players.filter(p => p.id !== e.action.dropId).map(p => p.id).concat(e.action.addId).sort();
    if (digest(afterRoster.players.map(p => p.id).sort()) !== digest(expected) ||
        beforeRoster.players.some(p => p.id !== e.action.dropId && afterRoster.players.find(a => a.id === p.id)?.slot !== p.slot))
      fail("acquisition_capability_pickup_readback_conflict");
  }
  return { actionId, evidenceHash: digest(e), kind: e.action.kind, ...(claimId ? { claimId } : {}) };
}

export function inspectOwnedAcquisitionRelease(manifest: OwnedAcquisitionReleaseManifest, env: OwnedLineupReleaseEnvironment,
  evidence: OwnedAcquisitionEvidenceBundle, now = new Date()): OwnedAcquisitionReleaseInspection {
  if (manifest.schemaVersion !== 1 || typeof manifest.enabled !== "boolean" || manifest.repositoryRoot !== OWNED_CANONICAL_REPOSITORY ||
      env.repositoryRoot !== manifest.repositoryRoot || !sha(manifest.releaseSha) || manifest.releaseSha !== env.runningSha ||
      !hash(manifest.sourceHash) || manifest.sourceHash !== env.sourceHash || env.sourceClean !== true) fail("acquisition_release_not_pinned");
  if (digest({ leagueId: manifest.scope.leagueId, teamId: manifest.scope.teamId, profileId: manifest.scope.profileId, season: manifest.scope.season }) !== digest(OWNED_LINEUP_SCOPE) ||
      !/^(?:[1-9]|1[0-8])$/.test(manifest.scope.period) || !reference(manifest.scope.teamName) ||
      String(env.seasonConfig.leagueId) !== OWNED_LINEUP_SCOPE.leagueId || String(env.seasonConfig.teamId) !== OWNED_LINEUP_SCOPE.teamId || env.seasonConfig.season !== OWNED_LINEUP_SCOPE.season ||
      !Array.isArray(manifest.capabilities) || !manifest.capabilities.length || manifest.capabilities.length > 2 ||
      new Set(manifest.capabilities).size !== manifest.capabilities.length || manifest.capabilities.some(k => !["waiver_claim", "add_drop"].includes(k)) ||
      digest(Object.keys(manifest.evidence).sort()) !== digest([...manifest.capabilities].sort()) ||
      digest(Object.keys(evidence).sort()) !== digest([...manifest.capabilities].sort())) fail("acquisition_release_scope_conflict");
  const opens = Date.parse(manifest.opensAt), expires = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(opens) || !Number.isFinite(expires) || opens >= expires || expires - opens > 7 * 86400000 ||
      now.getTime() < opens || now.getTime() >= expires) fail("acquisition_release_window_closed");
  const evidenceHashes: OwnedAcquisitionReleaseInspection["evidenceHashes"] = {}, actionIds: OwnedAcquisitionReleaseInspection["actionIds"] = {};
  for (const kind of manifest.capabilities) {
    const ref = manifest.evidence[kind], proof = evidence[kind];
    if (!ref || !proof || proof.action.kind !== kind || !hash(ref.hash) || ref.hash !== digest(proof) ||
        ref.acceptanceReleaseSha !== proof.acceptanceReleaseSha || !/^runtime\/private\/owned-release-evidence\/[a-zA-Z0-9_.-]+\.json$/.test(ref.path))
      fail("acquisition_capability_evidence_missing_or_unbound");
    const verified = verifyOwnedAcquisitionCapability(proof!); evidenceHashes[kind] = verified.evidenceHash; actionIds[kind] = verified.actionId;
  }
  const evidenceHash = digest(evidenceHashes);
  if (!reference(manifest.approval.reference) || manifest.approval.releaseSha !== manifest.releaseSha ||
      manifest.approval.scopeHash !== digest({ scope: manifest.scope, capabilities: manifest.capabilities, opensAt: manifest.opensAt, expiresAt: manifest.expiresAt }) ||
      !reference(manifest.review.reference) || manifest.review.releaseSha !== manifest.releaseSha || manifest.review.sourceHash !== manifest.sourceHash ||
      manifest.review.evidenceHash !== evidenceHash) fail("acquisition_release_review_unbound");
  return { manifestHash: digest(manifest), evidenceHash, evidenceHashes, actionIds, verifiedCapabilities: [...manifest.capabilities],
    activationBlockers: [manifest.enabled !== true ? "acquisition_release_disabled" : null,
      env.seasonConfig.yahooWritesEnabled !== true ? "season_writes_disabled" : null].filter((s): s is string => !!s) };
}

declare const brand: unique symbol;
export interface OwnedAcquisitionAuthorization { readonly [brand]: true }
const authorized = new WeakMap<OwnedAcquisitionAuthorization, OwnedAcquisitionReleaseManifest>();
export interface OwnedAcquisitionReleaseGrant { authorization: OwnedAcquisitionAuthorization; releaseSha: string; runningSha: string }
export interface OwnedAcquisitionAuthorizationCheck {
  leagueId: string; teamId: string; profileId: string; releaseSha: string; runningSha: string; snapshot: SeasonSnapshot; action: Decision;
}
export function authorizeOwnedAcquisitionRelease(manifest: OwnedAcquisitionReleaseManifest, env: OwnedLineupReleaseEnvironment,
  evidence: OwnedAcquisitionEvidenceBundle, now = new Date()): OwnedAcquisitionAuthorization {
  const inspection = inspectOwnedAcquisitionRelease(manifest, env, evidence, now);
  if (inspection.activationBlockers.length) fail(inspection.activationBlockers[0]!);
  const token = Object.freeze({}) as OwnedAcquisitionAuthorization; authorized.set(token, structuredClone(manifest)); return token;
}
export function assertOwnedAcquisitionAuthorization(token: OwnedAcquisitionAuthorization | undefined, check: OwnedAcquisitionAuthorizationCheck, now = new Date()): void {
  const manifest = token && authorized.get(token);
  if (!manifest) fail("reviewed_acquisition_authorization_required");
  if (check.leagueId !== manifest!.scope.leagueId || check.teamId !== manifest!.scope.teamId || check.profileId !== manifest!.scope.profileId ||
      check.releaseSha !== manifest!.releaseSha || check.runningSha !== manifest!.releaseSha || check.snapshot.leagueId !== check.leagueId ||
      check.snapshot.teamId !== check.teamId || check.snapshot.period !== manifest!.scope.period ||
      now.getTime() < Date.parse(manifest!.opensAt) || now.getTime() >= Date.parse(manifest!.expiresAt)) fail("reviewed_acquisition_authorization_mismatch");
  validateSnapshot(check.snapshot, { leagueId: check.leagueId, teamId: check.teamId, maxAgeMs: 900000 }, now);
  assertOwnedAcquisitionAction(check.snapshot, check.action);
  if (!manifest!.capabilities.includes(check.action.kind)) fail("acquisition_capability_not_verified");
}

/** Network backstop for the exact observed Yahoo protocol. The host opens each
 * phase only around the driver's bound gesture. Unrelated POSTs, wrong numeric
 * identities, duplicate fields, repeated previews and repeated finals abort. */
export class OwnedAcquisitionRequestGate {
  private action: OwnedAcquisitionAction | null = null;
  private preparing = false;
  private submitting = false;
  private preparationOpened = false;
  private submissionOpened = false;
  private previews = 0;
  private submissions = 0;
  constructor(private readonly binding: { leagueId: string; teamId: string }) {}
  get counts() { return { previewRequests: this.previews, submittedRequests: this.submissions }; }
  openPreparation(action: OwnedAcquisitionAction): void {
    if (this.preparationOpened || !["add_drop", "waiver_claim"].includes(action.kind) ||
        !/^\d+$/.test(action.addId) || !/^\d+$/.test(action.dropId) || action.addId === action.dropId)
      fail("acquisition_preparation_already_used_or_invalid");
    this.preparationOpened = true; this.action = structuredClone(action); this.preparing = true;
  }
  closePreparation(): void { this.preparing = false; }
  openSubmission(action: OwnedAcquisitionAction): void {
    if (this.preparing || this.submissionOpened || this.previews !== 1 || !this.action || digest(action) !== digest(this.action))
      fail("acquisition_submission_not_prepared");
    this.submissionOpened = true; this.submitting = true;
  }
  closeSubmission(): void { this.submitting = false; }
  allows(request: { url: string; method: string; postData: string | null; navigation: boolean; resourceType: string }): boolean {
    const url = new URL(request.url);
    if (url.origin !== origin || ["GET", "HEAD"].includes(request.method)) return true;
    const fields = new URLSearchParams(request.postData ?? ""), action = this.action;
    if (!action || request.method !== "POST" || url.pathname !== `/f1/${this.binding.leagueId}/${this.binding.teamId}/addplayer` ||
        url.search || url.hash || url.username || url.password || ["stage", "apid", "dpid"].some(k => fields.getAll(k).length !== 1) ||
        fields.get("apid") !== action.addId || fields.get("dpid") !== action.dropId) return false;
    if (this.preparing && !this.submitting && this.previews === 0 && fields.get("stage") === "2" && !request.navigation && ["xhr", "fetch"].includes(request.resourceType)) {
      this.previews++; return true;
    }
    if (this.submitting && !this.preparing && this.previews === 1 && this.submissions === 0 && fields.get("stage") === "3" && request.navigation && request.resourceType === "document") {
      this.submissions++; return true;
    }
    return false;
  }
}
