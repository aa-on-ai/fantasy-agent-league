import type { Page, Route } from "playwright-core";
import { digest } from "../../manager/season.js";
import { dismissOwnedOptionalPrompt } from "./owned-browser.js";
import type { OwnedClaimsEvidence } from "./guarded-owned.js";
import { captureOwnedObservation, normalizeOwnedAssessment, readOwnedPool, readOwnedRoster, readOwnedRules, validateOwnedObservation,
  type OwnedAssessment, type OwnedAssessmentInput, type OwnedBinding, type OwnedObservation } from "./owned-sources.js";

const origin = "https://football.fantasysports.yahoo.com";
export type OwnedAcquisitionPhase = "free_agents" | "waivers";
export interface OwnedAcquisitionCollectionOptions {
  /** Must use the host's actual queue reader. No callback means unknown. */
  collectPendingClaims?: () => Promise<OwnedClaimsEvidence | null>;
  /** Safety bound, not a silently truncated candidate universe. */
  maxDetailPlayers?: number;
  clock?: () => Date;
}
export interface OwnedAcquisitionCollection {
  assessment: OwnedAssessment;
  input: OwnedAssessmentInput;
  pendingClaimsEvidence: OwnedClaimsEvidence | null;
  coverage: { scope: "observed_page_only"; positions: string[]; poolUrls: string[]; playerIds: string[]; paginationFollowed: false };
}

/** Build only the GET query offered by the captured player filter form. */
export function observedOwnedPoolFilter(observation: OwnedObservation, binding: OwnedBinding, phase: OwnedAcquisitionPhase,
  period: string, position: "O" | "K" | "DEF", now = new Date()): string {
  validateOwnedObservation(observation, binding, now);
  const path = `/f1/${binding.leagueId}/players`;
  if (new URL(observation.url).pathname !== path) throw Error("unobserved_pool_filter_page");
  const forms = observation.dom.forms.filter(f => f.method === "get" && new URL(f.action).origin === origin && new URL(f.action).pathname === path && f.controls.some(c => c.name === "status"));
  if (forms.length !== 1) throw Error("unobserved_pool_filter_form");
  const form = forms[0]!;
  const values = { status: phase === "waivers" ? "W" : "FA", stat1: `S_PW_${period}` };
  for (const [name, value] of Object.entries(values)) {
    const controls = form.controls.filter(c => c.name === name && c.tag === "select" && !c.disabled);
    if (controls.length !== 1 || !controls[0]!.options.some(o => o.value === value && !o.disabled)) throw Error("unobserved_pool_filter_option");
  }
  if (form.controls.filter(c => c.name === "pos" && c.type === "radio" && c.value === position && !c.disabled).length !== 1) throw Error("unobserved_pool_position_option");
  const url = new URL(form.action);
  // Query values come from visible offered controls, not inferred Yahoo APIs.
  url.search = "";
  for (const [name, value] of Object.entries({ ...values, pos: position })) url.searchParams.set(name, value);
  return url.href;
}

/** Caller retains the sole browser lease. All navigations use observed controls.
 * Candidate scope is the first observed page for O/K/DEF, never the whole pool.
 * Missing any assessed player's evidence, a changed source page, or unknown
 * queue keeps readiness false. This function cannot submit a roster action.
 */
export async function collectOwnedAcquisitions(page: Page, binding: OwnedBinding, phase: OwnedAcquisitionPhase,
  record: (observation: OwnedObservation) => Promise<void>, checkpoint: () => Promise<void>,
  options: OwnedAcquisitionCollectionOptions = {}): Promise<OwnedAcquisitionCollection> {
  const clock = options.clock ?? (() => new Date()), maxDetails = options.maxDetailPlayers ?? 100;
  if (!Number.isInteger(maxDetails) || maxDetails < 1 || maxDetails > 250) throw Error("invalid_detail_capture_bound");
  const teamPath = `/f1/${binding.leagueId}/${binding.teamId}`, teamUrl = origin + teamPath;
  const gaps: string[] = [], blockedRequests: string[] = [];
  const readOnly = async (route: Route) => {
    const request = route.request();
    if (!["GET", "HEAD"].includes(request.method())) { blockedRequests.push(new URL(request.url()).pathname); await route.abort(); }
    else await route.fallback();
  };
  await page.route(origin + "/**", readOnly);
  try {
    const observe = async () => {
      await checkpoint(); await page.waitForLoadState("load", { timeout: 10000 }); await dismissOwnedOptionalPrompt(page);
      const observation = await captureOwnedObservation(page, binding.profileId, clock);
      validateOwnedObservation(observation, binding, clock()); await record(observation); return observation;
    };
    const navigate = async (url: string) => {
      await checkpoint(); const u = new URL(url);
      const paths = [teamPath, `/f1/${binding.leagueId}/settings`, teamPath + "/settings", `/f1/${binding.leagueId}/players`, teamPath + "/dropplayer", `/f1/${binding.leagueId}/transactions`, teamPath + "/transactions"];
      if (u.origin !== origin || !paths.includes(u.pathname) || u.username || u.password || u.hash) throw Error("unowned_acquisition_source_navigation");
      const response = await page.goto(url, { waitUntil: "load", timeout: 20000 });
      if (!response || response.status() >= 400) throw Error("acquisition_source_navigation_failed");
      return observe();
    };
    const link = (o: OwnedObservation, paths: string[], label: string) => {
      const urls = [...new Set(o.dom.links.filter(l => { const u = new URL(l.href); return u.origin === origin && paths.includes(u.pathname) && (label !== "pool" || l.text.trim() === "Players"); }).map(l => l.href))];
      if (urls.length !== 1) throw Error(`ambiguous_observed_${label}_link`); return urls[0]!;
    };
    const initial = await navigate(teamUrl);
    const rules = await navigate(link(initial, [`/f1/${binding.leagueId}/settings`, teamPath + "/settings"], "rules"));
    const parsedRules = readOwnedRules(rules, binding, clock());
    const roster = await navigate(teamUrl), parsedRoster = readOwnedRoster(roster, parsedRules, binding, clock());
    const phaseBinding = { ...binding, period: parsedRoster.period };
    const input: OwnedAssessmentInput = { roster, rules, pools: [], playerDetails: [] };
    for (const [kind, paths] of [["drops", [teamPath + "/dropplayer"]], ["transactions", [`/f1/${binding.leagueId}/transactions`, teamPath + "/transactions"]]] as const) {
      try { input[kind] = await navigate(link(initial, [...paths], kind)); }
      catch (error) { await checkpoint(); gaps.push(`${kind}_capture_failed:${error instanceof Error ? error.message : "unknown"}`); }
    }
    const groups: Array<{ observation: OwnedObservation; players: Array<{ id: string; name: string; newsLink: string | null }>; kind: "roster" | "pool"; index: number }> = [
      { observation: roster, players: parsedRoster.players, kind: "roster", index: 0 }
    ];
    const positions: string[] = [];
    try {
      const pool = await navigate(link(initial, [`/f1/${binding.leagueId}/players`], "pool"));
      for (const position of ["O", "K", "DEF"] as const) {
        const filtered = await navigate(observedOwnedPoolFilter(pool, phaseBinding, phase, parsedRoster.period, position, clock()));
        const parsed = readOwnedPool(filtered, parsedRules, phaseBinding, clock());
        if (parsed.status !== (phase === "waivers" ? "W" : "FA") || new URL(filtered.url).searchParams.get("pos") !== position) throw Error("pool_filter_did_not_apply");
        const index = input.pools!.length; input.pools!.push(filtered); positions.push(position);
        groups.push({ observation: filtered, players: parsed.players, kind: "pool", index });
      }
    } catch (error) { await checkpoint(); gaps.push(`pool_capture_failed:${error instanceof Error ? error.message : "unknown"}`); }
    const totalPlayers = groups.reduce((n, g) => n + g.players.length, 0);
    if (totalPlayers > maxDetails) gaps.push(`detail_capture_bound_exceeded:${totalPlayers}:${maxDetails}`);
    else for (const group of groups) {
      let current = await navigate(group.observation.url);
      for (const player of group.players) {
        await checkpoint();
        try {
          if (!player.newsLink) throw Error("news_control_unobserved");
          const links = current.dom.links.filter(l => l.attributes["aria-label"] === "Open player notes for " + player.name && l.attributes["data-ys-playerid"] === player.id && l.attributes["data-ys-playernote-view"] === "notes");
          if (links.length !== 1 || links[0]!.href !== player.newsLink) throw Error("ambiguous_player_note_control");
          const control = page.locator(`a[aria-label=${JSON.stringify("Open player notes for " + player.name)}][data-ys-playerid=${JSON.stringify(player.id)}][data-ys-playernote-view="notes"]`);
          if (await control.count() !== 1) throw Error("ambiguous_player_note_control");
          await control.click({ timeout: 7000 });
          const selected = page.locator("a.player-name").filter({ hasText: player.name });
          try { await selected.waitFor({ state: "visible", timeout: 7000 }); }
          catch {
            const failed = await observe();
            if (failed.dom.links.some(l => /(?:^|\s)player-name(?:\s|$)/.test(l.attributes.class ?? ""))) throw Error("wrong_player_card");
            // One hydration repair for the same read-only card, never an action.
            await checkpoint(); await control.click({ timeout: 7000 }); await selected.waitFor({ state: "visible", timeout: 7000 });
          }
          await page.getByRole("heading", { name: "Latest News", exact: true }).waitFor({ state: "visible", timeout: 7000 });
          input.playerDetails!.push({ playerId: player.id, playerName: player.name, observation: await observe() });
        } catch (error) { await checkpoint(); gaps.push(`player_detail_capture_failed:${player.id}:${error instanceof Error ? error.message : "unknown"}`); }
        current = await navigate(group.observation.url);
      }
      // The exact assessed source page must stay stable through card collection.
      const currentPlayers = group.kind === "roster" ? readOwnedRoster(current, parsedRules, phaseBinding, clock()).players : readOwnedPool(current, parsedRules, phaseBinding, clock()).players;
      if (digest(currentPlayers) !== digest(group.players)) gaps.push(`assessed_${group.kind}_changed_during_collection:${group.index}`);
      if (group.kind === "roster") input.roster = current; else input.pools![group.index] = current;
    }
    let pendingClaimsEvidence: OwnedClaimsEvidence | null = null;
    if (options.collectPendingClaims) {
      try { await checkpoint(); pendingClaimsEvidence = await options.collectPendingClaims(); }
      catch (error) { await checkpoint(); gaps.push(`pending_claims_capture_failed:${error instanceof Error ? error.message : "unknown"}`); }
    }
    input.pendingClaimsEvidence = pendingClaimsEvidence;
    const finalRoster = await navigate(teamUrl);
    if (digest(readOwnedRoster(finalRoster, parsedRules, phaseBinding, clock()).players) !== digest(readOwnedRoster(input.roster, parsedRules, phaseBinding, clock()).players)) gaps.push("roster_changed_during_collection");
    input.roster = finalRoster;
    const assessment = normalizeOwnedAssessment(input, phaseBinding, phase, clock());
    if (positions.length !== 3) gaps.push("pool_position_coverage_incomplete");
    if (blockedRequests.length) gaps.push("read_only_collection_request_blocked");
    assessment.gaps = [...new Set([...assessment.gaps, ...gaps])];
    if (gaps.length) assessment.readiness[phase] = false;
    return { assessment, input, pendingClaimsEvidence, coverage: { scope: "observed_page_only", positions,
      poolUrls: (input.pools ?? []).map(o => o.url), playerIds: assessment.snapshot?.available.map(p => p.id) ?? [], paginationFollowed: false } };
  } finally { await page.unroute(origin + "/**", readOnly); }
}
