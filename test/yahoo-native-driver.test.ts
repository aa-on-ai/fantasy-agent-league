import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { YahooNativeDriver, parseWaiverConfirmation, parseFreeAgentConfirmation, type NativeDesktopApp } from '../src/platforms/yahoo/native-driver.js';
import { snapshotHash, type SeasonSnapshot } from '../src/manager/season.js';
import type { NativeState } from '../src/platforms/yahoo/guarded-native.js';
const binding = {leagueId:'100',teamId:'2',teamName:'Example',maxAgeMs:60000};
const at='2026-09-09T19:00:00Z';
const row=(i:number,name:string,team:string,glyph:string)=>`    ${i} row (selectable)\n      ${i+1} cell (selectable) ${glyph}\n      ${i+2} cell (selectable) ${name}\n, Description: ${name}\n, Value: ${name}\n${team} - QB\nSun 1:00 pm vs Opp\n`;
const page=(path:string,body:string)=>`0 standard window Example, ID: window, Secondary Actions: Raise\n  4 HTML content Description: Example | Yahoo! Sports, URL: football.fantasysports.yahoo.com/f1/100/${path}\n    5 link My Team, Value: football.fantasysports.yahoo.com/f1/100/2\n${body}`;
const confirmation=(index=170)=>page('addplayer?apid=30971',`    8 heading Claim Player From Waivers, Value: 2\n${row(20,'Baker Mayfield','TB','\ue035')}${row(30,'Cairo Santos','Chi','\ue033')}    40 link Stats, Value: football.fantasysports.yahoo.com/f1/100/2/addplayer?stage=2&apid=30971&dpid=28227\n    41 link Baker Mayfield, Value: sports.yahoo.com/nfl/players/30971\n    42 link Cairo Santos, Value: sports.yahoo.com/nfl/players/28227\n    169 text If successful, this waiver claim will be reflected in your lineup for  Week 1 on Friday, Sep 11 .\n    ${index} button Create claim to Add Baker Mayfield, Drop Cairo Santos\n    171 link Cancel, Value: football.fantasysports.yahoo.com/f1/100/players`);
test('observed waiver structure binds exact names, numeric IDs, team, stage and period',()=>{
 assert.equal(parseWaiverConfirmation(confirmation(),binding,'TB:Baker Mayfield','Chi:Cairo Santos').index,170);
 for(const bad of [confirmation().replace('stage=2','stage=1'),confirmation().replace('dpid=28227','dpid=9'),confirmation().replace('link My Team, Value: football.fantasysports.yahoo.com/f1/100/2','link My Team, Value: football.fantasysports.yahoo.com/f1/100/3'),confirmation().replace('button Create claim','button Submit claim')]) assert.throws(()=>parseWaiverConfirmation(bad,binding,'TB:Baker Mayfield','Chi:Cairo Santos'));
});
test('confirmation rejects lookalike stage hosts and ambiguous identity parameters',()=>{
 for(const bad of [
  confirmation().replace('link Stats, Value: football.fantasysports.yahoo.com/', 'link Stats, Value: example.com/'),
  confirmation().replace('link Stats, Value: football.fantasysports.yahoo.com/', 'link Stats, Value: football.fantasysports.yahoo.com.example.com/'),
  confirmation().replace('stage=2&apid=30971', 'stage=2&apid=30971&apid=9'),
  confirmation().replace('dpid=28227','dpid=28227&dpid=9'),
  confirmation().replace('stage=2','stage=2&stage=1'),
  confirmation().replace('addplayer?apid=30971','addplayer?apid=30971&apid=9'),
 ]) assert.throws(()=>parseWaiverConfirmation(bad,binding,'TB:Baker Mayfield','Chi:Cairo Santos'));
});
test('read recovers from the owned league landing page through its observed My Team link',async()=>harness(async h=>{
 h.pages[1]=h.pages[0];
 h.pages[0]=h.pages[0].replace('URL: football.fantasysports.yahoo.com/f1/100/2','URL: football.fantasysports.yahoo.com/f1/100');
 const result=await h.driver.read();
 assert.deepEqual(h.clicks,[5]);
 assert.equal(result.capture,h.pages[1]);
 assert.equal(result.snapshot.teamId,'2');
}));
test('read refuses an unrelated or lookalike league before navigation',async()=>{
 for(const league of ['101','1000']) await harness(async h=>{
  h.pages[0]=h.pages[0].replace('URL: football.fantasysports.yahoo.com/f1/100/2',`URL: football.fantasysports.yahoo.com/f1/${league}`);
  await assert.rejects(h.driver.read(),/wrong_league/);
  assert.deepEqual(h.clicks,[]);
 });
});
async function harness(run:(h:any)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'native-driver-'));let now=new Date(at);let screen=0;const clicks:number[]=[];
 const pages=[page('2','    6 link Players, Value: football.fantasysports.yahoo.com/f1/100/players'),page('players',row(20,'Baker Mayfield','TB','\ue035')),page('addplayer?apid=30971',`    8 heading Claim Player From Waivers, Value: 2\n${row(30,'Cairo Santos','Chi','—')}`),confirmation()];
 const p=(id:string,slot:string|null)=>({id,slot,eligible:['QB'],projectedPoints:10,status:'active' as const,locked:false,dropLocked:false,canDrop:true,availability:'rostered' as const});
 const snapshot:SeasonSnapshot={schemaVersion:1,leagueId:'100',teamId:'2',period:'1',capturedAt:at,hash:'',slots:[{id:'QB:1',position:'QB'}],rosterLimit:2,waiverType:'rolling',roster:[p('X:Starter','QB:1'),p('Chi:Cairo Santos',null)],available:[{...p('TB:Baker Mayfield',null),availability:'waivers'}]};snapshot.hash=snapshotHash(snapshot);
 const state:NativeState={observationId:'original',profileId:'profile',windowId:'window',capture:pages[0]!,snapshot,lineupDeadlines:{},acquisitionDeadlines:{}};
 const app:NativeDesktopApp={getAXStateAndScreenshot:async()=>({state:pages[screen]!,screenshot:new Uint8Array([1])}),getAXState:async()=>pages[screen]!,pressKey:async()=>{},click:async i=>{clicks.push(i);screen=Math.min(screen+1,3);}};
 const options={binding,profileId:'profile',windowId:'window',emergencyStopPath:join(dir,'stop'),allowSubmission:true,atomicSwapVerified:false,atomicAcquisitionVerified:true,clock:()=>now,normalize:async(o:any)=>({...structuredClone(state),capture:o.capture}),record:async()=>{},collectPendingClaims:async()=>({pendingClaims:[],pendingClaimsCapture:null,pendingClaimsCapturedAt:null,pendingClaimsNormalized:false,pendingClaimsSourceHash:null})};
 const driver=new YahooNativeDriver(app,options);const action={kind:'waiver_claim' as const,addId:'TB:Baker Mayfield',dropId:'Chi:Cairo Santos',improvement:1};
 try{await run({driver,state,action,options,pages,clicks,setTime:(v:string)=>{now=new Date(v);},stop:()=>writeFile(options.emergencyStopPath,'stop')});}finally{await rm(dir,{recursive:true,force:true});}
}
test('native preparation selects only; commit re-resolves current index and calls guard immediately before one gesture',async()=>harness(async h=>{
 const ticket=await h.driver.prepare(h.action,h.state);assert.deepEqual(h.clicks,[6,21,31]);h.pages[3]=confirmation(190);
 await h.driver.commit(ticket,async()=>assert.equal(h.clicks.length,3));assert.deepEqual(h.clicks,[6,21,31,190]);
 await assert.rejects(h.driver.commit(ticket,async()=>{}),/consumed/);assert.equal(h.clicks.length,4);
}));
test('tamper, changed confirmation, stop, expiry, guard rejection and disabled writes block final native gesture',async()=>{
 for(const fault of ['tamper','confirmation','stop','expiry','guard','disabled','window']) await harness(async h=>{
 const ticket=await h.driver.prepare(h.action,h.state);
 if(fault==='tamper')ticket.atomic=false;
 if(fault==='confirmation')h.pages[3]=confirmation().replace('Friday, Sep 11','Saturday, Sep 12');
 if(fault==='stop')await h.stop();
 if(fault==='expiry')h.setTime('2026-09-09T19:02:00Z');
 if(fault==='disabled')h.options.allowSubmission=false;
 if(fault==='window')h.pages[3]=confirmation().replace('ID: window','ID: other');
 await assert.rejects(h.driver.commit(ticket,async()=>{if(fault==='guard')throw Error('guard');}));assert.deepEqual(h.clicks,[6,21,31]);
 });
});
test('free-agent confirmation and driver bind the observed add/drop control and reject a waiver flow',async()=>harness(async h=>{
 h.state.snapshot.available[0].availability='free_agent';h.state.snapshot.hash=snapshotHash(h.state.snapshot);
 const fa=confirmation().replace('Claim Player From Waivers','Add Free Agent').replace('Create claim to Add','Add')
  .replace('If successful, this waiver claim will be reflected in your lineup for  Week 1 on Friday, Sep 11 .','This transaction will be reflected in your lineup for  Week 1');
 assert.equal(parseFreeAgentConfirmation(fa,binding,'TB:Baker Mayfield','Chi:Cairo Santos').period,'1');
 assert.throws(()=>parseFreeAgentConfirmation(confirmation(),binding,'TB:Baker Mayfield','Chi:Cairo Santos'),/confirmation_kind/);
 for(const bad of [fa.replace('dpid=28227','dpid=9'),fa.replace('button Add Baker','button Submit Baker'),fa.replace('Week 1','Week unknown')])
  assert.throws(()=>parseFreeAgentConfirmation(bad,binding,'TB:Baker Mayfield','Chi:Cairo Santos'));
 h.pages[2]=h.pages[2].replace('Claim Player From Waivers','Add Free Agent');h.pages[3]=fa;
 const ticket=await h.driver.prepare({...h.action,kind:'add_drop'},h.state);
 await h.driver.commit(ticket,async()=>{});assert.deepEqual(h.clicks,[6,21,31,170]);
}));
