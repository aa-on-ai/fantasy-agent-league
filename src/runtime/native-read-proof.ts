import { lstat } from "node:fs/promises";
import { digest } from "../manager/season.js";

export async function readStop(path: string): Promise<"clear" | "stopped" | "unknown"> {
  try { await lstat(path); return "stopped"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "clear" : "unknown"; }
}
export interface NativeTeamBinding { leagueId: string; teamId: string; teamName: string }
// Safari may elide its document URL. Its unique native address field is an
// independent source in the same capture; never rewrite the captured document.
export function nativeDocumentUrl(ax: string): string | null {
  const primary = ax.match(/^([ \t]*)\d+ HTML content[^\n]*, URL: ([^\n]+)$/m);
  if (!primary) return null;
  const addresses = [...ax.matchAll(/^([ \t]*)\d+ text field[^\n]*Description: smart search field, Value: ([^\n]+), ID: WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD$/gm)];
  const depth = (s: string) => s.replaceAll("\t", "    ").length;
  if (addresses.length > 1) return null;
  const address = addresses[0];
  if (address && depth(address[1]!) >= depth(primary[1]!)) return null;
  const valid = (url: string) => {
    try { const u = new URL(url); return u.protocol === "https:" && u.hostname === "football.fantasysports.yahoo.com" &&
      !u.username && !u.password && !u.port && !url.includes("…") ? url.slice(8) : null; } catch { return null; }
  };
  const bar = address ? valid(address[2]!) : null;
  if (address && !bar) return null;
  if (primary[2] === "…") return [...ax.matchAll(/^\d+ standard window /gm)].length === 1 ? bar : null;
  const document = valid("https://" + primary[2]);
  return document && (!bar || bar === document) ? document : null;
}
export function verifyNativeTeamCapture(ax: string, binding: NativeTeamBinding): boolean {
  if (!binding || !/^\d+$/.test(binding.leagueId) || !/^\d+$/.test(binding.teamId) || !binding.teamName?.trim()) return false;
  const expected = `football.fantasysports.yahoo.com/f1/${binding.leagueId}/${binding.teamId}`;
  const page = nativeDocumentUrl(ax);
  const links = [...ax.matchAll(/^\s*\d+ link My Team, Value: ([^\n]+)$/gm)].map(m => m[1]);
  return page === expected && links.length > 0 && links.every(link => link === expected) &&
    [...ax.matchAll(/^\s*\d+ text ([^\n]+)$/gm)].some(m => m[1] === binding.teamName || m[1]!.startsWith(binding.teamName + " "));
}
export interface NativeProofInput {
  runId: string;
  binding: NativeTeamBinding;
  startedAt: string;
  capturedAt: string;
  tool: string;
  profile: string;
  capture: string;
}
// This validates evidence, not its provenance. The owner must independently
// inspect the scheduled task's actual native tool output and scheduler history.
export async function evaluateNativeRead(input: NativeProofInput, stopFile: string, now = new Date()) {
  const stopState = await readStop(stopFile);
  const start = Date.parse(input.startedAt), capture = Date.parse(input.capturedAt), end = now.getTime();
  const code = stopState !== "clear" ? "emergency_stop_or_unreadable" :
    !input.runId.trim() || !Number.isFinite(start) || !Number.isFinite(capture) || !Number.isFinite(end) ||
      start > capture || capture > end || end - capture > 60_000 ? "invalid_run_or_stale_capture" :
    input.tool !== "mcp__cua_repl" || input.profile !== "existing authenticated Safari session" ? "wrong_route" :
    !verifyNativeTeamCapture(input.capture, input.binding) ? "identity_or_capture_failed" : "native_read_verified";
  return { schemaVersion: 1, runId: input.runId, startedAt: input.startedAt, capturedAt: input.capturedAt,
    endedAt: now.toISOString(), tool: input.tool, profile: input.profile, stopState,
    leagueId: input.binding.leagueId, teamId: input.binding.teamId, teamName: input.binding.teamName,
    identityVerified: code === "native_read_verified",
    captureHash: digest(input.capture), sourceCapture: input.capture,
    status: code === "native_read_verified" ? "pass" : "fail", code,
    proofScope: "scheduled_native_read_only", rosterActionsEnabled: false };
}
