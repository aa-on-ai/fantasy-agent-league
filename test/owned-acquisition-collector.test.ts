import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { digest } from "../src/manager/season.js";
import { collectOwnedAcquisitions, observedOwnedPoolFilter } from "../src/platforms/yahoo/owned-acquisition-collector.js";
import { normalizeOwnedAssessment, readOwnedPlayerDetails, readOwnedPool, readOwnedRoster, readOwnedRules, type OwnedAssessmentInput, type OwnedObservation } from "../src/platforms/yahoo/owned-sources.js";
import type { OwnedClaimsEvidence } from "../src/platforms/yahoo/guarded-owned.js";

const fixture = (name: string): OwnedObservation => JSON.parse(readFileSync(`test/fixtures/owned-sources/${name}.json`, "utf8"));
const binding = { leagueId: "100", teamId: "1", teamName: "Example Team", profileId: "fixture-profile", maxAgeMs: 3600000, season: 2026, period: "2" };
const now = new Date("2026-09-15T22:45:00Z");
const base = "https://football.fantasysports.yahoo.com/f1/100";
const rules = () => readOwnedRules(fixture("rules"), binding, now);
function pool(phase: "W" | "FA" = "W") {
  const o = fixture("pool"), controls = o.dom.controls;
  controls.find(c => c.name === "status")!.value = phase;
  for (const option of controls.find(c => c.name === "status")!.options) option.selected = option.value === phase;
  controls.push(...["O", "K", "DEF"].map(value => ({ tag: "input", type: "radio", name: "pos", value, text: value, disabled: false, attributes: {}, options: [] })));
  o.dom.forms.push({ action: base + "/players", method: "get", attributes: {}, controls: structuredClone(controls) });
  o.dom.links.push(...o.dom.tables.flatMap(t => t.rows).flatMap(r => r.links));
  if (phase === "FA") for (const row of o.dom.tables[0]!.rows) row.cells[3] = "FA";
  return o;
}
function detail(source: OwnedObservation, id: string, name: string) {
  const o = structuredClone(source), player = o.dom.tables.flatMap(t => t.rows).flatMap(r => r.links).find(l => l.text === name && l.attributes["data-ys-playerid"] === id)!;
  o.observationId = "detail-" + id;
  if (!o.dom.links.some(l => l.text === name && l.attributes["data-ys-playerid"] === id)) o.dom.links.push(player);
  o.dom.links.push({ ...player, attributes: { class: "player-name" } });
  o.dom.headings.push("2026 Season Game Log", "Latest News");
  o.dom.text += `\nLatest News\nThere are no news updates for ${name} in the last 10 days.`;
  o.dom.tables.push({ caption: "", attributes: {}, headers: ["Week", "Opp", "Status", "Proj", "Fan Pts"], rows: [
    { cells: ["2", "Was", "Sun 4:25 PM", "21.17", "-"], attributes: {}, controls: [], links: [] },
    { cells: ["3", "Bal", "4:25 PM", "18.21", "-"], attributes: {}, controls: [], links: [] },
    { cells: ["4", "BYE", "-", "-", "-"], attributes: {}, controls: [], links: [] }
  ] }); return o;
}
function claims(): OwnedClaimsEvidence {
  const observation = fixture("roster");
  return { observation, sourceHash: digest(observation), normalized: true, claims: [], interpretation: "observed_empty", supportingDocumentIds: ["first-document", "second-document"] };
}
function input(phase: "W" | "FA" = "W"): OwnedAssessmentInput {
  const roster = fixture("roster"), candidates = pool(phase);
  const transactions = fixture("roster"); transactions.url = base + "/transactions"; transactions.dom.headings = ["Transactions"]; transactions.dom.text = "Transactions\nNo recent transactions";
  const all = [{ observation: roster, players: readOwnedRoster(roster, rules(), binding, now).players }, { observation: candidates, players: readOwnedPool(candidates, rules(), binding, now).players }];
  return { roster, rules: fixture("rules"), pools: [candidates], drops: fixture("drops"), transactions, pendingClaimsEvidence: claims(),
    playerDetails: all.flatMap(({ observation, players }) => players.map(p => ({ playerId: p.id, playerName: p.name, observation: detail(observation, p.id, p.name) }))) };
}
test("pool filter GET uses one owned form and offered current-week status/position options", () => {
  const result = new URL(observedOwnedPoolFilter(pool(), binding, "waivers", "2", "DEF", now));
  assert.equal(result.pathname, "/f1/100/players"); assert.deepEqual(Object.fromEntries(result.searchParams), { status: "W", stat1: "S_PW_2", pos: "DEF" });
  for (const change of [
    (o: OwnedObservation) => { o.dom.forms[0]!.method = "post"; },
    (o: OwnedObservation) => { o.dom.forms[0]!.action = "https://evil.example/f1/100/players"; },
    (o: OwnedObservation) => { o.dom.forms.push(structuredClone(o.dom.forms[0]!)); },
    (o: OwnedObservation) => { o.dom.forms[0]!.controls.find(c => c.name === "status")!.options.find(o => o.value === "W")!.disabled = true; },
    (o: OwnedObservation) => { o.dom.forms[0]!.controls = o.dom.forms[0]!.controls.filter(c => c.value !== "DEF"); }
  ]) { const o = pool(); change(o); assert.throws(() => observedOwnedPoolFilter(o, binding, "waivers", "2", "DEF", now)); }
});
test("available-player card binds exact selected projection week and rejects wrong player, route and period", () => {
  const o = detail(pool(), "34218", "Brock Purdy");
  assert.equal(readOwnedPlayerDetails(o, binding, "34218", "Brock Purdy", now).games.length, 3);
  for (const change of [
    (o: OwnedObservation) => { o.dom.controls.find(c => c.name === "stat1")!.value = "S_PW_3"; },
    (o: OwnedObservation) => { o.dom.controls.find(c => c.name === "stat1")!.options.forEach(o => { o.selected = false; }); },
    (o: OwnedObservation) => { o.dom.links.find(l => l.attributes.class === "player-name")!.text = "C.J. Stroud"; },
    (o: OwnedObservation) => { o.url = base + "/addplayer?apid=34218"; }
  ]) { const copy = structuredClone(o); change(copy); assert.throws(() => readOwnedPlayerDetails(copy, binding, "34218", "Brock Purdy", now)); }
});
test("complete waiver assessment has sourced candidate cutoff and independent drop deadline", () => {
  const a = normalizeOwnedAssessment(input(), binding, "waivers", now);
  assert.ok(a.snapshot); assert.deepEqual(a.gaps, []); assert.equal(a.readiness.waivers, true);
  assert.equal(a.acquisitionDeadlines["34218"], "2026-09-16T06:59:00.000Z");
  assert.equal(a.acquisitionDeadlines["29369"], "2026-09-20T20:25:00.000Z");
  assert.ok(a.sources.some(s => s.kind === "locks" && s.playerIds.includes("34218") && JSON.stringify(s.content).includes("conservative_submission_cutoff_not_processing_time")));
  assert.ok(a.sources.some(s => s.kind === "pool" && JSON.stringify(s.content).includes("observed_page_only")));
  assert.equal(normalizeOwnedAssessment(input("FA"), binding, "free_agents", now).readiness.free_agents, true);
});
test("unknown/tampered claims, unsupported deadline and missing available-player evidence remain not-ready", () => {
  for (const change of [
    (x: OwnedAssessmentInput) => { x.pendingClaimsEvidence = null; },
    (x: OwnedAssessmentInput) => { x.pendingClaimsEvidence!.sourceHash = "bad"; },
    (x: OwnedAssessmentInput) => { x.pendingClaimsEvidence!.claims.push({ id: "claim-1", leagueId: "other", teamId: "1", period: "2", addId: "34218", dropId: "29369" }); },
    (x: OwnedAssessmentInput) => { x.pools![0]!.dom.tables[0]!.rows[0]!.cells[3] = "W (Sep 17)"; },
    (x: OwnedAssessmentInput) => { x.playerDetails = x.playerDetails!.filter(p => p.playerId !== "34218"); },
    (x: OwnedAssessmentInput) => { x.playerDetails!.find(p => p.playerId === "34218")!.observation.capturedAt = "2020-01-01T00:00:00Z"; }
  ]) { const x = input(); change(x); const a = normalizeOwnedAssessment(x, binding, "waivers", now); assert.equal(a.readiness.waivers, false); assert.ok(a.gaps.length); }
});

function fakePage(phase: "W" | "FA" = "W") {
  const roster = fixture("roster"); roster.dom.links.push(...["/settings", "/players", "/1/dropplayer", "/transactions"].map(path => ({ text: path === "/players" ? "Players" : path, href: base + path, title: "", attributes: {} })));
  roster.dom.links.push({text:"Compare My Team",href:base+"/players?myteam=1",title:"",attributes:{}});
  roster.dom.links.push(...roster.dom.tables.flatMap(t => t.rows).flatMap(r => r.links));
  const original = input(phase), requests: string[] = []; let current = roster, url = roster.url, removed = false;
  const page = {
    route: async () => {}, unroute: async () => { removed = true; }, url: () => url,
    goto: async (destination: string) => {
      requests.push(destination); url = destination; const u = new URL(destination);
      if (u.pathname.endsWith("/settings")) current = fixture("rules");
      else if (u.pathname.endsWith("/dropplayer")) current = fixture("drops");
      else if (u.pathname.endsWith("/transactions")) current = original.transactions!;
      else if (u.pathname.endsWith("/players")) { current = pool(phase); if (["K", "DEF"].includes(u.searchParams.get("pos") ?? "")) { current.dom.tables = []; current.dom.text += "\nNo players found"; } }
      else current = structuredClone(roster);
      current.url = destination; return { status: () => 200 };
    }, waitForLoadState: async () => {}, evaluate: async () => current.dom,
    getByText: () => ({ isVisible: async () => false }),
    getByRole: () => ({ count: async () => 0, waitFor: async () => {} }),
    locator: (selector: string) => ({
      count: async () => selector.startsWith("a[aria-label=") ? 1 : 0,
      filter: () => ({ waitFor: async () => {} }),
      click: async () => { const id = selector.match(/data-ys-playerid="(\d+)"/)?.[1]; const player = current.dom.links.find(l => l.attributes["data-ys-playerid"] === id && l.attributes.class?.includes("name")); assert.ok(player); current = detail(current, id!, player.text); }
    })
  } as unknown as Page;
  return { page, requests, removed: () => removed };
}
test("automatic collector reads all observed page candidates, returns complete sources and never visits action routes", async () => {
  const fake = fakePage(), records: OwnedObservation[] = [];
  const result = await collectOwnedAcquisitions(fake.page, binding, "waivers", async o => { records.push(o); }, async () => {}, { clock: () => now, collectPendingClaims: async () => claims() });
  assert.deepEqual(result.assessment.gaps, []); assert.equal(result.assessment.readiness.waivers, true);
  assert.equal(result.input.playerDetails!.length, 6); assert.deepEqual(result.coverage.positions, ["O", "K", "DEF"]);
  assert.equal(result.coverage.scope, "observed_page_only"); assert.equal(result.coverage.paginationFollowed, false);
  assert.deepEqual(result.coverage.playerIds, ["34218", "40030"]);
  assert.ok(records.length > 6); assert.ok(fake.removed()); assert.ok(fake.requests.every(url => !/addplayer|editwaiver|cancel/.test(url)));
});
test("capture bound never silently truncates candidate evidence and unknown queue remains null", async () => {
  const fake = fakePage();
  const result = await collectOwnedAcquisitions(fake.page, binding, "waivers", async () => {}, async () => {}, { clock: () => now, maxDetailPlayers: 1 });
  assert.equal(result.assessment.readiness.waivers, false); assert.ok(result.assessment.gaps.includes("detail_capture_bound_exceeded:6:1"));
  assert.equal(result.pendingClaimsEvidence, null); assert.ok(result.assessment.gaps.includes("pending_claims_unobserved"));
  assert.deepEqual(result.coverage.playerIds, ["34218", "40030"]); assert.ok(fake.removed());
});
