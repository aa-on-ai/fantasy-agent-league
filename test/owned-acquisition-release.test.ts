import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { digest, snapshotHash } from "../src/manager/season.js";
import { actionFingerprint } from "../src/execution/coordinator.js";
import { normalizeOwnedAssessment } from "../src/platforms/yahoo/owned-sources.js";
import type { OwnedState } from "../src/platforms/yahoo/guarded-owned.js";
import { OWNED_LINEUP_SCOPE, OWNED_CANONICAL_REPOSITORY, type OwnedLineupReleaseEnvironment } from "../src/runtime/owned-lineup-release.js";
import { assertOwnedAcquisitionAuthorization, assertOwnedAcquisitionClaims, authorizeOwnedAcquisitionRelease, inspectOwnedAcquisitionRelease,
  verifyOwnedAcquisitionCapability, OwnedAcquisitionRequestGate, type OwnedAcquisitionCapabilityEvidence,
  type OwnedAcquisitionReleaseManifest, type OwnedAcquisitionAuthorization } from "../src/runtime/owned-acquisition-release.js";

const now = new Date('2026-09-16T04:30:00Z');
const proof = (): OwnedAcquisitionCapabilityEvidence => JSON.parse(readFileSync('test/fixtures/owned-sources/acquisition-release-waiver.json','utf8'));
function release() {
  const evidence = { waiver_claim: proof() };
  const scope = { ...OWNED_LINEUP_SCOPE, period:'2', teamName:'Artificial Grass Intelligence' };
  const bounds = { scope, capabilities: ['waiver_claim'] as ['waiver_claim'], opensAt:'2026-09-16T04:00:00Z', expiresAt:'2026-09-17T04:00:00Z' };
  const manifest: OwnedAcquisitionReleaseManifest = { schemaVersion:1, enabled:false, repositoryRoot:OWNED_CANONICAL_REPOSITORY,
    releaseSha:'a'.repeat(40), sourceHash:'b'.repeat(64), ...bounds,
    approval:{reference:'TEST ONLY exact scope approval',releaseSha:'a'.repeat(40),scopeHash:digest(bounds)},
    review:{reference:'TEST ONLY evidence review',releaseSha:'a'.repeat(40),sourceHash:'b'.repeat(64),evidenceHash:digest({waiver_claim:digest(evidence.waiver_claim)})},
    evidence:{waiver_claim:{path:'runtime/private/owned-release-evidence/test-waiver.json',hash:digest(evidence.waiver_claim),acceptanceReleaseSha:evidence.waiver_claim.acceptanceReleaseSha}} };
  const env: OwnedLineupReleaseEnvironment = { repositoryRoot:OWNED_CANONICAL_REPOSITORY,runningSha:manifest.releaseSha,sourceHash:manifest.sourceHash,sourceClean:true,
    seasonConfig:{leagueId:425299,teamId:11,season:2026,yahooWritesEnabled:false} };
  return {manifest,env,evidence};
}

test('waiver capability replays exact staged numeric form, one submission and independently parsed claim, not success labels', () => {
  const evidence=proof();
  const verified=verifyOwnedAcquisitionCapability(evidence);
  assert.equal(verified.kind,'waiver_claim');assert.equal(verified.claimId,'1_34218_29235');
  assert.equal(verified.actionId,'4b0420f627586f4afffd7490c1abbb76f2ce36cbc7c6ac88956d5f9ffef1c9a7');
  const changes:Array<(e:OwnedAcquisitionCapabilityEvidence)=>void>=[
    e=>{e.submission.submittedRequests=0;},e=>{e.submission.submittedRequests=2;},e=>{e.submission.previewRequests=0;},
    e=>{e.submission.actionId='f'.repeat(64);},e=>{e.receipt.submittedRequests=1;},e=>{e.receipt.status='uncertain';},
    e=>{e.receipt.code='unit_tests_passed';},e=>{e.confirmation.dom.forms[0]!.numericFields!.find(f=>f.name==='stage')!.value='2';},
    e=>{e.confirmation.dom.forms[0]!.numericFields!.find(f=>f.name==='dpid')!.value='29369';},
    e=>{e.readback.observationId=e.before.observationId;},e=>{e.readback.capturedAt=e.before.capturedAt;},
    e=>{e.claimDetails=[];},e=>{e.claimDetails[0]!.url=e.claimDetails[0]!.url.replace('1_34218_29235','1_34218_29369');},
    e=>{e.beforeClaims.normalized=false;},e=>{e.beforeClaims.observation.dom.claimMarkerCount=1;e.beforeClaims.sourceHash=digest(e.beforeClaims.observation);},
    e=>{e.readback.dom.pendingTransactionCount=2;},e=>{e.binding.leagueId='425299';},
  ];
  for(const change of changes){const bad=proof();change(bad);assert.throws(()=>verifyOwnedAcquisitionCapability(bad));}
});

test('a claim receipt or relabeled waiver cannot prove an acquired player', () => {
  const e=proof();e.action.kind='add_drop';
  assert.throws(()=>verifyOwnedAcquisitionCapability(e));
  // Exercise the distinct pickup delta check without inventing a successful
  // pickup fixture: a staged add and one POST still leave the player unowned.
  const row=e.pools[0]!.dom.tables.flatMap(t=>t.rows).find(r=>r.links.some(l=>l.attributes['data-ys-playerid']==='34218'))!;
  const table=e.pools[0]!.dom.tables.find(t=>t.rows.includes(row))!;
  row.cells[table.headers.findIndex(h=>h.replace(/[\ue000-\uf8ff]/g,'').trim()==='Roster Status')]='FA';
  e.snapshot=normalizeOwnedAssessment({roster:e.before,rules:e.rules,pools:e.pools,drops:e.drops},e.binding,'free_agents',new Date(e.readback.capturedAt)).snapshot!;
  e.confirmation.dom.headings=e.confirmation.dom.headings.map(h=>h==='Claim Player From Waivers'?'Add Free Agent':h);
  e.confirmation.dom.text='This transaction will be reflected in your lineup for Week 2';
  for(const c of [...e.confirmation.dom.controls,...e.confirmation.dom.forms.flatMap(f=>f.controls)])c.value=c.value.replace('Create claim to Add','Add');
  e.submission.actionId=e.receipt.actionId=actionFingerprint(e.snapshot,e.action);e.claimDetails=[];
  e.readback.dom.claimMarkerCount=0;e.readback.dom.pendingTransactionCount=0;e.readback.dom.pendingTransactionLinks=[];
  e.readback.dom.links=e.readback.dom.links.filter(l=>!l.href.includes('/viewwaiver'));
  assert.throws(()=>verifyOwnedAcquisitionCapability(e),/pickup_readback_conflict/);
});

test('source-verified populated prior queue survives a new nonconflicting claim; normalized flags without detail coverage fail',()=>{
  const e=proof();
  // Synthetic regression variation, never an operational acceptance artifact.
  const originalDetail=e.claimDetails[0]!;
  const detail=JSON.parse(JSON.stringify(originalDetail).replaceAll('34218','40030').replaceAll('29235','29369')
    .replaceAll('Brock Purdy','Caleb Williams').replaceAll('Jared Goff','Dak Prescott')) as typeof originalDetail;
  detail.observationId='test-only-prior-detail';detail.capturedAt='2026-09-16T04:20:10.500Z';
  const originalLink=e.readback.dom.links.find(l=>l.href.includes('/viewwaiver'))!;
  const link=JSON.parse(JSON.stringify(originalLink).replaceAll('34218','40030').replaceAll('29235','29369')
    .replaceAll('Brock Purdy','Caleb Williams').replaceAll('Jared Goff','Dak Prescott')) as typeof originalLink;
  const queue=e.beforeClaims.observation;
  queue.dom.text+='\nPending Transactions';queue.dom.claimMarkerCount=1;queue.dom.pendingTransactionCount=1;queue.dom.pendingTransactionLinks=[link];queue.dom.links.push(link);
  e.beforeClaims.interpretation='observed_claims';e.beforeClaims.claims=[{id:'1_40030_29369',leagueId:'1659459',teamId:'1',period:'2',addId:'40030',dropId:'29369'}];
  e.beforeClaims.sourceHash=digest(queue);e.beforeClaimDetails=[detail];
  e.readback.dom.links.push(link);e.readback.dom.pendingTransactionLinks!.push(link);e.readback.dom.pendingTransactionCount=2;
  e.claimDetails.push({...structuredClone(detail),observationId:'test-only-prior-after-detail',capturedAt:'2026-09-16T04:27:28.900Z'});
  assert.equal(verifyOwnedAcquisitionCapability(e).claimId,'1_34218_29235');
  const missing=structuredClone(e);missing.beforeClaimDetails=[];
  assert.throws(()=>verifyOwnedAcquisitionCapability(missing),/prior_claims_unverified/);
  const canceled=structuredClone(e);canceled.claimDetails.pop();canceled.readback.dom.links.pop();canceled.readback.dom.pendingTransactionLinks!.pop();canceled.readback.dom.pendingTransactionCount=1;
  assert.throws(()=>verifyOwnedAcquisitionCapability(canceled),/claim_unverified/);
});

test('release is pinned and default-off, missing per-kind acceptance blocks even with both switches enabled',()=>{
  const {manifest,env,evidence}=release();
  assert.deepEqual(inspectOwnedAcquisitionRelease(manifest,env,evidence,now).activationBlockers,['acquisition_release_disabled','season_writes_disabled']);
  assert.throws(()=>authorizeOwnedAcquisitionRelease(manifest,env,evidence,now),/release_disabled/);
  manifest.enabled=true;assert.throws(()=>authorizeOwnedAcquisitionRelease(manifest,env,evidence,now),/season_writes_disabled/);
  env.seasonConfig.yahooWritesEnabled=true;
  assert.ok(authorizeOwnedAcquisitionRelease(manifest,env,evidence,now));
  assert.throws(()=>inspectOwnedAcquisitionRelease(manifest,{...env,sourceClean:false},evidence,now),/not_pinned/);
  assert.throws(()=>inspectOwnedAcquisitionRelease(manifest,{...env,runningSha:'c'.repeat(40)},evidence,now),/not_pinned/);
  assert.throws(()=>inspectOwnedAcquisitionRelease(manifest,{...env,sourceHash:'d'.repeat(64)},evidence,now),/not_pinned/);
  assert.throws(()=>inspectOwnedAcquisitionRelease(manifest,env,evidence,new Date(manifest.expiresAt)),/window_closed/);
  manifest.capabilities.push('add_drop');
  assert.throws(()=>authorizeOwnedAcquisitionRelease(manifest,env,evidence,now),/scope_conflict/);
  manifest.evidence.add_drop=manifest.evidence.waiver_claim!;
  const relabeled={...evidence,add_drop:evidence.waiver_claim};
  assert.throws(()=>authorizeOwnedAcquisitionRelease(manifest,env,relabeled,now),/evidence_missing_or_unbound/);
});

test('authorization is process-local, immutable and bound to capability, scope, freshness, release and period',()=>{
  const {manifest,env,evidence}=release();manifest.enabled=true;env.seasonConfig.yahooWritesEnabled=true;
  const token=authorizeOwnedAcquisitionRelease(manifest,env,evidence,now);
  const snapshot=structuredClone(evidence.waiver_claim.snapshot);snapshot.leagueId='425299';snapshot.teamId='11';snapshot.capturedAt=now.toISOString();snapshot.hash=snapshotHash(snapshot);
  const check={leagueId:'425299',teamId:'11',profileId:manifest.scope.profileId,releaseSha:manifest.releaseSha,runningSha:manifest.releaseSha,snapshot,action:evidence.waiver_claim.action};
  assertOwnedAcquisitionAuthorization(token,check,now);
  assert.throws(()=>assertOwnedAcquisitionAuthorization({} as OwnedAcquisitionAuthorization,check,now),/required/);
  assert.throws(()=>assertOwnedAcquisitionAuthorization(token,{...check,teamId:'12'},now),/mismatch/);
  assert.throws(()=>assertOwnedAcquisitionAuthorization(token,{...check,runningSha:'f'.repeat(40)},now),/mismatch/);
  assert.throws(()=>assertOwnedAcquisitionAuthorization(token,{...check,action:{kind:'no_action',reason:'test'}},now),/not_supported/);
  const pickupSnapshot=structuredClone(snapshot);pickupSnapshot.available.find(p=>p.id===check.action.addId)!.availability='free_agent';pickupSnapshot.hash=snapshotHash(pickupSnapshot);
  assert.throws(()=>assertOwnedAcquisitionAuthorization(token,{...check,snapshot:pickupSnapshot,action:{...check.action,kind:'add_drop'}},now),/capability_not_verified/);
  manifest.capabilities.push('add_drop');manifest.expiresAt='2099-01-01T00:00:00Z';
  assert.throws(()=>assertOwnedAcquisitionAuthorization(token,{...check,snapshot:pickupSnapshot,action:{...check.action,kind:'add_drop'}},now),/capability_not_verified/);
  assert.throws(()=>assertOwnedAcquisitionAuthorization(token,check,new Date('2026-09-17T04:01:00Z')),/mismatch/);
});

test('both acquisitions reject unknown queues, wrong-scope/priority IDs, existing same add and existing same drop',()=>{
  const e=proof();const state:OwnedState={observation:e.before,snapshot:e.snapshot,lineupDeadlines:{},acquisitionDeadlines:{},pendingClaims:e.beforeClaims};
  assertOwnedAcquisitionClaims(state,e.action,e.binding,now);
  assert.throws(()=>assertOwnedAcquisitionClaims({...state,pendingClaims:null},e.action,e.binding,now),/unknown/);
  const claims=structuredClone(e.beforeClaims);claims.interpretation='observed_claims';
  claims.claims=[{id:'1_34218_29369',leagueId:'1659459',teamId:'1',period:'2',addId:'34218',dropId:'29369'}];
  assert.throws(()=>assertOwnedAcquisitionClaims({...state,pendingClaims:claims},e.action,e.binding,now),/conflict/);
  claims.claims=[{id:'1_40030_29235',leagueId:'1659459',teamId:'1',period:'2',addId:'40030',dropId:'29235'}];
  assert.throws(()=>assertOwnedAcquisitionClaims({...state,pendingClaims:claims},{...e.action,kind:'add_drop'},e.binding,now),/conflict/);
  claims.claims[0]!.id='1';assert.throws(()=>assertOwnedAcquisitionClaims({...state,pendingClaims:claims},e.action,e.binding,now),/invalid/);
  assert.throws(()=>assertOwnedAcquisitionClaims(state,e.action,{...e.binding,teamId:'2'},now),/unknown/);
  assert.throws(()=>assertOwnedAcquisitionClaims(state,e.action,e.binding,new Date('2026-09-16T05:00:00Z')),/unbound/);
});

test('network gate admits one exact stage-2 XHR and one separately armed stage-3 document POST, never arbitrary mutations',()=>{
  const gate=new OwnedAcquisitionRequestGate({leagueId:'425299',teamId:'11'}),action=proof().action;
  const request={url:'https://football.fantasysports.yahoo.com/f1/425299/11/addplayer',method:'POST',postData:'stage=2&apid=34218&dpid=29235',navigation:false,resourceType:'xhr'};
  assert.equal(gate.allows(request),false);assert.throws(()=>gate.openSubmission(action),/not_prepared/);
  gate.openPreparation(action);
  for(const wrong of [ {...request,method:'PUT'}, {...request,url:request.url.replace('/11/','/12/')}, {...request,url:request.url+'?stage=2'},
    {...request,postData:request.postData+'&apid=34218'}, {...request,postData:request.postData.replace('29235','29369')},
    {...request,navigation:true,resourceType:'document'}, {...request,postData:request.postData.replace('stage=2','stage=3')}]) assert.equal(gate.allows(wrong),false);
  assert.equal(gate.allows(request),true);assert.equal(gate.allows(request),false);
  const final={...request,postData:'stage=3&apid=34218&dpid=29235',navigation:true,resourceType:'document'};
  assert.equal(gate.allows(final),false);gate.closePreparation();
  assert.throws(()=>gate.openSubmission({...action,dropId:'29369'}),/not_prepared/);
  gate.openSubmission(action);assert.equal(gate.allows(final),true);assert.equal(gate.allows(final),false);
  assert.equal(gate.allows({...final,url:final.url.replace('addplayer','editwaiver')}),false);
  gate.closeSubmission();assert.throws(()=>gate.openPreparation(action),/already_used/);assert.throws(()=>gate.openSubmission(action),/not_prepared/);
  assert.deepEqual(gate.counts,{previewRequests:1,submittedRequests:1});
});

test('acquisition host has valid syntax and cannot implicitly execute, invoke actor or open browser',()=>{
  const syntax=spawnSync(process.execPath,['--check','scripts/owned-acquisition-manager.mjs'],{encoding:'utf8'});assert.equal(syntax.status,0,syntax.stderr);
  const result=spawnSync(process.execPath,['scripts/owned-acquisition-manager.mjs'],{encoding:'utf8'});
  assert.equal(result.status,2);assert.equal(result.stderr,'');assert.deepEqual(JSON.parse(result.stdout),{status:'blocked',code:'explicit_acquisition_release_and_mode_required',managementCompleted:false});
});
