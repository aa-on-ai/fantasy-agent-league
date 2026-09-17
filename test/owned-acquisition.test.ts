import test from "node:test";
import assert from "node:assert/strict";
import { ownedAcquisitionDeadline } from "../src/platforms/yahoo/owned-acquisition.js";
import type { OwnedPoolPlayer, OwnedRules } from "../src/platforms/yahoo/owned-sources.js";
const rules = {weeklyWaivers:"Game Time - Tuesday",waiverType:"rolling"} as OwnedRules;
const player = {availability:"waivers",waiverDateText:"Sep 16",kickoff:"2026-09-20T17:00:00Z",addControlObserved:true} as OwnedPoolPlayer;
test("owned acquisition cutoff is conservative and timezone-bound",()=>{
  assert.equal(ownedAcquisitionDeadline(player,rules,2026,new Date("2026-09-16T04:00:00Z")),"2026-09-16T06:59:00.000Z");
  assert.equal(ownedAcquisitionDeadline({...player,waiverDateText:"Nov 18",kickoff:"2026-11-22T18:00:00Z"},rules,2026,new Date("2026-11-18T04:00:00Z")),"2026-11-18T07:59:00.000Z");
  assert.equal(ownedAcquisitionDeadline({...player,availability:"free_agent"},rules,2026,new Date("2026-09-16T04:00:00Z")),player.kickoff);
});
test("owned acquisition cutoff rejects missing, unsupported and expired evidence",()=>{
  for(const p of [{...player,waiverDateText:"Sep 17"},{...player,waiverDateText:null},{...player,kickoff:null},{...player,addControlObserved:false}])
    assert.equal(ownedAcquisitionDeadline(p,rules,2026,new Date("2026-09-16T04:00:00Z")),null);
  assert.equal(ownedAcquisitionDeadline(player,{...rules,weeklyWaivers:"Continuous"},2026,new Date("2026-09-16T04:00:00Z")),null);
  assert.equal(ownedAcquisitionDeadline(player,rules,2026,new Date("2026-09-16T06:59:00Z")),null);
});
