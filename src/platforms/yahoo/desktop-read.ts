import type { Binding } from "../../manager/season.js";

// Consume a full native accessibility observation, never a diff. This read-only
// boundary deliberately exposes no UI indices, transport or submission method.
export type DesktopRead =
  | { kind: "rankings"; preferred: string[]; excluded: string[] }
  | { kind: "blocked"; code: "pre_draft_roster" | "season_controls_unobserved" };

export function readYahooDesktop(ax: string, binding: Pick<Binding, "leagueId" | "teamId">): DesktopRead {
  const fail = (code: string): never => { throw new Error(code); };
  if (!/^\d+$/.test(binding.leagueId) || !/^\d+$/.test(binding.teamId)) fail("invalid_team_binding");
  // Safari emits scheme-less page URLs in its accessibility tree. Match only
  // the first content document; an ad or another tab is not identity evidence.
  const page = ax.match(/^\s*\d+ HTML content Description: [^\n]+, URL: ([^\n]+)$/m)?.[1];
  if (!page) return fail("full_observation_required");
  const path = `football.fantasysports.yahoo.com/f1/${binding.leagueId}/${binding.teamId}`;
  if (page !== path && page !== `${path}/prerank`) return fail("unexpected_page");
  const ownership = [...ax.matchAll(/^\s*\d+ link My Team, Value: ([^\n]+)$/gm)].map(m => m[1]);
  if (!ownership.length || ownership.some(url => url !== path)) return fail("wrong_team");
  if (page === path) {
    return { kind: "blocked", code: ax.includes("text Your team will include the following roster positions:")
      ? "pre_draft_roster" : "season_controls_unobserved" };
  }
  const start = ax.indexOf("heading Your Rankings, Value: 3");
  const end = ax.indexOf("heading Exclude Ranking, Value: 3");
  const instructions = ax.indexOf("heading Instructions, Value: 2");
  if (start < 0 || end <= start || instructions <= end) return fail("incomplete_rankings");
  const preferred = [...ax.slice(start, end).matchAll(/^\s*\d+ container (\d+)\. ([^\n]+)$/gm)];
  const excluded = [...ax.slice(end, instructions).matchAll(/^\s*\d+ container ([^\n]+)$/gm)].map(m => m[1]!);
  if (!preferred.length || preferred.length > 1000 || excluded.length > 1000 ||
      preferred.some((m, i) => Number(m[1]) !== i + 1)) return fail("incomplete_rankings");
  const names = preferred.map(m => m[2]!);
  const all = [...names, ...excluded].map(name => name.trim().toLowerCase());
  if (all.some(name => !name) || new Set(all).size !== all.length) return fail("ambiguous_rankings");
  return { kind: "rankings", preferred: names, excluded };
}

export function rankingsMatch(read: Extract<DesktopRead, { kind: "rankings" }>, saved: { preferred: string[]; excluded: string[] }): boolean {
  const equal = (a: string[], b: string[]) => a.length === b.length && a.every((name, i) => name.toLowerCase() === b[i]!.toLowerCase());
  return equal(read.preferred, saved.preferred) && equal(read.excluded, saved.excluded);
}
