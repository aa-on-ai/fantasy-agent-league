import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { assertOwnedBrowserProfile, withOwnedBrowser, parseOwnedAcquisitionConfirmation, atomicOwnedGesture, YahooOwnedDriver } from "../src/platforms/yahoo/owned-browser.js";
import { snapshotHash, type SeasonSnapshot } from "../src/manager/season.js";
import type { OwnedControl, OwnedObservation, OwnedRow } from "../src/platforms/yahoo/owned-sources.js";
import type { OwnedState } from "../src/platforms/yahoo/guarded-owned.js";
const origin = "https://football.fantasysports.yahoo.com";
const link = (text: string, href: string, attributes: Record<string, string> = {}) => ({ text, href, title: text, attributes });
const control = (text: string, attrs: Record<string, string> = {}): OwnedControl => ({ tag: "button", type: "submit", name: "", text, value: "", disabled: false, attributes: attrs, options: [] });
function row(id: string, name: string, pos: string, className = "editable"): OwnedRow {
  return { cells: [pos, name], links: [link(name, `https://sports.yahoo.com/nfl/players/${id}`, { "data-ys-playerid": id })],
    attributes: { "data-pos": pos, class: className, "data-swap-groups": "ALL", "data-swap-targets": "ALL" },
    controls: [{ ...control(pos, { "aria-label": `Click here to edit ${pos} ${name}`, "data-pos": pos }), tag: "span", type: "" }] };
}
function observation(): OwnedObservation {
  return { observationId: "test-only-before", capturedAt: new Date().toISOString(), profileId: "fixture", url: origin + "/f1/100/2",
    dom: { title: "Sanitized contract fixture, not Yahoo evidence", text: "", headings: [], forms: [],
      links: [link("My Team", origin + "/f1/100/2")], controls: [],
      tables: [{ caption: "Fixture's Offense roster for week 2.", headers: [], attributes: {}, rows: [row("11", "Starter", "QB"), row("22", "Bench", "BN")] }] } };
}
function confirmation(kind: "waiver_claim" | "add_drop"): OwnedObservation {
  const o = observation(); o.url = origin + "/f1/100/2/addplayer?apid=33";
  const heading = kind === "waiver_claim" ? "Claim Player From Waivers" : "Add Free Agent";
  o.dom.headings = [heading];
  o.dom.tables[0]!.rows = [row("33", "Candidate", ""), row("22", "Bench", "")];
  o.dom.controls = [{ ...control(""), tag: "input", name: "submit_add_player", value: `${kind === "waiver_claim" ? "Create claim to Add" : "Add"} Candidate, Drop Bench` }];
  o.dom.forms = [{ action: origin + "/f1/100/2/addplayer", method: "post", attributes: {}, controls: o.dom.controls,
    numericFields: [{ name: "stage", value: "3" }, { name: "apid", value: "33" }, { name: "dpid", value: "22" }] } as OwnedObservation["dom"]["forms"][number]];
  o.dom.links.push(link("Stats", origin + "/f1/100/2/addplayer?stage=2&apid=33&dpid=22"));
  o.dom.text = kind === "waiver_claim" ? "If successful, this waiver claim will be reflected in your lineup for Week 2 on Wednesday, Sep 16." : "This transaction will be reflected in your lineup for Week 2";
  return o;
}
test("owned profile requires existing private real directory and rejects symlink/permissive paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "owned-profile-test-"));
  try {
    const profile = join(root, "profile"); await mkdir(profile, { mode: 0o700 });
    await assertOwnedBrowserProfile(profile);
    await assert.rejects(assertOwnedBrowserProfile(join(root, "missing")), /missing_or_unavailable/);
    await symlink(profile, join(root, "alias")); await assert.rejects(assertOwnedBrowserProfile(join(root, "alias")), /unsafe/);
    await chmod(profile, 0o755); await assert.rejects(assertOwnedBrowserProfile(profile), /unsafe/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("owned lifecycle closes only its own successful launch, including callback failure", async () => {
  let close = 0, created = 0;
  const page = { route: async () => {} } as unknown as Page;
  const context = { newPage: async () => { created++; return page; }, close: async () => { close++; } } as unknown as BrowserContext;
  const options = { profilePath: "fixture-path", checkProfile: async () => {}, launch: async () => context };
  assert.equal(await withOwnedBrowser(options, async p => p === page), true);
  await assert.rejects(withOwnedBrowser(options, async () => { throw new Error("callback"); }), /callback/);
  await assert.rejects(withOwnedBrowser({ ...options, launch: async () => { throw new Error("profile busy"); } }, async () => true), /profile busy/);
  assert.equal(created, 2); assert.equal(close, 2);
});
test("acquisition parser binds numeric IDs, effective week, action kind and exact final button", () => {
  for (const kind of ["waiver_claim", "add_drop"] as const) {
    const action = { kind, addId: "33", dropId: "22", improvement: 1 }, binding = { leagueId: "100", teamId: "2", maxAgeMs: 60000 };
    const o = confirmation(kind);
    assert.equal(parseOwnedAcquisitionConfirmation(o, binding, action, "2").period, "2");
    for (const change of ["team", "duplicate-id", "wrong-drop", "week", "button", "kind", "disabled"]) {
      const bad = structuredClone(o);
      if (change === "team") bad.url = origin + "/f1/100/3/addplayer?apid=33";
      if (change === "duplicate-id") bad.dom.links[1]!.href += "&dpid=22";
      if (change === "wrong-drop") bad.dom.links[1]!.href = bad.dom.links[1]!.href.replace("dpid=22", "dpid=11");
      if (change === "week") bad.dom.text = bad.dom.text.replace("Week 2", "Week 3");
      if (change === "button") bad.dom.controls[0]!.value = "Submit";
      if (change === "kind") bad.dom.headings = [kind === "waiver_claim" ? "Add Free Agent" : "Claim Player From Waivers"];
      if (change === "disabled") bad.dom.controls[0]!.disabled = true;
      assert.throws(() => parseOwnedAcquisitionConfirmation(bad, binding, action, "2"), change);
    }
  }
});
test("atomic DOM gesture checks current identity, roster/selection state, target and expiry in the click task", () => {
  let clicks = 0;
  const expected = { url: origin + "/f1/100/2", teamPath: "/f1/100/2", period: "2", expiresAt: Date.now() + 60000,
    rows: [{ id: "22", position: "BN", className: "swaptarget", swapGroups: "ALL", swapTargets: "ALL" }],
    target: { tag: "span", type: "", name: "", text: "BN", value: "", ariaLabel: "Click here to edit BN Bench", rowId: "22" }, heading: null, confirmation: null, dropSelection: null };
  const make = (innerText: string, attrs: Record<string, string> = {}) => ({ innerText, tagName: "SPAN", name: "", type: "", value: "", disabled: false,
    href: "", getAttribute: (name: string) => attrs[name] ?? null, getClientRects: () => [1], click: () => { clicks++; } });
  const target = make("BN", { "aria-label": "Click here to edit BN Bench" });
  const owner = make("My Team"); owner.href = origin + "/f1/100/2";
  const player = make("Bench", { "data-ys-playerid": "22" }); player.href = "https://sports.yahoo.com/nfl/players/22";
  const rowAttrs: Record<string, string> = { "data-pos": "BN", class: "swaptarget", "data-swap-groups": "ALL", "data-swap-targets": "ALL" };
  const row = { ...make("", rowAttrs), querySelectorAll: (selector: string) => selector === "a[href]" ? [player] : [target] };
  const document = { querySelectorAll: (selector: string) => selector === "a[href]" ? [owner] : selector === "table tbody tr" ? [row] : selector === "table caption" ? [make("Fixture's Offense roster for week 2.")] : [], body: { innerText: "" } };
  const replacements = { document, location: { href: expected.url, origin }, getComputedStyle: () => ({ visibility: "visible" }) };
  const previous = Object.fromEntries(Object.keys(replacements).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  Object.entries(replacements).forEach(([key, value]) => Object.defineProperty(globalThis, key, { value, configurable: true }));
  try {
    atomicOwnedGesture(expected); assert.equal(clicks, 1);
    owner.href = origin + "/f1/100/3"; assert.throws(() => atomicOwnedGesture(expected), /controls_changed/); owner.href = origin + "/f1/100/2";
    rowAttrs.class = "disabled"; assert.throws(() => atomicOwnedGesture(expected), /controls_changed/); rowAttrs.class = "swaptarget";
    target.disabled = true; assert.throws(() => atomicOwnedGesture(expected), /controls_changed/); target.disabled = false;
    assert.throws(() => atomicOwnedGesture({ ...expected, expiresAt: Date.now() - 1 }), /controls_changed/);
    assert.equal(clicks, 1);
  } finally { for (const key of Object.keys(replacements)) { if (previous[key]) Object.defineProperty(globalThis, key, previous[key]!); else Reflect.deleteProperty(globalThis, key); } }
});
test("driver ticket is single-use even when dispatch throws; stop before callback prevents dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "owned-driver-test-"));
  try {
    for (const variant of ["timeout", "stop", "mutated"]) {
      const stop = join(root, variant), o = observation(); let gestures = 0;
      const page = { url: () => o.url, getByText: () => ({isVisible:async()=>false}), waitForLoadState: async () => {}, waitForFunction: async () => {}, evaluate: async (fn: Function) => {
        if (fn === atomicOwnedGesture) {
          gestures++;
          if (gestures === 1) { o.dom.tables[0]!.rows[0]!.attributes.class = "editable swapactive"; o.dom.tables[0]!.rows[1]!.attributes.class = "editable swaptarget"; }
          else if (variant === "timeout") throw new Error("uncertain_dispatch");
          return;
        }
        return structuredClone(o.dom);
      } } as unknown as Page;
      const s: SeasonSnapshot = { schemaVersion: 1, leagueId: "100", teamId: "2", period: "2", capturedAt: o.capturedAt, hash: "", waiverType: "rolling", rosterLimit: 2,
        slots: [{ id: "QB:1", position: "QB" }], available: [], roster: ["11", "22"].map((id, i) => ({ id, slot: i === 0 ? "QB:1" : null, eligible: ["QB"],
          projectedPoints: 10, status: "active", locked: false, canDrop: true, availability: "rostered" })) };
      s.hash = snapshotHash(s);
      const state: OwnedState = { observation: o, snapshot: s, lineupDeadlines: {}, acquisitionDeadlines: {}, pendingClaims: null };
      const driver = new YahooOwnedDriver(page, { binding: { leagueId: "100", teamId: "2", maxAgeMs: 60000 }, profileId: "fixture", emergencyStopPath: stop,
        allowSubmission: true, normalize: async ob => ({ ...state, observation: ob }), record: async () => {}, atomicSwapEvidence: "sanitized-contract-fixture-only",
        atomicAcquisitionEvidence: null, swapSelection: { sourceClass: "swapactive", targetClass: "swaptarget" } });
      const ticket = await driver.prepare({ kind: "set_lineup", lineup: { "QB:1": "22" }, projectedPoints: 10 }, state);
      assert.equal(gestures, 1);
      if (variant === "stop") await writeFile(stop, "stop");
      if (variant === "mutated") ticket.period = "3";
      await assert.rejects(driver.commit(ticket, async () => {}));
      await assert.rejects(driver.commit(ticket, async () => {}));
      assert.equal(gestures, variant === "timeout" ? 2 : 1);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("observed default or filtered acquisition stages exact IDs; stale and changed filters block before preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "owned-stager-test-"));
  try {
    for (const variant of ["default", "filtered", "stale-source", "changed-filter"] as const) {
    const team = observation(); team.dom.links.push(link("Players", origin + "/f1/100/players"));
    const pool = observation(); pool.url = origin + "/f1/100/players";
    pool.dom.tables[0]!.rows = [row("33", "Candidate", "")];
    pool.dom.tables[0]!.rows[0]!.links.push({ ...link("+", origin + "/f1/100/addplayer?apid=33"), title: "Add Player" });
    if (variant !== "default") {
      pool.url += "?status=FA&stat1=S_PW_2&pos=K";
      pool.dom.controls = Object.entries({status: "FA", stat1: "S_PW_2"}).map(([name,value]) => ({...control(""), tag: "select", name, value, options: [{value,text:value,selected:true,disabled:false}]}));
    }
    const source = structuredClone(pool);
    if (variant === "stale-source") source.capturedAt = "2000-01-01T00:00:00Z";
    if (variant === "changed-filter") pool.dom.controls.find(c => c.name === "stat1")!.value = "S_PW_3";
    const manager = observation(); manager.url = origin + "/f1/100/selectmanager?done=fixture-public-route"; manager.dom.headings = ["Select Team"];
    manager.dom.forms = [{ action: origin + "/f1/100/selectmanager", method: "get", attributes: {}, controls: [
      { ...control("Team"), tag: "select", type: "select-one", name: "mid", value: "2", options: [{ value: "2", text: "Test team", selected: true, disabled: false }] }
    ] }];
    const selection = observation(); selection.url = origin + "/f1/100/addplayer?apid=33&mid=2"; selection.dom.headings = ["Add Free Agent"];
    selection.dom.tables[0]!.rows = [row("33", "Candidate", ""), row("22", "Bench", "")];
    selection.dom.tables[0]!.rows[1]!.controls = [{ ...control("—", { title: "Click to drop this player", "data-check-box-value": "22 " }), type: "button" }];
    const final = confirmation("add_drop"); final.url = selection.url;
    let current = team, previews = 0, commits = 0, managerChoices = 0, watchingNavigation = false;
    const navigations: string[] = [];
    const page = { url: () => current.url, getByText: () => ({isVisible:async()=>false}), waitForLoadState: async () => {}, goto: async (url: string) => {
      navigations.push(url); current = new URL(url).pathname.endsWith("/players") ? pool : manager; return { status: () => 200 };
    }, waitForURL: async () => {}, waitForNavigation: async () => { watchingNavigation = true; return {}; }, waitForFunction: async () => {}, evaluate: async (fn: Function, args: unknown) => {
      if (fn === atomicOwnedGesture) {
        const gesture = args as Parameters<typeof atomicOwnedGesture>[0];
        if (gesture.dropSelection) { assert.equal(gesture.dropSelection.dropId, "22"); assert.equal(gesture.dropSelection.addId, "33"); previews++; current = final; }
        else { assert.equal(gesture.confirmation!.dropId, "22"); assert.equal(watchingNavigation, true); commits++; }
        return;
      }
      if (args && typeof args === "object" && "teamId" in args) { assert.equal(args.teamId, "2"); managerChoices++; current = selection; return; }
      return structuredClone(current.dom);
    } } as unknown as Page;
    const p = (id: string, slot: string | null) => ({ id, slot, eligible: ["QB"], projectedPoints: 10, status: "active" as const, locked: false, canDrop: true, availability: "rostered" as const });
    const snapshot: SeasonSnapshot = { schemaVersion: 1, leagueId: "100", teamId: "2", period: "2", capturedAt: team.capturedAt, hash: "", rosterLimit: 2, waiverType: "rolling",
      roster: [p("11", "QB:1"), p("22", null)], available: [{ ...p("33", null), availability: "free_agent" }], slots: [{ id: "QB:1", position: "QB" }] };
    snapshot.hash = snapshotHash(snapshot);
    const state: OwnedState = { observation: team, snapshot, lineupDeadlines: {}, acquisitionDeadlines: {}, pendingClaims: null };
    const driver = new YahooOwnedDriver(page, { binding: { leagueId: "100", teamId: "2", maxAgeMs: 60000 }, profileId: "fixture", emergencyStopPath: join(root, "stop"), allowSubmission: true,
      normalize: async ob => ({ ...state, observation: ob }), record: async () => {}, atomicSwapEvidence: null, atomicAcquisitionEvidence: "synthetic-port-fixture-only", swapSelection: null,
      ...(variant === "default" ? {} : {getAcquisitionPoolSources: () => [source]}) });
    if (variant === "stale-source" || variant === "changed-filter") {
      await assert.rejects(driver.prepare({kind: "add_drop", addId: "33", dropId: "22", improvement: 1}, state), /owned_identity_unverified|acquisition_pool_source_unverified/);
      assert.equal(previews, 0); assert.equal(commits, 0); continue;
    }
    const ticket = await driver.prepare({ kind: "add_drop", addId: "33", dropId: "22", improvement: 1 }, state);
    assert.deepEqual(navigations, [pool.url, origin + "/f1/100/addplayer?apid=33"]);
    assert.equal(managerChoices, 1); assert.equal(previews, 1); assert.equal(commits, 0);
    assert.equal(ticket.period, "2"); assert.equal(ticket.teamId, "2");
    await driver.commit(ticket, async () => {});
    assert.equal(commits, 1); await assert.rejects(driver.commit(ticket, async () => {}));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("atomic acquisition refuses changed actual POST fields even when the visible confirmation still matches", () => {
  let clicks = 0;
  const url = origin + "/f1/100/2/addplayer?apid=33", label = "Create claim to Add Candidate, Drop Bench";
  const expected = { url, teamPath: "/f1/100/2", period: "2", expiresAt: Date.now() + 60000, rows: ["33", "22"].map(id => ({ id, position: "", className: "", swapGroups: "", swapTargets: "" })),
    target: { tag: "input", type: "submit", name: "submit_add_player", text: "", value: label, ariaLabel: "", rowId: null },
    heading: "Claim Player From Waivers", confirmation: { addId: "33", dropId: "22", label, effectiveText: "Week 2 on Wednesday, Sep 16" }, dropSelection: null };
  const make = (innerText: string, attrs: Record<string, string> = {}) => ({ innerText, tagName: "A", name: "", type: "", value: "", disabled: false, href: "",
    getAttribute: (name: string) => attrs[name] ?? null, hasAttribute: (name: string) => name in attrs, getClientRects: () => [1], click: () => { clicks++; } });
  const fields = { stage: { value: "3", disabled: false }, apid: { value: "33", disabled: false }, dpid: { value: "22", disabled: false } };
  const form = { method: "post", action: origin + "/f1/100/2/addplayer", querySelectorAll: (selector: string) => {
    const key = selector.match(/name="([^"]+)"/)?.[1]; return key && key in fields ? [fields[key as keyof typeof fields]] : [];
  } };
  const targetAttrs: Record<string, string> = {};
  const target = { ...make("", targetAttrs), tagName: "INPUT", type: "submit", name: "submit_add_player", value: label, form };
  const owner = make("My Team"); owner.href = origin + "/f1/100/2";
  const stats = make("Stats"); stats.href = origin + "/f1/100/2/addplayer?stage=2&apid=33&dpid=22";
  const rows = ["33", "22"].map(id => {
    const player = make("Player", { "data-ys-playerid": id }); player.href = "https://sports.yahoo.com/nfl/players/" + id;
    return { ...make(""), querySelectorAll: () => [player] };
  });
  const document = { querySelectorAll: (selector: string) => selector === "a[href]" ? [owner, stats] : selector === "table tbody tr" ? rows :
    selector === "h1,h2,h3,h4,[role=heading]" ? [make("Claim Player From Waivers")] : [target], body: { innerText: "Week 2 on Wednesday, Sep 16" } };
  const replacements = { document, location: { href: url, origin }, getComputedStyle: () => ({ visibility: "visible" }) };
  const previous = Object.fromEntries(Object.keys(replacements).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  Object.entries(replacements).forEach(([key, value]) => Object.defineProperty(globalThis, key, { value, configurable: true }));
  try {
    atomicOwnedGesture(expected); assert.equal(clicks, 1);
    fields.dpid.value = "11"; assert.throws(() => atomicOwnedGesture(expected), /controls_changed/); fields.dpid.value = "22";
    fields.apid.disabled = true; assert.throws(() => atomicOwnedGesture(expected), /controls_changed/); fields.apid.disabled = false;
    fields.stage.value = "2"; assert.throws(() => atomicOwnedGesture(expected), /controls_changed/); fields.stage.value = "3";
    targetAttrs.formaction = origin + "/f1/100/3/addplayer"; assert.throws(() => atomicOwnedGesture(expected), /controls_changed/); delete targetAttrs.formaction;
    form.method = "get"; assert.throws(() => atomicOwnedGesture(expected), /controls_changed/); form.method = "post";
    assert.equal(clicks, 1);
  } finally { for (const key of Object.keys(replacements)) { if (previous[key]) Object.defineProperty(globalThis, key, previous[key]!); else Reflect.deleteProperty(globalThis, key); } }
});
