import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, access, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { teamReadAppleScript, verifyTeamReads, browserFailureCode } from "./readiness-browser.mjs";
import { readOwnedTeam } from "./readiness-owned-browser.mjs";

// Domain-only observation. No arbitrary browser script, account data, or write operation.
process.umask(0o077);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const privateRoot = join(root, "runtime", "private");
const now = new Date().toISOString();
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safeCodes = new Set(["invalid_team_binding", "emergency_stop", "ambiguous_team_tabs", "wrong_team",
  "unexpected_page", "browser_read_unavailable", "missing_private_config", "team_tab_not_open",
  "browser_script_disabled", "browser_permission_denied", "browser_read_timeout", "invalid_arguments",
  "browser_profile_missing", "browser_profile_unavailable", "unsafe_browser_profile", "browser_profile_busy",
  "browser_auth_required", "browser_rate_limited", "browser_cleanup_failed"]);

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--dedicated-chrome')) throw new Error('invalid_arguments');
  let config;
  try { config = JSON.parse(await readFile(join(privateRoot, "season-2026.json"), "utf8")); }
  catch { throw new Error("missing_private_config"); }
  const league = String(config.leagueId ?? "");
  const team = String(config.teamId ?? "");
  if (!/^\d+$/.test(league) || !/^\d+$/.test(team)) throw new Error("invalid_team_binding");
  try { await access(join(privateRoot, "emergency-stop")); throw new Error("emergency_stop"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const teamPath = `/f1/${league}/${team}`;
  // The dedicated route owns a new page and navigates directly to the team.
  // The legacy Safari diagnostic consumes only existing supported tabs.
  // Neither route enters a login form or modifies the roster.
  let observed;
  if (args[0] === '--dedicated-chrome') {
    observed = await readOwnedTeam(teamPath);
  } else {
    const applescript = teamReadAppleScript(teamPath);
    try { observed = verifyTeamReads(execFileSync("osascript", [], { input: applescript, encoding: "utf8", timeout: 20000, stdio: ["pipe", "pipe", "pipe"] }), teamPath); }
    catch (error) { throw new Error(browserFailureCode(error)); }
  }
  const runningSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0;
  const blockers = [];
  if (!config.draftRankingsSaved) blockers.push("draft_rankings_not_saved");
  if (!config.draftMockVerified) blockers.push("autopick_mock_unverified");
  if (!config.nativeComputerUseVerified) blockers.push("native_computer_use_unverified");
  if (!config.browserProfileIsolationVerified) blockers.push("browser_profile_isolation_unverified");
  if (!config.rosterExecutorVerified) blockers.push("roster_executor_unverified");
  if (dirty || config.releaseSha !== runningSha) blockers.push("reviewed_release_not_bound");
  const result = { schemaVersion: 1, observedAt: now, mode: "read_only", browserRead: "verified",
    ...observed, runningSha, dirty, configurationHash: hash(config), blockers, seasonReady: false,
    note: "This observer cannot authorize or execute a roster transaction." };
  const receipts = join(privateRoot, "readiness");
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  if ((await lstat(receipts)).isSymbolicLink()) throw new Error("unsafe_receipt_path");
  const receiptName = `${now.replaceAll(":", "-")}.json`;
  await writeFile(join(receipts, receiptName), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
main().catch(error => {
  process.stdout.write(JSON.stringify({ observedAt: now, mode: "read_only", seasonReady: false,
    status: "blocked", code: safeCodes.has(error.message) ? error.message : "readiness_check_failed" }) + "\n");
  process.exitCode = 2;
});
