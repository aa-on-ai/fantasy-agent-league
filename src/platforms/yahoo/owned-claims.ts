import { digest } from "../../manager/season.js";
import { readOwnedRoster, readOwnedPendingClaims, validateOwnedObservation, type OwnedObservation, type OwnedRules, type OwnedBinding } from "./owned-sources.js";
import type { OwnedClaimsEvidence } from "./guarded-owned.js";
import type { Page, Request } from "playwright-core";
import { randomUUID } from "node:crypto";
import { captureOwnedObservation } from "./owned-sources.js";
import { dismissOwnedOptionalPrompt } from "./owned-browser.js";

const origin = "https://football.fantasysports.yahoo.com";
export interface OwnedClaimPage {
  observation: OwnedObservation;
  document: { id: string; url: string; status: number; method: string; outstanding: number;
    failed: Array<{ path: string; method: string; resourceType: string }> };
}
function completeNavigation(page: OwnedClaimPage): boolean {
  return !!page.document.id && page.document.url === page.observation.url && page.document.status === 200 &&
    page.document.method === "GET" && page.document.outstanding === 0 && page.document.failed.length === 0;
}
function completeMyTeam(observation: OwnedObservation, rules: OwnedRules, binding: OwnedBinding, now: Date): boolean {
  validateOwnedObservation(observation, binding, now);
  const u = new URL(observation.url);
  if (u.origin !== origin || u.pathname !== `/f1/${binding.leagueId}/${binding.teamId}` || u.search || u.hash ||
      observation.dom.readyState !== "complete" || observation.dom.claimMarkerCount !== 0 || !binding.period) return false;
  const roster = readOwnedRoster(observation, rules, binding, now);
  if (roster.gaps.length || roster.period !== binding.period || roster.players.length !== rules.rosterLimit) return false;
  const hasLink = (text: string, path: string) => observation.dom.links.some(l => l.text.trim() === text && l.href === origin + path);
  if (!hasLink("Add Player", `/f1/${binding.leagueId}/players`) || !hasLink("Drop Player", `/f1/${binding.leagueId}/${binding.teamId}/dropplayer`) ||
      !["Legends and Glossaries", "The Fine Print"].every(h => observation.dom.headings.includes(h)) ||
      !/All game times are shown in (?:EDT|EST)\./.test(observation.dom.text)) return false;
  if (/\b(?:pending|claims?|loading|unable to load|something went wrong|temporarily unavailable|Edit Waiver Priority)\b/i.test(observation.dom.text)) return false;
  const records = [...observation.dom.links, ...observation.dom.controls, ...observation.dom.tables, ...observation.dom.tables.flatMap(t => t.rows)];
  if (records.some(r => /(?:\bClaim\b|\bDraggable\b|pending|editwaiver|cancelwaiver|[?&](?:waid|claimid)=)/i.test(JSON.stringify(r)))) return false;
  return true;
}

/**
 * Yahoo's My Team screen lists existing claims above the roster, but does not
 * render an explicit empty panel in the observed template. Two complete bound
 * views are required for this observed-zero contract. Missing headings alone,
 * partial pages, claim signals and unrecognized populated shapes remain unknown.
 * This does not claim an explicit Yahoo "no claims" message was displayed.
 */
export function observeEmptyOwnedClaims(currentPage: OwnedClaimPage, previousPage: OwnedClaimPage, rules: OwnedRules,
  binding: OwnedBinding, now = new Date()): OwnedClaimsEvidence | null {
  try {
    const current = currentPage.observation, previous = previousPage.observation;
    if (!completeNavigation(currentPage) || !completeNavigation(previousPage) || currentPage.document.id === previousPage.document.id) return null;
    if (current.observationId === previous.observationId || Date.parse(current.capturedAt) <= Date.parse(previous.capturedAt) ||
        !completeMyTeam(current, rules, binding, now) || !completeMyTeam(previous, rules, binding, now)) return null;
    const roster = (o: OwnedObservation) => readOwnedRoster(o, rules, binding, now).players.map(p => ({ id: p.id, slot: p.slot })).sort((a, b) => a.id.localeCompare(b.id));
    if (digest(roster(current)) !== digest(roster(previous))) return null;
    return { observation: current, sourceHash: digest(current), normalized: true, claims: [], interpretation: "observed_empty",
      supportingDocumentIds: [previousPage.document.id, currentPage.document.id] };
  } catch { return null; }
}

/** Parent owns the browser lease. Capture fresh GET documents, including failed
 * or aborted same-origin XHRs that could otherwise conceal an unloaded queue. */
export async function captureOwnedClaimPage(page: Page, binding: OwnedBinding, record: (value: OwnedObservation) => Promise<void>,
  checkpoint: () => Promise<void>): Promise<OwnedClaimPage> {
  const active = new Set<Request>(), failed: OwnedClaimPage["document"]["failed"] = [];
  const sameOrigin = (r: Request) => new URL(r.url()).origin === origin;
  const metadata = (r: Request) => ({ path: new URL(r.url()).pathname, method: r.method(), resourceType: r.resourceType() });
  const started = (r: Request) => { if (sameOrigin(r)) active.add(r); };
  const finished = (r: Request) => { active.delete(r); };
  const failure = (r: Request) => { active.delete(r); if (sameOrigin(r)) failed.push(metadata(r)); };
  const responseError = (r: import("playwright-core").Response) => { if (r.status() >= 400 && sameOrigin(r.request())) failed.push(metadata(r.request())); };
  page.on("request", started); page.on("requestfinished", finished); page.on("requestfailed", failure); page.on("response", responseError);
  try {
    await checkpoint();
    const response = await page.goto(`${origin}/f1/${binding.leagueId}/${binding.teamId}`, { waitUntil: "load", timeout: 20000 });
    await dismissOwnedOptionalPrompt(page); await checkpoint();
    // A same-origin request may finish just after the document's load event.
    // Wait on those request events, not an arbitrary sleep or an empty DOM.
    if (active.size) await new Promise<void>(resolve => {
      const cleanup = () => { clearTimeout(timer); page.off("requestfinished", check); page.off("requestfailed", check); };
      const check = () => { if (!active.size) { cleanup(); resolve(); } };
      const timer = setTimeout(() => { cleanup(); resolve(); }, 5000);
      page.on("requestfinished", check); page.on("requestfailed", check); check();
    });
    const observation = await captureOwnedObservation(page, binding.profileId);
    validateOwnedObservation(observation, binding); await record(observation);
    return { observation, document: { id: randomUUID(), url: response?.url() ?? "", status: response?.status() ?? 0,
      method: response?.request().method() ?? "", outstanding: active.size, failed } };
  } finally {
    page.off("request", started); page.off("requestfinished", finished); page.off("requestfailed", failure); page.off("response", responseError);
  }
}

/** Owner-bound populated queue backed by every observed claim's detail GET.
 * The caller cannot supply a priority number as a substitute for claim_id. */
export function observePopulatedOwnedClaims(current: OwnedClaimPage, details: readonly OwnedObservation[], rules: OwnedRules,
  binding: OwnedBinding, now = new Date()): OwnedClaimsEvidence | null {
  try {
    if (!completeNavigation(current) || !binding.period || current.observation.dom.readyState !== "complete") return null;
    const roster = readOwnedRoster(current.observation, rules, binding, now);
    if (roster.gaps.length || roster.players.length !== rules.rosterLimit) return null;
    const parsed = readOwnedPendingClaims(current.observation, binding, `${origin}/f1/${binding.leagueId}/${binding.teamId}`, now, details);
    if (parsed.status !== "observed" || !parsed.claims.length || parsed.claims.some(c => c.dropId === null)) return null;
    return { observation: current.observation, sourceHash: digest(current.observation), normalized: true, interpretation: "observed_claims",
      supportingDocumentIds: [current.document.id, ...details.map(d => d.observationId)],
      claims: parsed.claims.map(c => ({ id: c.id, leagueId: binding.leagueId, teamId: binding.teamId, period: binding.period!, addId: c.addId, dropId: c.dropId! })) };
  } catch { return null; }
}

/** Read only. Follows observed detail links and returns to a fresh My Team page.
 * Every claim must be recognized; any extra/unknown transaction keeps it null. */
export async function collectOwnedClaims(page: Page, binding: OwnedBinding, rules: OwnedRules,
  record: (value: OwnedObservation) => Promise<void>, checkpoint: () => Promise<void>): Promise<OwnedClaimsEvidence | null> {
  const first = await captureOwnedClaimPage(page, binding, record, checkpoint);
  const links = first.observation.dom.links.filter(l => new URL(l.href).pathname === `/f1/${binding.leagueId}/${binding.teamId}/viewwaiver`);
  if (!links.length) return observeEmptyOwnedClaims(await captureOwnedClaimPage(page, binding, record, checkpoint), first, rules, binding);
  const details: OwnedObservation[] = [];
  for (const link of links) {
    const u = new URL(link.href);
    if (u.origin !== origin || u.searchParams.getAll("claim_id").length !== 1 || !/^\d+_\d+_\d+$/.test(u.searchParams.get("claim_id") ?? "")) return null;
    await checkpoint();
    const response = await page.goto(u.href, {waitUntil:"load",timeout:20000});
    if (response?.status() !== 200 || response.request().method() !== "GET") return null;
    await dismissOwnedOptionalPrompt(page); await checkpoint();
    const detail = await captureOwnedObservation(page,binding.profileId);validateOwnedObservation(detail,binding);await record(detail);details.push(detail);
  }
  const current = await captureOwnedClaimPage(page,binding,record,checkpoint);
  return observePopulatedOwnedClaims(current,details,rules,binding);
}
