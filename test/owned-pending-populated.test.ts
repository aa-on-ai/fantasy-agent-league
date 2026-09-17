import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readOwnedPendingClaims,type OwnedObservation} from '../src/platforms/yahoo/owned-sources.js';
const fixture=JSON.parse(readFileSync('test/fixtures/owned-sources/pending-claim.json','utf8')) as {queue:OwnedObservation;detail:OwnedObservation};
const binding={leagueId:'1659459',teamId:'1',teamName:'Example Sandbox Team',profileId:'fantasy-agent-1-owned-chrome',period:'2',season:2026,maxAgeMs:900000};
const now=new Date('2026-09-16T04:25:00Z');
const parse=(q=fixture.queue,d=[fixture.detail])=>readOwnedPendingClaims(q,binding,fixture.queue.url,now,d);
test('actual populated Yahoo queue binds claim_id to independent detail player rows and form',()=>{
 const r=parse();assert.equal(r.status,'observed');assert.deepEqual(r.claims,[{id:'1_34218_29235',addId:'34218',dropId:'29235'}]);
 assert.equal(parse(fixture.queue,[]).status,'unobserved');
});
test('pending queue never treats priorities, incomplete coverage or changed detail as proof',()=>{
 for(const mutate of [
  (q:OwnedObservation,d:OwnedObservation)=>{q.dom.links[1]!.href=q.dom.links[1]!.href.replace('1_34218_29235','1');},
  (q:OwnedObservation,d:OwnedObservation)=>{q.dom.pendingTransactionCount=2;},
  (q:OwnedObservation,d:OwnedObservation)=>{delete q.dom.pendingTransactionLinks;},
  (q:OwnedObservation,d:OwnedObservation)=>{q.dom.pendingTransactionLinks!.push({...q.dom.links[0]!,href:'https://football.fantasysports.yahoo.com/f1/1659459/1/trade'});},
  (q:OwnedObservation,d:OwnedObservation)=>{d.dom.forms[0]!.numericFields!.find(f=>f.name==='dpid')!.value='29369';},
  (q:OwnedObservation,d:OwnedObservation)=>{d.dom.text=d.dom.text.replace('Week 2','Week 3');},
  (q:OwnedObservation,d:OwnedObservation)=>{d.dom.forms[0]!.controls[0]!.disabled=true;},
  (q:OwnedObservation,d:OwnedObservation)=>{d.url+='&claim_id=1_34218_29235';},
  (q:OwnedObservation,d:OwnedObservation)=>{d.dom.readyState='loading';},
 ]){const {queue,detail}=structuredClone(fixture);mutate(queue,detail);assert.equal(parse(queue,[detail]).status,'unobserved');}
});
