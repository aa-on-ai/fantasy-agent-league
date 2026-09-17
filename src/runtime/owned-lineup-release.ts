import { actionFingerprint, type ExecutionReceipt, type Ledger } from "../execution/coordinator.js";
import { digest, validateDecision, validateSnapshot, type Decision, type SeasonSnapshot } from "../manager/season.js";
import { normalizeOwnedAssessment, readOwnedRoster, readOwnedRules, validateOwnedObservation, type OwnedBinding, type OwnedObservation } from "../platforms/yahoo/owned-sources.js";

export const OWNED_LINEUP_SCOPE = Object.freeze({ leagueId: "425299", teamId: "11", profileId: "fantasy-agent-1-owned-chrome", season: 2026 });
export const OWNED_CANONICAL_REPOSITORY = "/Users/moltbot/clawd/worktrees/fantasy-single-agent-20260907";
export const OWNED_LINEUP_CAPABILITY = "atomic_two_player_lineup";
const fail = (code: string): never => { throw new Error(code); };
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const reference = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 2000;

/** All four observations are original private capture artifacts, not a synthesized success record. */
export interface OwnedLineupCapabilityEvidence {
  schemaVersion: 1;
  binding: OwnedBinding;
  acceptanceReleaseSha: string;
  before: OwnedObservation;
  selection: OwnedObservation;
  rules: OwnedObservation;
  readback: OwnedObservation;
  snapshot: SeasonSnapshot;
  action: Extract<Decision, { kind: "set_lineup" }>;
  receipt: ExecutionReceipt;
}
export interface OwnedLineupReleaseManifest {
  schemaVersion: 1;
  enabled: boolean;
  repositoryRoot: string;
  releaseSha: string;
  sourceHash: string;
  scope: typeof OWNED_LINEUP_SCOPE & { period: string; teamName: string };
  capabilities: [typeof OWNED_LINEUP_CAPABILITY];
  opensAt: string;
  expiresAt: string;
  approval: { reference: string; releaseSha: string; scopeHash: string };
  review: { reference: string; releaseSha: string; sourceHash: string; evidenceHash: string };
  evidence: { path: string; hash: string; acceptanceReleaseSha: string };
}
export interface OwnedLineupReleaseEnvironment {
  repositoryRoot: string;
  runningSha: string;
  sourceHash: string;
  sourceClean: boolean;
  seasonConfig: { leagueId: string | number; teamId: string | number; season: number; yahooWritesEnabled: boolean };
}
export interface OwnedLineupReleaseInspection {
  manifestHash: string;
  evidenceHash: string;
  actionId: string;
  activationBlockers: string[];
  swapSelection: { sourceClass: "swapactive"; targetClass: "swaptarget" };
}

export function assertAtomicOwnedLineup(snapshot: SeasonSnapshot, action: Decision): void {
  if (action.kind !== "set_lineup") return fail("lineup_release_action_not_supported");
  if (validateDecision(snapshot, action).length) fail("lineup_release_invalid_action");
  const changed = snapshot.roster.filter(p => (Object.entries(action.lineup).find(([, id]) => id === p.id)?.[0] ?? null) !== p.slot);
  const from = changed.find(p => p.slot !== null), to = changed.find(p => p.id !== from?.id);
  if (changed.length !== 2 || !from || !to || action.lineup[from.slot!] !== to.id ||
      (to.slot !== null && action.lineup[to.slot] !== from.id)) fail("lineup_release_requires_one_atomic_swap");
}

/** Validate the actual acceptance receipt against initial controls and an independently captured applied roster. */
export function verifyOwnedLineupCapability(evidence: OwnedLineupCapabilityEvidence): { actionId: string; evidenceHash: string } {
  if (evidence.schemaVersion !== 1 || !sha(evidence.acceptanceReleaseSha) || evidence.binding.leagueId !== "1659459" ||
      evidence.binding.teamId !== "1" || evidence.binding.profileId !== OWNED_LINEUP_SCOPE.profileId || evidence.binding.season !== 2026 ||
      !evidence.binding.period || !reference(evidence.binding.teamName) || evidence.binding.maxAgeMs !== 900000) fail("invalid_lineup_capability_scope");
  const binding = evidence.binding, { before, selection, rules, readback } = evidence;
  const beforeAt = Date.parse(before.capturedAt), selectionAt = Date.parse(selection.capturedAt), afterAt = Date.parse(readback.capturedAt);
  if (!Number.isFinite(afterAt) || !(beforeAt < selectionAt && selectionAt < afterAt) || afterAt - beforeAt > 900000 ||
      new Set([before.observationId, selection.observationId, rules.observationId, readback.observationId]).size !== 4) fail("lineup_capability_not_independent");
  const historicalNow = new Date(afterAt);
  for (const observation of [before, selection, readback]) {
    validateOwnedObservation(observation, binding, historicalNow);
    if (observation.url !== `https://football.fantasysports.yahoo.com/f1/${binding.leagueId}/${binding.teamId}`) fail("lineup_capability_not_independent");
  }
  const normalize = (roster: OwnedObservation) => {
    const result = normalizeOwnedAssessment({ roster, rules }, binding, "lineup", historicalNow);
    if (!result.snapshot) fail("lineup_capability_snapshot_unverified");
    return result.snapshot!;
  };
  const initial = normalize(before), selected = normalize(selection), applied = normalize(readback);
  validateSnapshot(evidence.snapshot, binding, historicalNow);
  if (digest(initial) !== digest(evidence.snapshot)) fail("lineup_capability_snapshot_conflict");
  assertAtomicOwnedLineup(initial, evidence.action);
  const actionId = actionFingerprint(initial, evidence.action);
  if (evidence.receipt.status !== "verified" || evidence.receipt.code !== "independent_readback_passed" ||
      evidence.receipt.actionId !== actionId) fail("lineup_capability_receipt_conflict");
  const stable = (s: SeasonSnapshot) => digest({ ...s, hash: undefined, capturedAt: undefined,
    roster: s.roster.map(p => ({ ...p, slot: undefined })).sort((a, b) => a.id.localeCompare(b.id)) });
  if (stable(initial) !== stable(selected) || stable(initial) !== stable(applied) ||
      initial.roster.some(p => selected.roster.find(q => q.id === p.id)?.slot !== p.slot) ||
      applied.slots.some(slot => applied.roster.find(p => p.slot === slot.id)?.id !== evidence.action.lineup[slot.id])) fail("lineup_capability_readback_conflict");
  const changed = initial.roster.filter(p => (Object.entries(evidence.action.lineup).find(([, id]) => id === p.id)?.[0] ?? null) !== p.slot);
  const from = changed.find(p => p.slot !== null)!, to = changed.find(p => p.id !== from.id)!;
  const named = readOwnedRoster(selection, readOwnedRules(rules, binding, historicalNow), binding, historicalNow);
  for (const [player, className] of [[from, "swapactive"], [to, "swaptarget"]] as const) {
    const name = named.players.find(p => p.id === player.id)?.name;
    const rows = selection.dom.tables.flatMap(t => t.rows).filter(row => row.links.some(link => link.attributes["data-ys-playerid"] === player.id));
    if (rows.length !== 1 || !rows[0]!.attributes.class?.split(/\s+/).includes(className) ||
        rows[0]!.attributes["data-pos"] !== (player.slot?.split(":")[0] ?? "BN") ||
        !name || rows[0]!.controls.filter(c => !c.disabled && c.attributes["aria-label"] === `Click here to edit ${player.slot?.split(":")[0] ?? "BN"} ${name}`).length !== 1)
      fail("lineup_capability_selection_unverified");
  }
  return { actionId, evidenceHash: digest(evidence) };
}

/** No defaults turn writes on. Inspection does not create authority or touch a browser. */
export function inspectOwnedLineupRelease(manifest: OwnedLineupReleaseManifest, env: OwnedLineupReleaseEnvironment,
  evidence: OwnedLineupCapabilityEvidence, now = new Date()): OwnedLineupReleaseInspection {
  if (manifest.schemaVersion !== 1 || typeof manifest.enabled !== "boolean" || manifest.repositoryRoot !== OWNED_CANONICAL_REPOSITORY ||
      env.repositoryRoot !== manifest.repositoryRoot || !sha(manifest.releaseSha) || manifest.releaseSha !== env.runningSha ||
      !hash(manifest.sourceHash) || manifest.sourceHash !== env.sourceHash || env.sourceClean !== true) fail("lineup_release_not_pinned");
  if (digest({ leagueId: manifest.scope.leagueId, teamId: manifest.scope.teamId, profileId: manifest.scope.profileId, season: manifest.scope.season }) !== digest(OWNED_LINEUP_SCOPE) ||
      !/^(?:[1-9]|1[0-8])$/.test(manifest.scope.period) || !reference(manifest.scope.teamName) ||
      digest(manifest.capabilities) !== digest([OWNED_LINEUP_CAPABILITY]) ||
      String(env.seasonConfig.leagueId) !== OWNED_LINEUP_SCOPE.leagueId || String(env.seasonConfig.teamId) !== OWNED_LINEUP_SCOPE.teamId ||
      env.seasonConfig.season !== OWNED_LINEUP_SCOPE.season) fail("lineup_release_scope_conflict");
  const opensAt = Date.parse(manifest.opensAt), expiresAt = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(opensAt) || !Number.isFinite(expiresAt) || opensAt >= expiresAt || expiresAt - opensAt > 7 * 86400000 ||
      now.getTime() < opensAt || now.getTime() >= expiresAt) fail("lineup_release_window_closed");
  if (!reference(manifest.approval.reference) || manifest.approval.releaseSha !== manifest.releaseSha ||
      manifest.approval.scopeHash !== digest({ scope: manifest.scope, capabilities: manifest.capabilities, opensAt: manifest.opensAt, expiresAt: manifest.expiresAt }) ||
      !reference(manifest.review.reference) || manifest.review.releaseSha !== manifest.releaseSha || manifest.review.sourceHash !== manifest.sourceHash ||
      !hash(manifest.evidence.hash) || manifest.review.evidenceHash !== manifest.evidence.hash ||
      !/^runtime\/private\/owned-release-evidence\/[a-zA-Z0-9_.-]+\.json$/.test(manifest.evidence.path) ||
      manifest.evidence.acceptanceReleaseSha !== evidence.acceptanceReleaseSha || manifest.evidence.hash !== digest(evidence)) fail("lineup_release_review_unbound");
  const proof = verifyOwnedLineupCapability(evidence);
  return { manifestHash: digest(manifest), evidenceHash: proof.evidenceHash, actionId: proof.actionId,
    activationBlockers: [manifest.enabled !== true ? "lineup_release_disabled" : null,
      env.seasonConfig.yahooWritesEnabled !== true ? "season_writes_disabled" : null].filter((x): x is string => !!x),
    swapSelection: { sourceClass: "swapactive", targetClass: "swaptarget" } };
}

declare const authorizationBrand: unique symbol;
/** Opaque and process-local: a JSON object or cast cannot confer this authority. */
export interface OwnedLineupAuthorization { readonly [authorizationBrand]: true }
const authorized = new WeakMap<OwnedLineupAuthorization, { manifest: OwnedLineupReleaseManifest; inspection: OwnedLineupReleaseInspection }>();
export interface OwnedLineupReleaseGrant { authorization: OwnedLineupAuthorization; releaseSha: string; runningSha: string }
export function authorizeOwnedLineupRelease(manifest: OwnedLineupReleaseManifest, environment: OwnedLineupReleaseEnvironment,
  evidence: OwnedLineupCapabilityEvidence, now = new Date()): OwnedLineupAuthorization {
  const inspection = inspectOwnedLineupRelease(manifest, environment, evidence, now);
  if (inspection.activationBlockers.length) fail(inspection.activationBlockers[0]!);
  const authorization = Object.freeze({}) as OwnedLineupAuthorization;
  authorized.set(authorization, { manifest: structuredClone(manifest), inspection });
  return authorization;
}
export interface OwnedLineupAuthorizationCheck {
  leagueId: string; teamId: string; profileId: string; releaseSha: string; runningSha: string;
  snapshot: SeasonSnapshot; action: Decision;
}
export function assertOwnedLineupAuthorization(authorization: OwnedLineupAuthorization | undefined, check: OwnedLineupAuthorizationCheck, now = new Date()): void {
  const stored = authorization && authorized.get(authorization);
  if (!stored) fail("reviewed_lineup_authorization_required");
  const manifest = stored!.manifest;
  if (check.leagueId !== manifest.scope.leagueId || check.teamId !== manifest.scope.teamId || check.profileId !== manifest.scope.profileId ||
      check.releaseSha !== manifest.releaseSha || check.runningSha !== manifest.releaseSha ||
      check.snapshot.leagueId !== check.leagueId || check.snapshot.teamId !== check.teamId || check.snapshot.period !== manifest.scope.period ||
      now.getTime() < Date.parse(manifest.opensAt) || now.getTime() >= Date.parse(manifest.expiresAt)) fail("reviewed_lineup_authorization_mismatch");
  validateSnapshot(check.snapshot, { leagueId: check.leagueId, teamId: check.teamId, maxAgeMs: 900000 }, now);
  assertAtomicOwnedLineup(check.snapshot, check.action);
}

/** The single real lease begins before launch and outlives actor, write, readback and context cleanup. */
export async function withOwnedManagerLease<T, P>(ledger: Ledger, profileId: string,
  openBrowser: (run: (page: P) => Promise<T>) => Promise<T>, run: (page: P, borrowed: Ledger) => Promise<T>): Promise<T> {
  const expected = `yahoo-owned-browser:${profileId}`;
  return ledger.exclusive(expected, async () => {
    let active = true;
    const borrowed: Ledger = { exclusive: async (scope, callback) => {
      if (!active || scope !== expected) fail("invalid_owned_manager_lease");
      return callback();
    }, get: id => ledger.get(id), put: entry => ledger.put(entry), hasUnresolved: (scope, id) => ledger.hasUnresolved(scope, id) };
    try { return await openBrowser(page => run(page, borrowed)); }
    finally { active = false; }
  });
}
