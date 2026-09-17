import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import type {Page} from "playwright-core";
import {FileLedger} from "../src/execution/file-ledger.js";
import {actionFingerprint} from "../src/execution/coordinator.js";
import {digest,snapshotHash} from "../src/manager/season.js";
import {YahooOwnedDriver} from "../src/platforms/yahoo/owned-browser.js";
import {runGuardedOwnedAction,type GuardedOwnedConfig,type OwnedState,type OwnedTransport} from "../src/platforms/yahoo/guarded-owned.js";
import {OWNED_CANONICAL_REPOSITORY,OWNED_LINEUP_SCOPE} from "../src/runtime/owned-lineup-release.js";
import {authorizeOwnedAcquisitionRelease,type OwnedAcquisitionCapabilityEvidence,type OwnedAcquisitionReleaseManifest,type OwnedAcquisitionAuthorization} from "../src/runtime/owned-acquisition-release.js";

// Synthetic production ports built from a clearly labeled minimized regression
// fixture. They never open Yahoo and are not operational capability evidence.
test("production acquisition uses its own proof token, preserves pending obligations and verifies once", async () => {
  const root=await mkdtemp(join(tmpdir(),"owned-acquisition-integration-"));
  try {
    const proof:OwnedAcquisitionCapabilityEvidence=JSON.parse(readFileSync("test/fixtures/owned-sources/acquisition-release-waiver.json","utf8"));
    const now=new Date("2026-09-16T05:00:00Z"),scope={...OWNED_LINEUP_SCOPE,period:"2",teamName:"Artificial Grass Intelligence"};
    const manifest:OwnedAcquisitionReleaseManifest={schemaVersion:1,enabled:true,repositoryRoot:OWNED_CANONICAL_REPOSITORY,releaseSha:"b".repeat(40),sourceHash:"c".repeat(64),scope,capabilities:["waiver_claim"],opensAt:"2026-09-16T04:00:00Z",expiresAt:"2026-09-17T04:00:00Z",
      approval:{reference:"TEST ONLY",releaseSha:"b".repeat(40),scopeHash:""},review:{reference:"TEST ONLY",releaseSha:"b".repeat(40),sourceHash:"c".repeat(64),evidenceHash:digest({waiver_claim:digest(proof)})},
      evidence:{waiver_claim:{path:"runtime/private/owned-release-evidence/test-only.json",hash:digest(proof),acceptanceReleaseSha:proof.acceptanceReleaseSha}}};
    manifest.approval.scopeHash=digest({scope,capabilities:manifest.capabilities,opensAt:manifest.opensAt,expiresAt:manifest.expiresAt});
    const authorization=authorizeOwnedAcquisitionRelease(manifest,{repositoryRoot:OWNED_CANONICAL_REPOSITORY,runningSha:manifest.releaseSha,sourceHash:manifest.sourceHash,sourceClean:true,seasonConfig:{leagueId:425299,teamId:11,season:2026,yahooWritesEnabled:true}},{waiver_claim:proof},now);
    const grant={authorization,releaseSha:manifest.releaseSha,runningSha:manifest.releaseSha};
    const snapshot=structuredClone(proof.snapshot);snapshot.leagueId="425299";snapshot.teamId="11";snapshot.capturedAt=now.toISOString();snapshot.hash=snapshotHash(snapshot);
    const observation=structuredClone(proof.before);observation.observationId="test-production-before";observation.url="https://football.fantasysports.yahoo.com/f1/425299/11";observation.capturedAt=now.toISOString();
    observation.dom.links=observation.dom.links.map(l=>l.text==="My Team"?{...l,href:observation.url}:l);
    const state:OwnedState={observation,snapshot,lineupDeadlines:{},acquisitionDeadlines:Object.fromEntries([...snapshot.roster,...snapshot.available].map(p=>[p.id,"2026-09-16T06:59:00Z"])),
      pendingClaims:{observation,sourceHash:digest(observation),normalized:true,claims:[],interpretation:"observed_empty"}};
    const config:GuardedOwnedConfig={profileId:scope.profileId,emergencyStopPath:join(root,"stop"),approval:null,pendingClaimsPageUrl:observation.url,acquisitionRelease:grant,browserLedger:new FileLedger(join(root,"browser")),
      execution:{leagueId:"425299",teamId:"11",maxAgeMs:900000,writesEnabled:true,releaseSha:manifest.releaseSha,runningSha:manifest.releaseSha,verifiedCapabilities:["waiver_claim","add_drop"],policy:{tradesEnabled:false,allowedActions:["waiver_claim","add_drop"],windows:["waiver_claim","add_drop"].map(kind=>({kind:kind as "waiver_claim"|"add_drop",opensAt:manifest.opensAt,closesAt:manifest.expiresAt}))}}};
    const action=proof.action,actionId=actionFingerprint(snapshot,action);let commits=0,prepares=0,reads=0,time=now.getTime();
    const transport:OwnedTransport={read:async()=>{reads++;return state;},prepare:async()=>{prepares++;return {actionId,observationId:observation.observationId,snapshotHash:snapshot.hash,leagueId:"425299",teamId:"11",period:"2",atomic:true,controlsEvidenceHash:"d".repeat(64),expiresAt:manifest.expiresAt};},
      commit:async(_ticket,guard)=>{await guard();commits++;time+=1000;},readback:async()=>{const after=structuredClone(state);after.observation.observationId="test-production-after";after.observation.capturedAt=new Date(time).toISOString();after.snapshot.capturedAt=after.observation.capturedAt;after.snapshot.hash=snapshotHash(after.snapshot);
        const pendingClaims={observation:after.observation,sourceHash:digest(after.observation),normalized:true,interpretation:"observed_claims" as const,claims:[{id:`1_${action.addId}_${action.dropId}`,leagueId:"425299",teamId:"11",period:"2",addId:action.addId,dropId:action.dropId}]};return {state:after,pendingClaims};}};
    const ledger=new FileLedger(join(root,"actions")),clock=()=>new Date(time);
    const forged={...config,acquisitionRelease:{...grant,authorization:{} as OwnedAcquisitionAuthorization}};
    assert.equal((await runGuardedOwnedAction(snapshot,action,forged,transport,ledger,clock)).status,"blocked");assert.equal(reads,0);
    const driver=new YahooOwnedDriver({} as Page,{binding:{leagueId:"425299",teamId:"11",maxAgeMs:900000},profileId:scope.profileId,emergencyStopPath:config.emergencyStopPath,allowSubmission:true,acquisitionRelease:forged.acquisitionRelease,
      normalize:async()=>state,record:async()=>{},atomicSwapEvidence:null,atomicAcquisitionEvidence:"TEST ONLY",swapSelection:null,clock});
    await assert.rejects(driver.prepare(action,state),/reviewed_acquisition_authorization_required/);
    const saved=state.pendingClaims;state.pendingClaims=null;
    assert.equal((await runGuardedOwnedAction(snapshot,action,config,transport,new FileLedger(join(root,"unknown")),clock)).status,"blocked");assert.equal(prepares,0);assert.equal(commits,0);
    state.pendingClaims=structuredClone(saved!);state.pendingClaims.claims=[{id:`1_999_${action.dropId}`,leagueId:"425299",teamId:"11",period:"2",addId:"999",dropId:action.dropId}];state.pendingClaims.interpretation="observed_claims";
    assert.equal((await runGuardedOwnedAction(snapshot,action,config,transport,new FileLedger(join(root,"conflict")),clock)).status,"blocked");assert.equal(prepares,0);assert.equal(commits,0);
    state.pendingClaims=saved;
    const pickup=structuredClone(snapshot);pickup.available.find(p=>p.id===action.addId)!.availability="free_agent";pickup.hash=snapshotHash(pickup);
    const readCount=reads;
    assert.equal((await runGuardedOwnedAction(pickup,{...action,kind:"add_drop"},config,transport,ledger,clock)).status,"blocked");assert.equal(reads,readCount);
    assert.equal((await runGuardedOwnedAction(snapshot,action,config,transport,ledger,clock)).status,"verified");assert.equal(commits,1);
    assert.equal((await runGuardedOwnedAction(snapshot,action,config,transport,ledger,clock)).status,"already_verified");assert.equal(commits,1);
  } finally {await rm(root,{recursive:true,force:true});}
});
