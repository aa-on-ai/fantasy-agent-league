import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { observeEmptyOwnedClaims, type OwnedClaimPage } from "../src/platforms/yahoo/owned-claims.js";
import { readOwnedRules, type OwnedObservation } from "../src/platforms/yahoo/owned-sources.js";
const now = new Date("2026-09-15T22:45:00Z");
const binding = { leagueId: "100", teamId: "1", teamName: "Example Team", profileId: "fixture-profile", maxAgeMs: 3600000, period: "2" };
const fixture = (name: string): OwnedObservation => JSON.parse(readFileSync(`test/fixtures/owned-sources/${name}.json`, "utf8"));
const doc = (o: OwnedObservation): OwnedClaimPage => ({observation:o,document:{id:o.observationId,url:o.url,status:200,method:"GET",outstanding:0,failed:[]}});
const observed = (c:OwnedObservation,p:OwnedObservation,r:ReturnType<typeof readOwnedRules>)=>observeEmptyOwnedClaims(doc(c),doc(p),r,binding,now);
function pair() {
  const previous = fixture("roster"); previous.dom.readyState = "complete"; previous.dom.claimMarkerCount=0;
  previous.dom.headings.push("Legends and Glossaries", "The Fine Print");
  const link = (text: string, path: string) => ({ text, href: "https://football.fantasysports.yahoo.com" + path, title: "", attributes: {} });
  previous.dom.links.push(link("Add Player", "/f1/100/players"), link("Drop Player", "/f1/100/1/dropplayer"));
  const current = structuredClone(previous); current.observationId += "-independent";
  current.capturedAt = new Date(Date.parse(previous.capturedAt) + 1000).toISOString();
  return { previous, current, rules: readOwnedRules(fixture("rules"), binding, now) };
}
test("two complete known My Team views establish observed zero, not an invented explicit empty label", () => {
  const {current,previous,rules} = pair();
  const evidence = observed(current, previous, rules);
  assert.ok(evidence); assert.deepEqual(evidence.claims, []); assert.equal(evidence.observation.observationId,current.observationId);
});
test("missing, partially loaded, populated or changed claims views remain unknown", () => {
  const changes: Array<(o: OwnedObservation) => void> = [
    o => { delete o.dom.readyState; }, o => { o.dom.readyState="loading"; },
    o => { delete o.dom.claimMarkerCount; }, o => { o.dom.claimMarkerCount=1; },
    o => { o.dom.tables=[]; }, o => { o.dom.headings=[]; }, o => { o.dom.links=o.dom.links.filter(l=>l.text!=="Drop Player"); },
    o => { o.dom.text += "\nPending Transactions"; }, o => { o.dom.text += "\nUnable to load"; },
    o => { o.dom.links.push({text:"Details",href:o.url+"?waid=123",title:"",attributes:{}}); },
    o => { o.dom.tables[0]!.rows[0]!.attributes.class="Draggable"; },
    o => { o.url += "?week=1"; }, o => { o.profileId="another-profile"; },
    o => { o.capturedAt="2000-01-01T00:00:00Z"; }
  ];
  for (const change of changes) {
    const {current,previous,rules} = pair(); change(current);
    assert.equal(observed(current, previous, rules), null);
  }
  const {current,previous,rules}=pair();
  assert.equal(observed(current, current, rules),null);
  previous.dom.text += "\nWaiver claim";
  assert.equal(observed(current, previous, rules),null);
});
test("aborted claims reads, HTTP errors, pending requests and non-independent documents block zero inference",()=>{
 for(const mutate of [
  (p:OwnedClaimPage)=>{p.document.failed.push({path:"/claims",method:"POST",resourceType:"xhr"});},
  (p:OwnedClaimPage)=>{p.document.status=500;},(p:OwnedClaimPage)=>{p.document.outstanding=1;},
  (p:OwnedClaimPage)=>{p.document.url="https://football.fantasysports.yahoo.com/f1/100/2";}
 ]){
  const {current,previous,rules}=pair(),page=doc(current);mutate(page);
  assert.equal(observeEmptyOwnedClaims(page,doc(previous),rules,binding,now),null);
 }
});
