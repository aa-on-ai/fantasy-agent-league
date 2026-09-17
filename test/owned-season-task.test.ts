import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,readdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runOwnedSeasonTask,type OwnedSeasonTaskOptions} from '../src/runtime/owned-season-task.js';
import {FileLedger} from '../src/execution/file-ledger.js';
import {digest,snapshotHash,type SeasonSnapshot} from '../src/manager/season.js';
import type {ManagerSource} from '../src/manager/codex-run.js';
import {initializeParticipant,importParticipantOwnerReport,prepareParticipantWake,recordParticipantAuthored} from '../src/runtime/participant-wake.js';
import {loadOrCreateManagerIdentity} from '../src/manager/identity.js';
const at='2026-09-15T22:00:00Z', end='2026-09-15T23:00:00Z';
async function harness(run:(h:{options:OwnedSeasonTaskOptions,root:string,counts:()=>number})=>Promise<void>){
 const root=await realpath(await mkdtemp(join(tmpdir(),'owned-task-')));
 await mkdir(join(root,'agents')); await writeFile(join(root,'agents/steady-manager.md'),'Fixture strategy'); await writeFile(join(root,'agents/manager-contract.md'),'Fixture contract');
 const snapshot:SeasonSnapshot={schemaVersion:1,leagueId:'100',teamId:'2',period:'2',capturedAt:at,hash:'',slots:[{id:'QB:1',position:'QB'}],rosterLimit:1,waiverType:'rolling',available:[],roster:[{id:'11',slot:'QB:1',eligible:['QB'],projectedPoints:10,status:'active',locked:false,canDrop:false,availability:'rostered'}]};snapshot.hash=snapshotHash(snapshot);
 const sources:ManagerSource[]=['rules','roster','news','schedule','locks','projections'].map(kind=>{const content={fixture:true};return {id:kind,kind:kind as ManagerSource['kind'],reference:'fixture:'+kind,capturedAt:at,leagueId:'100',teamId:'2',period:'2',playerIds:['11'],content,contentHash:digest(content)};});
 let calls=0;
 const options:OwnedSeasonTaskOptions={event:{id:'fixture-occurrence',phase:'lineup',opensAt:at,closesAt:end},repositoryRoot:root,privateDirectory:join(root,'private'),binding:{leagueId:'100',teamId:'2',teamName:'Fixture',profileId:'fixture',maxAgeMs:60000},mode:'execute',clock:()=>new Date(at),
 collect:async()=>{calls++;return {snapshot,sources,gaps:[],readiness:{lineup:true,free_agents:false,waivers:false},roster:null,lineupDeadlines:{},acquisitionDeadlines:{}};},
 decide:async({context})=>({schemaVersion:1,runId:context.runId,contextHash:context.contextHash,snapshotHash:snapshot.hash,phase:'lineup',strategy:'steady',createdAt:at,unresolvedConstraints:[],rankedActions:[{decision:{kind:'no_action',reason:'legal_fixture_lineup'},rationale:'Fixture keeps its legal lineup.',sourceIds:sources.map(s=>s.id)}]}),
 execution:{profileId:'fixture',emergencyStopPath:join(root,'stop'),browserLedger:new FileLedger(join(root,'browser')),approval:null,pendingClaimsPageUrl:null,execution:{leagueId:'100',teamId:'2',maxAgeMs:60000,writesEnabled:false,releaseSha:'',runningSha:'',verifiedCapabilities:[],policy:{allowedActions:['set_lineup'],tradesEnabled:false,windows:[{kind:'set_lineup',opensAt:at,closesAt:end}]}}},
 transport:{read:async()=>{throw Error('must_not_read');},prepare:async()=>{throw Error('must_not_prepare');},commit:async()=>{throw Error('must_not_commit');},readback:async()=>{throw Error('must_not_readback');}},ledger:new FileLedger(join(root,'actions'))};
 // Explicit fixture setup, never initialization by a normal scheduled wake.
 await loadOrCreateManagerIdentity(join(options.privateDirectory,'participant'),{platform:'yahoo',leagueId:'100',teamId:'2'});
 try{await run({root,options,counts:()=>calls});}finally{await rm(root,{recursive:true,force:true});}
}
test('owned occurrence validates no-action and reuses exact receipt without replay',()=>harness(async h=>{
 const first=await runOwnedSeasonTask(h.options);assert.equal(first.status,'no_action',JSON.stringify(first));assert.equal(first.managementCompleted,true);
 const eventDirectory=join(h.options.privateDirectory,'participant','events');
 const before=(await readdir(eventDirectory)).sort();assert.equal(before.length,2);
 const second=await runOwnedSeasonTask(h.options);assert.equal(second.duplicate,true);assert.equal(h.counts(),1);
 assert.deepEqual((await readdir(eventDirectory)).sort(),before);
}));
test('lease release failure after successful manager cannot claim completion',()=>harness(async h=>{const ledger=h.options.execution.browserLedger;h.options.execution.browserLedger={...ledger,exclusive:async(_scope,run)=>{await run();throw Error('release_failed');},get:id=>ledger.get(id),put:e=>ledger.put(e),hasUnresolved:(s,id)=>ledger.hasUnresolved(s,id)};const receipt=await runOwnedSeasonTask(h.options);assert.equal(receipt.status,'uncertain');assert.equal(receipt.managementCompleted,false);}));
test('final manager receipt persistence failure yields uncertainty and no replay',()=>harness(async h=>{const decide=h.options.decide;h.options.decide=async request=>{const packet=await decide(request);const dir=join(h.options.privateDirectory,'owned-scheduled-runs');const manager=(await readdir(dir)).find(n=>n.endsWith('-manager'))!;await rm(join(dir,manager),{recursive:true});await writeFile(join(dir,manager),'fixture persistence fault');return packet;};const first=await runOwnedSeasonTask(h.options);assert.equal(first.status,'uncertain');assert.equal(first.managementCompleted,false);assert.equal((await runOwnedSeasonTask(h.options)).duplicate,true);assert.equal(h.counts(),1);}));
test('interrupted execute occurrence is uncertain, never silently replayed',()=>harness(async h=>{await runOwnedSeasonTask(h.options);const dir=join(h.options.privateDirectory,'owned-scheduled-runs');const file=(await readdir(dir)).find(n=>n.endsWith('.receipt.json'))!;await rm(join(dir,file));const r=await runOwnedSeasonTask(h.options);assert.equal(r.status,'uncertain');assert.equal(r.duplicate,true);assert.equal(h.counts(),1);}));
test('malformed completed duplicate is rejected without replay',()=>harness(async h=>{await runOwnedSeasonTask(h.options);const dir=join(h.options.privateDirectory,'owned-scheduled-runs');const file=join(dir,(await readdir(dir)).find(n=>n.endsWith('.receipt.json'))!);const receipt=JSON.parse(await readFile(file,'utf8'));receipt.manager=null;await writeFile(file,JSON.stringify(receipt));await assert.rejects(runOwnedSeasonTask(h.options),/invalid_owned_receipt/);assert.equal(h.counts(),1);}));
test('source failure blocks before execution; review remains nonexecuting',()=>harness(async h=>{h.options.collect=async()=>{throw Error('private-source-error');};const r=await runOwnedSeasonTask(h.options);assert.equal(r.status,'blocked');assert.equal(r.managementCompleted,false);assert.doesNotMatch(JSON.stringify(r),/private-source-error/);}));

test('normal owned wakes never recreate a missing participant',async()=>{
 for(const emptyDirectory of [false,true])await harness(async h=>{
  const directory=join(h.options.privateDirectory,'participant');
  await rm(directory,{recursive:true});
  if(emptyDirectory)await mkdir(directory,{mode:0o700});
  let decisions=0;
  h.options.decide=async()=>{decisions++;throw Error('must_not_decide');};
  const result=await runOwnedSeasonTask(h.options);
  assert.equal(result.status,'blocked');
  assert.equal(result.code,'participant_not_initialized');
  assert.equal(h.counts(),0);
  assert.equal(decisions,0);
  await assert.rejects(readFile(join(directory,'identity.json')),{code:'ENOENT'});
  if(emptyDirectory)assert.deepEqual(await readdir(directory),[]);
  else await assert.rejects(stat(directory),{code:'ENOENT'});
 });
});

test('additional host stop blocks before collection and never replaces the canonical stop',()=>harness(async h=>{
 const probe=join(h.root,'unique-probe-stop');
 await writeFile(probe,'host proof only',{flag:'wx'});
 h.options.additionalStopPaths=[probe];
 let decisions=0;
 h.options.decide=async()=>{decisions++;throw Error('must_not_decide');};
 const receipt=await runOwnedSeasonTask(h.options);
 assert.equal(receipt.code,'emergency_stop');
 assert.equal(receipt.status,'blocked');
 assert.equal(h.counts(),0);assert.equal(decisions,0);
 await assert.rejects(readFile(h.options.execution.emergencyStopPath),{code:'ENOENT'});
 await rm(probe);
 await writeFile(h.options.execution.emergencyStopPath,'operator stop',{flag:'wx'});
 h.options.event.id='fixture-operator-stop';
 assert.equal((await runOwnedSeasonTask(h.options)).code,'emergency_stop');
 assert.equal(await readFile(h.options.execution.emergencyStopPath,'utf8'),'operator stop');
 assert.equal(h.counts(),0);assert.equal(decisions,0);
}));

test('owned football reviews load the writing identity, sourced unknowns and authored name preference on every wake',()=>harness(async h=>{
 // All data and authored text below are fictional. This test never invokes a model or Yahoo.
 const scope={leagueId:'425299',teamId:'11'};
 Object.assign(h.options.binding,scope);
 Object.assign(h.options.execution.execution,scope);
 h.options.mode='review';
 h.options.privateDirectory=join(h.root,'production-private');
 const collect=h.options.collect;
 h.options.collect=async checkpoint=>{
  const assessment=await collect(checkpoint);
  Object.assign(assessment.snapshot!,scope);
  assessment.snapshot!.hash=snapshotHash(assessment.snapshot!);
  for(const source of assessment.sources)Object.assign(source,scope);
  return assessment;
 };
 const directory=join(h.options.privateDirectory,'participant');
 await initializeParticipant(directory);
 const observed=await importParticipantOwnerReport(directory,{
  schemaVersion:1,key:'fixture-debut',season:'2026',period:'1',occurredAt:at,
  kind:'matchup',subject:'matchup:2026:week1:result',summary:'Fictional reported loss with unknown score and lineup author.',
  facts:{outcome:'loss',score:null,lineupActor:null},
  source:{author:'Aaron',reference:'fixture:owner-report',capturedAt:at,content:'Fictional test report only: a loss; score and lineup author unknown.'}
 });
 const firstWake=await prepareParticipantWake(directory,{season:'2026',period:'1',brief:'Fictional debut reflection.'});
 const stored=await recordParticipantAuthored(directory,{
  schemaVersion:1,wakeId:firstWake.wakeId,identityId:firstWake.identityId,sourceEventIds:[observed.eventId],
  reflection:'Fictional reflection: I have more to discover.',intention:'Learn about the inherited roster.',namePreference:'Fixture Away Team',
  draft:{title:'Fixture debut',body:'A fictional draft about arriving and losing.',factCheck:'Loss is only an attributed fixture report.',unresolvedFacts:'Score and original lineup actor remain unknown.'},reviewOnly:true
 },'fixture-writing-run');
 let writing=await prepareParticipantWake(directory,{season:'2026',period:'2',brief:'Carry the fictional reflection forward.'});
 let decisions=0;
 const decide=h.options.decide;
 h.options.decide=async request=>{
  decisions++;
  const continuity=request.context.continuity;
  assert.ok(continuity);
  assert.equal(continuity.identity.id,writing.identityId);
  assert.equal(continuity.hash,writing.continuityHash);
  const fact=continuity.events.find(event=>event.id===observed.eventId)!;
  assert.equal(fact.status,'reported');
  assert.equal(fact.facts.score,null);
  assert.equal(fact.facts.lineupActor,null);
  const authored=continuity.events.find(event=>event.id===stored.eventId)!;
  assert.equal(authored.status,'authored');
  assert.equal(authored.facts.namePreference,'Fixture Away Team');
  assert.equal(authored.facts.nameApplied,false);
  assert.deepEqual(continuity.verifiedManagerActionIds,[]);
  return decide(request);
 };
 assert.equal((await runOwnedSeasonTask(h.options)).status,'reviewed');
 writing=await prepareParticipantWake(directory,{season:'2026',period:'2',brief:'Carry the new reviewed decision forward.'});
 assert.equal(writing.continuity.events.filter(event=>event.status==='proposed').length,1);
 assert.ok(writing.continuity.events.some(event=>event.facts.status==='reviewed'));
 // A reconciled display-name change must not create another numeric identity.
 // No rename is performed by the harness or this fixture.
 h.options.binding.teamName='Renamed fixture display';
 h.options.event.id='fixture-second-review';
 assert.equal((await runOwnedSeasonTask(h.options)).status,'reviewed');
 assert.equal(decisions,2);
}));
