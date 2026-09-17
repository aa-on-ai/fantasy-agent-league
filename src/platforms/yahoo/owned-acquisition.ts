import type { OwnedRules, OwnedPoolPlayer } from "./owned-sources.js";

/** Conservative submission cutoff, not a promised Yahoo processing time.
 * Yahoo documents Game Time-Tuesday waivers ending after 11:59pm Pacific.
 * Require the live candidate's Wednesday date and a future game. Unknown or
 * different waiver schedules do not receive a guessed deadline.
 */
export function ownedAcquisitionDeadline(player: OwnedPoolPlayer, rules: OwnedRules, season: number, now: Date): string | null {
  const kickoff = Date.parse(player.kickoff ?? "");
  if (!player.addControlObserved || !Number.isFinite(kickoff) || kickoff <= now.getTime()) return null;
  if (player.availability === "free_agent") return player.kickoff;
  if (player.availability !== "waivers" || rules.weeklyWaivers !== "Game Time - Tuesday" || rules.waiverType !== "rolling") return null;
  const match = player.waiverDateText?.match(/^([A-Z][a-z]{2}) (\d{1,2})$/);
  const month = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ").indexOf(match?.[1] ?? "");
  if (!match || month < 0 || !Number.isInteger(season)) return null;
  const day = Number(match[2]), date = new Date(Date.UTC(season, month, day));
  if (date.getUTCMonth() !== month || date.getUTCDate() !== day || date.getUTCDay() !== 3) return null;
  const fmt = new Intl.DateTimeFormat("en-US", {timeZone: "America/Los_Angeles", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hourCycle: "h23"});
  for (const offset of [7, 8]) {
    const candidate = new Date(date.getTime() + offset * 3600000);
    const parts = Object.fromEntries(fmt.formatToParts(candidate).map(p => [p.type, p.value]));
    if (Number(parts.year) !== season || Number(parts.month) !== month + 1 || Number(parts.day) !== day || Number(parts.hour) !== 0) continue;
    // One minute before the documented midnight boundary, with an additional
    // short-lived host action window. Never reuse the pool's displayed date as
    // if it were an observed exact Yahoo server cutoff.
    const cutoff = Math.min(candidate.getTime() - 60000, kickoff);
    return cutoff > now.getTime() && cutoff - now.getTime() < 7 * 86400000 ? new Date(cutoff).toISOString() : null;
  }
  return null;
}
