import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLedger } from "../src/execution/file-ledger.js";
import { runGuardedOwnedAction, type GuardedOwnedConfig, type OwnedState, type OwnedTransport } from "../src/platforms/yahoo/guarded-owned.js";
import { YahooOwnedDriver } from "../src/platforms/yahoo/owned-browser.js";
import type { Page } from "playwright-core";
import { actionFingerprint, type Ledger } from "../src/execution/coordinator.js";
import { digest, snapshotHash, type Decision } from "../src/manager/season.js";
import { normalizeOwnedAssessment, type OwnedObservation } from "../src/platforms/yahoo/owned-sources.js";
import { OWNED_LINEUP_SCOPE, OWNED_CANONICAL_REPOSITORY, OWNED_LINEUP_CAPABILITY, verifyOwnedLineupCapability,
  inspectOwnedLineupRelease, authorizeOwnedLineupRelease, assertOwnedLineupAuthorization, withOwnedManagerLease,
  type OwnedLineupCapabilityEvidence, type OwnedLineupReleaseManifest, type OwnedLineupReleaseEnvironment,
  type OwnedLineupAuthorization } from "../src/runtime/owned-lineup-release.js";

const now = new Date("2026-09-16T04:00:00.000Z");
const fixture = (name: string): OwnedObservation => JSON.parse(readFileSync(`test/fixtures/owned-sources/${name}.json`, "utf8")
  .replaceAll('/f1/100/', '/f1/1659459/').replaceAll('fixture-profile', OWNED_LINEUP_SCOPE.profileId));
function evidence(): OwnedLineupCapabilityEvidence {
  const before = fixture('roster'), rules = fixture('rules');
  rules.dom.tables[0]!.rows[0]!.cells[1] = '1659459';
  const binding = { leagueId: '1659459', teamId: '1', teamName: 'Example Team', profileId: OWNED_LINEUP_SCOPE.profileId,
    season: 2026, period: '2', maxAgeMs: 900000 };
  before.capturedAt = '2026-09-15T22:37:00Z'; rules.capturedAt = '2026-09-15T22:36:00Z';
  const selection = structuredClone(before), readback = structuredClone(before);
  selection.observationId = 'test-selection'; selection.capturedAt = '2026-09-15T22:37:01Z';
  readback.observationId = 'test-readback'; readback.capturedAt = '2026-09-15T22:37:02Z';
  const selectedRows = selection.dom.tables.flatMap(t => t.rows);
  selectedRows[0]!.attributes.class = 'editable swapactive'; selectedRows[1]!.attributes.class = 'editable swaptarget';
  for (const row of selectedRows) row.attributes['data-pos'] = row.cells[0]!;
  const afterRows = readback.dom.tables.flatMap(t => t.rows);
  afterRows[0]!.cells[0] = 'BN'; afterRows[0]!.attributes['data-pos'] = 'BN';
  afterRows[1]!.cells[0] = 'QB'; afterRows[1]!.attributes['data-pos'] = 'QB';
  for (const row of afterRows) for (const control of row.controls) if (control.attributes['aria-label'])
    control.attributes['aria-label'] = control.attributes['aria-label'].replace(/edit (QB|BN) /, `edit ${row.cells[0]} `);
  const snapshot = normalizeOwnedAssessment({ roster: before, rules }, binding, 'lineup', new Date(readback.capturedAt)).snapshot!;
  assert.ok(snapshot);
  const action: Extract<Decision, { kind: 'set_lineup' }> = { kind: 'set_lineup', lineup: { 'QB:1': '29235', 'K:1': '28227', 'DEF:1': '100034' }, projectedPoints: 30.58 };
  return { schemaVersion: 1, binding, acceptanceReleaseSha: 'a'.repeat(40), before, selection, rules, readback, snapshot, action,
    receipt: { status: 'verified', code: 'independent_readback_passed', actionId: actionFingerprint(snapshot, action) } };
}
function release(proof = evidence()) {
  const scope = { ...OWNED_LINEUP_SCOPE, period: '2', teamName: 'Artificial Grass Intelligence' };
  const base = { scope, capabilities: [OWNED_LINEUP_CAPABILITY] as [typeof OWNED_LINEUP_CAPABILITY], opensAt: '2026-09-16T03:00:00Z', expiresAt: '2026-09-17T03:00:00Z' };
  const manifest: OwnedLineupReleaseManifest = { schemaVersion: 1, enabled: false, repositoryRoot: OWNED_CANONICAL_REPOSITORY,
    releaseSha: 'b'.repeat(40), sourceHash: 'c'.repeat(64), ...base,
    approval: { reference: 'TEST ONLY approved exact release/scope', releaseSha: 'b'.repeat(40), scopeHash: digest(base) },
    review: { reference: 'TEST ONLY review', releaseSha: 'b'.repeat(40), sourceHash: 'c'.repeat(64), evidenceHash: digest(proof) },
    evidence: { path: 'runtime/private/owned-release-evidence/test-only.json', hash: digest(proof), acceptanceReleaseSha: proof.acceptanceReleaseSha } };
  const environment: OwnedLineupReleaseEnvironment = { repositoryRoot: OWNED_CANONICAL_REPOSITORY, runningSha: manifest.releaseSha,
    sourceHash: manifest.sourceHash, sourceClean: true, seasonConfig: { leagueId: 425299, teamId: 11, season: 2026, yahooWritesEnabled: false } };
  return { manifest, environment, proof };
}

test('lineup capability requires initial snapshot, observed selection and independent applied readback, not receipt status alone', () => {
  const good = evidence(); assert.equal(verifyOwnedLineupCapability(good).actionId, good.receipt.actionId);
  const variants: Array<(e: OwnedLineupCapabilityEvidence) => void> = [
    e => { e.receipt.actionId = 'e'.repeat(64); },
    e => { e.receipt.status = 'uncertain'; },
    e => { e.receipt.code = 'unit_test_passed'; },
    e => { e.action.lineup['QB:1'] = '29369'; },
    e => { e.selection.dom.tables[0]!.rows[1]!.attributes.class = 'editable'; },
    e => { e.selection.dom.tables[0]!.rows[0]!.attributes['data-pos'] = 'BN'; },
    e => { e.selection.dom.tables[0]!.rows[1]!.controls[0]!.disabled = true; },
    e => { e.readback = structuredClone(e.before); e.readback.observationId = 'fresh-but-not-applied'; e.readback.capturedAt = '2026-09-15T22:37:02Z'; },
    e => { e.readback.observationId = e.selection.observationId; },
    e => { e.readback.capturedAt = e.selection.capturedAt; },
    e => { e.readback.url += '?week=2'; },
    e => { e.snapshot.roster[0]!.projectedPoints += 1; e.snapshot.hash = snapshotHash(e.snapshot); },
    e => { e.binding.leagueId = '425299'; },
    e => { e.binding.profileId = 'some-other-profile'; },
  ];
  for (const mutate of variants) { const changed = structuredClone(good); mutate(changed); assert.throws(() => verifyOwnedLineupCapability(changed)); }
});

test('a valid inspected release is default-off and needs both manifest and independently read season config gates', () => {
  const { manifest, environment, proof } = release();
  assert.deepEqual(inspectOwnedLineupRelease(manifest, environment, proof, now).activationBlockers, ['lineup_release_disabled', 'season_writes_disabled']);
  assert.throws(() => authorizeOwnedLineupRelease(manifest, environment, proof, now), /lineup_release_disabled/);
  manifest.enabled = true;
  assert.throws(() => authorizeOwnedLineupRelease(manifest, environment, proof, now), /season_writes_disabled/);
  environment.seasonConfig.yahooWritesEnabled = true;
  assert.ok(authorizeOwnedLineupRelease(manifest, environment, proof, now));
});

test('release rejects dirty or different source, wrong ownership, broadened capabilities, stale window and unbound review/evidence', () => {
  const changes: Array<(r: ReturnType<typeof release>) => void> = [
    r => { r.environment.sourceClean = false; }, r => { r.environment.runningSha = 'd'.repeat(40); },
    r => { r.environment.sourceHash = 'd'.repeat(64); }, r => { r.manifest.repositoryRoot += '-copy'; },
    r => { r.manifest.scope = { ...r.manifest.scope, teamId: '12' as '11' }; }, r => { r.environment.seasonConfig.yahooWritesEnabled = true; r.environment.seasonConfig.leagueId = 1659459; },
    r => { r.manifest.capabilities.push('add_drop' as typeof OWNED_LINEUP_CAPABILITY); },
    r => { r.manifest.expiresAt = now.toISOString(); }, r => { r.manifest.expiresAt = '2026-10-01T00:00:00Z'; },
    r => { r.manifest.approval.scopeHash = 'd'.repeat(64); }, r => { r.manifest.review.sourceHash = 'd'.repeat(64); },
    r => { r.manifest.review.reference = ''; }, r => { r.manifest.evidence.path = 'runtime/private/owned-release-evidence/../../secret.json'; },
    r => { r.proof.receipt.status = 'uncertain'; }, r => { r.manifest.evidence.acceptanceReleaseSha = 'd'.repeat(40); },
  ];
  for (const mutate of changes) { const r = release(); mutate(r); assert.throws(() => inspectOwnedLineupRelease(r.manifest, r.environment, r.proof, now)); }
});

test('process-local authorization cannot be forged or broadened and is bound to one release, team, period and atomic action shape', () => {
  const { manifest, environment, proof } = release(); manifest.enabled = true; environment.seasonConfig.yahooWritesEnabled = true;
  const authorization = authorizeOwnedLineupRelease(manifest, environment, proof, now);
  const snapshot = structuredClone(proof.snapshot); snapshot.leagueId = '425299'; snapshot.teamId = '11'; snapshot.capturedAt = now.toISOString(); snapshot.hash = snapshotHash(snapshot);
  const check = { ...manifest.scope, releaseSha: manifest.releaseSha, runningSha: manifest.releaseSha, snapshot, action: proof.action };
  assertOwnedLineupAuthorization(authorization, check, now);
  assert.throws(() => assertOwnedLineupAuthorization({} as OwnedLineupAuthorization, check, now), /required/);
  assert.throws(() => assertOwnedLineupAuthorization(undefined, check, now), /required/);
  assert.throws(() => assertOwnedLineupAuthorization(authorization, { ...check, teamId: '12' }, now), /mismatch/);
  assert.throws(() => assertOwnedLineupAuthorization(authorization, { ...check, runningSha: 'd'.repeat(40) }, now), /mismatch/);
  assert.throws(() => assertOwnedLineupAuthorization(authorization, { ...check, action: { kind: 'add_drop', addId: '1', dropId: '2', improvement: 1 } }, now), /not_supported/);
  assert.throws(() => assertOwnedLineupAuthorization(authorization, { ...check, action: { ...proof.action, lineup: { ...proof.action.lineup, 'QB:1': '29369' } } }, now), /one_atomic_swap/);
  const multi = structuredClone(snapshot); multi.roster.push({ ...multi.roster.find(p => p.id === '28227')!, id: '999', slot: null });
  multi.rosterLimit += 1; multi.hash = snapshotHash(multi);
  assert.throws(() => assertOwnedLineupAuthorization(authorization, { ...check, snapshot: multi,
    action: { ...proof.action, lineup: { ...proof.action.lineup, 'K:1': '999' } } }, now), /one_atomic_swap/);
  assert.throws(() => assertOwnedLineupAuthorization(authorization, check, new Date(manifest.expiresAt)), /mismatch/);
  manifest.expiresAt = '2099-01-01T00:00:00Z';
  assert.throws(() => assertOwnedLineupAuthorization(authorization, check, new Date('2026-09-17T04:00:00Z')), /mismatch/);
});

test('operational CLI has valid syntax and no implicit execution mode or runtime imports without a reviewed manifest', () => {
  const syntax = spawnSync(process.execPath, ['--check', 'scripts/owned-season-manager.mjs'], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const result = spawnSync(process.execPath, ['scripts/owned-season-manager.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 2); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { status: 'blocked', code: 'explicit_lineup_release_and_mode_required', managementCompleted: false });
});

test('production guard accepts only the proof-bound atomic release and still independently verifies once', async () => {
  const directory = await mkdtemp(join(tmpdir(),'owned-lineup-release-'));
  try {
    const {manifest,environment,proof}=release();manifest.enabled=true;environment.seasonConfig.yahooWritesEnabled=true;
    const authorization=authorizeOwnedLineupRelease(manifest,environment,proof,now);
    const grant={authorization,releaseSha:manifest.releaseSha,runningSha:manifest.releaseSha};
    const snapshot=structuredClone(proof.snapshot);snapshot.leagueId='425299';snapshot.teamId='11';snapshot.capturedAt=now.toISOString();snapshot.hash=snapshotHash(snapshot);
    const observation:OwnedObservation={...structuredClone(proof.before),observationId:'production-before',capturedAt:now.toISOString(),url:'https://football.fantasysports.yahoo.com/f1/425299/11'};
    observation.dom.links=observation.dom.links.map(l=>l.text==='My Team'?{...l,href:observation.url}:l);
    const state:OwnedState={observation,snapshot,lineupDeadlines:Object.fromEntries(snapshot.roster.map(p=>[p.id,'2026-09-17T00:00:00Z'])),acquisitionDeadlines:{},pendingClaims:null};
    const config:GuardedOwnedConfig={profileId:manifest.scope.profileId,emergencyStopPath:join(directory,'stop'),approval:null,pendingClaimsPageUrl:null,browserLedger:new FileLedger(join(directory,'browser')),lineupRelease:grant,
      execution:{leagueId:'425299',teamId:'11',maxAgeMs:900000,writesEnabled:true,releaseSha:manifest.releaseSha,runningSha:manifest.releaseSha,verifiedCapabilities:['set_lineup'],
        policy:{tradesEnabled:false,allowedActions:['set_lineup'],windows:[{kind:'set_lineup',opensAt:manifest.opensAt,closesAt:manifest.expiresAt}]}}};
    let reads=0,commits=0,time=now.getTime();
    const actionId=actionFingerprint(snapshot,proof.action);
    const transport:OwnedTransport={read:async()=>{reads++;return state;},prepare:async()=>({actionId,observationId:observation.observationId,snapshotHash:snapshot.hash,leagueId:'425299',teamId:'11',period:'2',atomic:true,controlsEvidenceHash:'d'.repeat(64),expiresAt:manifest.expiresAt}),
      commit:async(_ticket,guard)=>{await guard();commits++;time+=1000;},readback:async()=>{const after=structuredClone(state);after.observation.observationId='production-after';after.observation.capturedAt=new Date(time).toISOString();after.snapshot.capturedAt=after.observation.capturedAt;
        for(const p of after.snapshot.roster)p.slot=Object.entries(proof.action.lineup).find(([,id])=>id===p.id)?.[0]??null;after.snapshot.hash=snapshotHash(after.snapshot);return {state:after,pendingClaims:null};}};
    const ledger=new FileLedger(join(directory,'actions')),clock=()=>new Date(time);
    const forged={...config,lineupRelease:{...grant,authorization:{} as OwnedLineupAuthorization}};
    assert.equal((await runGuardedOwnedAction(snapshot,proof.action,forged,transport,ledger,clock)).status,'blocked');assert.equal(reads,0);
    const driver=new YahooOwnedDriver({} as Page,{binding:{leagueId:'425299',teamId:'11',maxAgeMs:900000},profileId:manifest.scope.profileId,emergencyStopPath:config.emergencyStopPath,allowSubmission:true,lineupRelease:forged.lineupRelease,
      normalize:async()=>state,record:async()=>{},atomicSwapEvidence:'test-only',atomicAcquisitionEvidence:null,swapSelection:{sourceClass:'swapactive',targetClass:'swaptarget'},clock});
    await assert.rejects(driver.prepare(proof.action,state),/reviewed_lineup_authorization_required/);
    assert.equal((await runGuardedOwnedAction(snapshot,proof.action,config,transport,ledger,clock)).status,'verified');assert.equal(commits,1);
    assert.equal((await runGuardedOwnedAction(snapshot,proof.action,config,transport,ledger,clock)).status,'already_verified');assert.equal(commits,1);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('browser and one real lease remain alive through collection, decision, commit and readback, then close in order', async () => {
  const events: string[] = []; let held = false, alive = false, saved: Ledger | undefined;
  const ledger: Ledger = { exclusive: async (_scope, run) => { assert.equal(held, false); held = true; events.push('lease');
    try { return await run(); } finally { held = false; events.push('release'); } },
    get: async () => null, put: async () => {}, hasUnresolved: async () => false };
  const open = async (run: (page: { id: number }) => Promise<string>) => {
    assert.equal(held, true); alive = true; events.push('open');
    try { return await run({ id: 1 }); } finally { alive = false; events.push('close'); }
  };
  assert.equal(await withOwnedManagerLease(ledger, OWNED_LINEUP_SCOPE.profileId, open, async (page, borrowed) => {
    saved = borrowed;
    for (const phase of ['collect', 'decide', 'commit', 'readback']) await borrowed.exclusive(`yahoo-owned-browser:${OWNED_LINEUP_SCOPE.profileId}`, async () => {
      assert.equal(held && alive, true); assert.equal(page.id, 1); events.push(phase);
    });
    await assert.rejects(borrowed.exclusive('wrong-profile', async () => 'bad'), /invalid_owned_manager_lease/);
    return 'verified';
  }), 'verified');
  assert.deepEqual(events, ['lease', 'open', 'collect', 'decide', 'commit', 'readback', 'close', 'release']);
  await assert.rejects(saved!.exclusive(`yahoo-owned-browser:${OWNED_LINEUP_SCOPE.profileId}`, async () => true), /invalid_owned_manager_lease/);
  events.length = 0;
  await assert.rejects(withOwnedManagerLease(ledger, OWNED_LINEUP_SCOPE.profileId, open, async () => { events.push('failure'); throw Error('readback unavailable'); }), /readback unavailable/);
  assert.deepEqual(events, ['lease', 'open', 'failure', 'close', 'release']);
});
