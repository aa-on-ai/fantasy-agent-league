import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { digest } from "../src/manager/season.js";
import { captureOwnedObservation, normalizeOwnedAssessment, readOwnedDrops, readOwnedPendingClaims, readOwnedPlayerDetails,
  importOwnedCapture, readOwnedPool, readOwnedRoster, readOwnedRules, readOwnedTransactions, validateOwnedObservation, type OwnedObservation } from "../src/platforms/yahoo/owned-sources.js";
const fixture = (name: string): OwnedObservation => JSON.parse(readFileSync(`test/fixtures/owned-sources/${name}.json`, "utf8"));
const binding = { leagueId: "100", teamId: "1", teamName: "Example Team", profileId: "fixture-profile", maxAgeMs: 3600000 };
const now = new Date("2026-09-15T22:45:00Z");
const rules = () => readOwnedRules(fixture("rules"), binding, now);
const roster = () => readOwnedRoster(fixture("roster"), rules(), binding, now);
function details(id = "29369", name = "Dak Prescott"): OwnedObservation {
  const o = fixture("roster");
  o.observationId = "fixture-details-" + id;
  const l = o.dom.tables.flatMap(t => t.rows).flatMap(r => r.links).find(l => l.text === name)!;
  o.dom.links.push(l, { ...l, attributes: { class: "player-name" } });
  o.dom.headings.push("2026 Season Game Log", "Latest News");
  o.dom.text += `\n${name}\n2026 Season Game Log\nLatest News\nThere are no news updates for ${name} in the last 10 days.`;
  o.dom.tables.push({ caption: "", attributes: {}, headers: ["Week", "Opp", "Status", "Proj", "Fan Pts"], rows: [
    { cells: ["2", "Was (8th)", "Sun 4:25 PM", "21.17", "-"], attributes: {}, controls: [], links: [] },
    { cells: ["3", "Bal (28th)", "4:25 PM", "18.21", "-"], attributes: {}, controls: [], links: [] },
    { cells: ["4", "BYE", "-", "-", "-"], attributes: {}, controls: [], links: [] },
  ] });
  return o;
}
test("observed DOM shape binds numeric IDs, defense ID, explicit controls, dated kickoff and oldest source clock", () => {
  const r = roster(); assert.equal(r.period, "2"); assert.equal(r.players.length, 4); assert.deepEqual(r.gaps, []);
  assert.equal(r.players.find(p => p.name === "Texans")!.id, "100034");
  assert.equal(r.players.find(p => p.id === "29235")!.kickoff, "2026-09-18T00:15:00.000Z");
  const a = normalizeOwnedAssessment({ roster: fixture("roster"), rules: fixture("rules") }, binding, "lineup", now);
  assert.ok(a.snapshot); assert.equal(a.snapshot.capturedAt, fixture("roster").capturedAt);
  assert.equal(a.readiness.lineup, false); assert.equal(a.sources.some(s => s.kind === "news"), false);
  assert.equal(a.gaps.filter(g => g.startsWith("news_unobserved:")).length, 4);
  for (const source of a.sources) assert.equal(source.contentHash, digest(source.content));
});
test("source ownership validates URL, My Team link, profile, time and period independently", () => {
  for (const change of [
    (o: OwnedObservation) => { o.url = o.url.replace("/100/1", "/100/2"); },
    (o: OwnedObservation) => { o.dom.links[0]!.href = o.dom.links[0]!.href.replace("/100/1", "/100/2"); },
    (o: OwnedObservation) => { o.profileId = "wrong"; },
    (o: OwnedObservation) => { o.capturedAt = "2020-01-01"; },
    (o: OwnedObservation) => { o.capturedAt = "2030-01-01"; },
    (o: OwnedObservation) => { o.url = "https://evil.example/f1/100/1"; },
  ]) { const o = fixture("roster"); change(o); assert.throws(() => validateOwnedObservation(o, binding, now)); }
  assert.throws(() => readOwnedRoster(fixture("roster"), rules(), { ...binding, period: "1" }, now), /period/);
});
test("wrong rules, missing metrics and conflicting date/weekday cannot produce usable roster", () => {
  const wrong = fixture("rules"); wrong.dom.tables[0]!.rows[0]!.cells[1] = "101";
  assert.throws(() => readOwnedRules(wrong, binding, now), /league/);
  const noPoints = fixture("roster"); noPoints.dom.tables[0]!.headers[5] = "Unknown";
  assert.throws(() => readOwnedRoster(noPoints, rules(), binding, now), /columns/);
  const date = fixture("roster"); const link = date.dom.tables[0]!.rows[0]!.links.find(l => /20260920006/.test(l.href))!;
  link.href = link.href.replace("20260920", "20260921");
  assert.throws(() => readOwnedRoster(date, rules(), binding, now), /schedule_date_conflict/);
});
test("absence of edit control is unknown, not unlocked or locked", () => {
  const o = fixture("roster"); o.dom.tables[0]!.rows[0]!.controls = [];
  const r = readOwnedRoster(o, rules(), binding, now); assert.equal(r.players[0]!.locked, null); assert.ok(r.gaps.includes("locks_unobserved:29369"));
  const a = normalizeOwnedAssessment({ roster: o, rules: fixture("rules") }, binding, "lineup", now);
  assert.equal(a.snapshot, null); assert.equal(a.readiness.lineup, false);
});
test("injury D remains an observed doubtful label, not an invented out designation", () => {
  const o = fixture("roster"), r = o.dom.tables[0]!.rows[0]!;
  r.cells[2] = r.cells[2]!.replace("Dak PrescottPlayer", "Dak PrescottDPlayer");
  assert.equal(readOwnedRoster(o, rules(), binding, now).players[0]!.injuryLabel, "D");
});
test("NA stays not-active without invalidating the entire observed pool or inventing an injury", () => {
  const o = fixture("pool"), row = o.dom.tables[0]!.rows[0]!;
  row.cells[2] = row.cells[2]!.replace("Brock PurdyVideo", "Brock PurdyNAVideo");
  assert.equal(readOwnedPool(o, rules(), binding, now).players[0]!.injuryLabel, "NA");
  const assessment = normalizeOwnedAssessment({roster: fixture("roster"), rules: fixture("rules"), pools: [o], drops: fixture("drops")}, binding, "waivers", now);
  assert.equal(assessment.snapshot?.available[0]!.status, "not_active");
  assert.ok(!assessment.gaps.includes("snapshot:unsupported_owned_player_status"));
});
test("drop permission derives from independent observed button and matching pid", () => {
  const o = fixture("drops"); assert.equal(readOwnedDrops(o, binding, now).players[0]!.state, "offered");
  o.dom.tables[0]!.rows[0]!.controls[0]!.attributes["data-check-box-value"] = "999";
  assert.throws(() => readOwnedDrops(o, binding, now), /identity_conflict/);
  o.dom.tables[0]!.rows[0]!.controls = [];
  assert.equal(readOwnedDrops(o, binding, now).players[0]!.state, "unknown");
});
test("pool forecasts require actual selected weekly projection scope; empty is explicit and page bounded", () => {
  const o = fixture("pool"), r = readOwnedPool(o, rules(), binding, now);
  assert.equal(r.players[0]!.id, "34218"); assert.equal(r.players[0]!.availability, "waivers"); assert.equal(r.players[0]!.projectedPoints, 19.99);
  assert.equal(r.coverage, "observed_page_only");
  o.dom.controls.find(c => c.name === "stat1")!.value = "S_2026";
  assert.throws(() => readOwnedPool(o, rules(), binding, now), /projection_period/);
  const empty = fixture("pool"); empty.dom.tables = [];
  assert.throws(() => readOwnedPool(empty, rules(), binding, now), /pool_unobserved/);
  empty.dom.text += "\nNo players found"; assert.equal(readOwnedPool(empty, rules(), binding, now).empty, true);
});
test("news binds the actual selected player, preserves explicit empty lookback, and retains unknown dates", () => {
  const o = details(), r = readOwnedPlayerDetails(o, binding, "29369", "Dak Prescott", now);
  assert.equal(r.news.status, "none_in_last_10_days"); assert.equal(r.news.publicationDatesResolved, false);
  assert.equal(r.games[2]!.projectedPoints, null);
  assert.throws(() => readOwnedPlayerDetails(o, binding, "29235", "Jared Goff", now), /selected_player/);
  o.dom.headings = o.dom.headings.filter(h => h !== "Latest News");
  assert.throws(() => readOwnedPlayerDetails(o, binding, "29369", "Dak Prescott", now), /details_unobserved/);
});
test("complete lineup assessment requires current per-player news, not merely an available link", () => {
  const rs = roster(), playerDetails = rs.players.map(p => ({ playerId: p.id, playerName: p.name, observation: details(p.id, p.name) }));
  const a = normalizeOwnedAssessment({ roster: fixture("roster"), rules: fixture("rules"), playerDetails }, binding, "lineup", now);
  assert.ok(a.snapshot); assert.deepEqual(a.gaps, []); assert.equal(a.readiness.lineup, true);
  assert.equal(a.readiness.free_agents, false); assert.equal(a.readiness.waivers, false);
  playerDetails[0]!.observation.capturedAt = "2020-01-01";
  assert.equal(normalizeOwnedAssessment({ roster: fixture("roster"), rules: fixture("rules"), playerDetails }, binding, "lineup", now).readiness.lineup, false);
});
test("transactions cannot satisfy pending claims; missing and empty queue evidence stay distinct", () => {
  const o = fixture("roster"); o.url = "https://football.fantasysports.yahoo.com/f1/100/transactions"; o.dom.headings = ["Transactions"]; o.dom.text = "Transactions\nNo recent transactions";
  assert.equal(readOwnedTransactions(o, binding, now).pendingClaims, "unobserved");
  assert.throws(() => readOwnedPendingClaims(o, binding, o.url, now), /pending_claims_route/);
  o.url = "https://football.fantasysports.yahoo.com/f1/100/1/example-queue";
  assert.equal(readOwnedPendingClaims(o, binding, o.url, now).status, "unobserved");
  o.dom.headings = ["Pending Waiver Claims"]; o.dom.text = "You have no pending waiver claims";
  assert.equal(readOwnedPendingClaims(o, binding, o.url, now).status, "explicitly_empty");
});
test("two same-millisecond independent read captures have different IDs and no mutations", async () => {
  const o = fixture("roster"), page = { url: () => o.url, evaluate: async () => o.dom } as unknown as Page;
  const a = await captureOwnedObservation(page, binding.profileId, () => now), b = await captureOwnedObservation(page, binding.profileId, () => now);
  assert.notEqual(a.observationId, b.observationId); assert.deepEqual(a.dom, b.dom);
});

test("raw import excludes hidden secrets and admits only numeric allowlisted form identities", () => {
  const o = fixture("roster");
  const raw = { schemaVersion: 1, evidenceType: "owned_browser_dom", url: o.url, capturedAt: o.capturedAt, ...o.dom,
    controls: [{ tag: "input", type: "hidden", name: ".crumb", value: "not-a-real-secret" }],
    forms: [{ action: o.url + "/addplayer", method: "post", controls: [{ tag: "input", type: "password", value: "not-a-real-password" }],
      numericFields: [{ name: "stage", value: "3" }, { name: "apid", value: "34218" }, { name: ".crumb", value: "123456" }, { name: "dpid", value: "not-numeric" }] }] };
  const imported = importOwnedCapture(raw, binding.profileId);
  assert.deepEqual(imported.dom.controls, []); assert.deepEqual(imported.dom.forms[0]!.controls, []);
  assert.deepEqual(imported.dom.forms[0]!.numericFields, [{ name: "stage", value: "3" }, { name: "apid", value: "34218" }]);
  assert.equal(JSON.stringify(imported).includes("not-a-real"), false);
});
