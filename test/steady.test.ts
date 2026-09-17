import test from "node:test";
import assert from "node:assert/strict";
import { planSteady, type SteadyEvidence } from "../src/manager/steady.js";
import { snapshotHash, type Player, type SeasonSnapshot } from "../src/manager/season.js";
const now = new Date('2026-09-08T17:00:00Z');
const binding={leagueId:'test',teamId:'agent',maxAgeMs:60000};
const policy={workloadPenaltyPoints:1,minimumHorizonGain:2,minimumWaiverHorizonGain:8,maximumCurrentWeekLoss:0,maxSourceAgeMs:86400000};
function fixture() {
 const p=(id:string,points:number,slot:string|null):Player=>({id,eligible:['rb'],slot,projectedPoints:points,status:'active',locked:false,canDrop:true,availability:'rostered'});
 const s:SeasonSnapshot={schemaVersion:1,leagueId:'test',teamId:'agent',period:'week1',capturedAt:now.toISOString(),hash:'',roster:[p('secure',10,'rb'),p('uncertain',10.5,null)],available:[],slots:[{id:'rb',position:'rb'}],rosterLimit:3,waiverType:'rolling'};
 s.hash=snapshotHash(s);
 const e:SteadyEvidence={schemaVersion:1,snapshotHash:s.hash,capturedAt:now.toISOString(),periods:['week1','week2'],outlooks:s.roster.map(p=>({id:p.id,workload:p.id==='uncertain'?'uncertain':'secure',newsResolved:true,sources:[{reference:'sanitized-fixture',observedAt:now.toISOString()}],weeks:[{period:'week1',projectedPoints:p.projectedPoints,playable:true,bye:false},{period:'week2',projectedPoints:10,playable:true,bye:false}]}))};
 return {s,e};
}
test('Steady favors secure workload for close choices and keeps locked players',()=>{
 const {s,e}=fixture();assert.equal(planSteady(s,e,binding,policy,'lineup',now).decision.kind,'no_action');
 s.roster[0]!.slot=null;s.roster[1]!.slot='rb';s.roster[1]!.locked=true;s.hash=snapshotHash(s);e.snapshotHash=s.hash;
 assert.equal(planSteady(s,e,binding,policy,'lineup',now).decision.kind,'no_action');
});
test('missing, stale, conflicting or unresolved news evidence cannot silently use the baseline',()=>{
 const {s,e}=fixture();assert.throws(()=>planSteady(s,null,binding,policy,'lineup',now),/evidence/);
 e.outlooks[0]!.newsResolved=false;assert.equal(planSteady(s,e,binding,policy,'lineup',now).decision.kind,'no_action');
 e.outlooks[0]!.newsResolved=true;e.outlooks[0]!.weeks[0]!.projectedPoints=99;
 assert.throws(()=>planSteady(s,e,binding,policy,'lineup',now),/evidence/);
 e.outlooks[0]!.weeks[0]!.projectedPoints=10;e.outlooks[0]!.sources[0]!.observedAt='2026-08-01T00:00:00Z';
 assert.throws(()=>planSteady(s,e,binding,policy,'lineup',now),/evidence/);
});
test('horizon decisions preserve bye coverage and require a larger rolling-waiver gain',()=>{
 const {s,e}=fixture();
 s.available=[{...s.roster[0]!,id:'addition',slot:null,projectedPoints:11,availability:'free_agent'}];
 e.outlooks.push({...structuredClone(e.outlooks[0]!),id:'addition',weeks:[{period:'week1',projectedPoints:11,playable:true,bye:false},{period:'week2',projectedPoints:13,playable:true,bye:false}]});
 s.hash=snapshotHash(s);e.snapshotHash=s.hash;
 assert.equal(planSteady(s,e,binding,policy,'free_agents',now).decision.kind,'add_drop');
 s.available[0]!.availability='waivers';s.hash=snapshotHash(s);e.snapshotHash=s.hash;
 assert.equal(planSteady(s,e,binding,policy,'waivers',now).decision.kind,'no_action');
 s.available[0]!.availability='free_agent';e.outlooks[1]!.weeks[1]!.playable=false;e.outlooks[1]!.weeks[1]!.bye=true;
 e.outlooks[2]!.weeks[1]!.playable=false;e.outlooks[2]!.weeks[1]!.bye=true;s.hash=snapshotHash(s);e.snapshotHash=s.hash;
 const d=planSteady(s,e,binding,{...policy,minimumHorizonGain:0.5},'free_agents',now).decision;
 assert.ok(d.kind==='add_drop' && d.dropId==='uncertain');
});

test('current bye evidence excludes a player even when the platform injury status is active',()=>{
 const {s,e}=fixture();e.outlooks[0]!.weeks[0]!.bye=true;e.outlooks[0]!.weeks[0]!.playable=false;
 const d=planSteady(s,e,binding,policy,'lineup',now).decision;
 assert.ok(d.kind==='set_lineup' && d.lineup.rb==='uncertain');
});

test('CLI runs the explicit Steady evidence path without executing and rejects missing evidence',async()=>{
 const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {fileURLToPath}=await import('node:url');const {spawnSync}=await import('node:child_process');
 const root=await mkdtemp(join(tmpdir(),'steady-cli-'));const {s,e}=fixture();
 s.capturedAt=new Date().toISOString();s.hash=snapshotHash(s);e.capturedAt=s.capturedAt;e.snapshotHash=s.hash;
 e.outlooks.forEach(o=>o.sources.forEach(ref=>ref.observedAt=s.capturedAt));
 try {
  await writeFile(join(root,'snapshot.json'),JSON.stringify(s));await writeFile(join(root,'evidence.json'),JSON.stringify(e));
  await writeFile(join(root,'binding.json'),JSON.stringify({...binding,steadyPolicy:policy}));
  const cli=fileURLToPath(new URL('../src/cli/season-plan.js',import.meta.url));
  const args=[cli,'--snapshot',join(root,'snapshot.json'),'--config',join(root,'binding.json'),'--strategy','steady'];
  const missing=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8'});assert.equal(missing.status,2);
  const run=spawnSync(process.execPath,[...args,'--evidence',join(root,'evidence.json')],{cwd:root,encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);const receipt=JSON.parse(run.stdout);
  const packet=JSON.parse(await readFile(join(root,'runtime/private/decisions',receipt.runId+'.json'),'utf8'));
  assert.equal(packet.strategy,'steady');assert.equal(packet.executed,false);assert.ok(packet.evidenceHash);
  await writeFile(join(root,'binding.json'),JSON.stringify({...binding,steadyPolicy:{...policy,workloadPenaltyPoints:0.5}}));
  const changed=spawnSync(process.execPath,[...args,'--evidence',join(root,'evidence.json')],{cwd:root,encoding:'utf8'});
  assert.equal(changed.status,0,changed.stderr);assert.notEqual(JSON.parse(changed.stdout).runId,receipt.runId);
 } finally {await rm(root,{recursive:true,force:true});}
});
