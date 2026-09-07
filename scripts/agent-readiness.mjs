import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, access, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// Domain-only observation. No arbitrary browser script, account data, or write operation.
process.umask(0o077);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const privateRoot = join(root, "runtime", "private");
const now = new Date().toISOString();
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safeCodes = new Set(["invalid_team_binding", "emergency_stop", "ambiguous_team_tabs", "wrong_team",
  "unexpected_page", "browser_read_unavailable", "missing_private_config"]);

async function main() {
  let config;
  try { config = JSON.parse(await readFile(join(privateRoot, "season-2026.json"), "utf8")); }
  catch { throw new Error("missing_private_config"); }
  const league = String(config.leagueId ?? "");
  const team = String(config.teamId ?? "");
  if (!/^\d+$/.test(league) || !/^\d+$/.test(team)) throw new Error("invalid_team_binding");
  try { await access(join(privateRoot, "emergency-stop")); throw new Error("emergency_stop"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const teamPath = `/f1/${league}/${team}`;
  // Only consume an existing authenticated team tab. Do not open a login form,
  // inspect another site, or navigate away from an unsaved editor.
  const js = `(()=>{
    const expected=${JSON.stringify(teamPath)};
    const allowed=[expected,expected+'/prerank'];
    if(location.origin!=='https://football.fantasysports.yahoo.com'||!allowed.includes(location.pathname))throw Error('unexpected_page');
    const owned=Array.from(document.querySelectorAll('a[href]')).filter(a=>a.textContent.trim()==='My Team').map(a=>new URL(a.href).pathname);
    if(!owned.includes(expected)||owned.some(p=>p!==expected))throw Error('wrong_team');
    return JSON.stringify({teamPath:expected,currentPath:location.pathname,assignedTeamVerified:true,scriptReadVerified:true});
  })()`;
  const applescript = `tell application "Safari"
    set matches to {}
    repeat with w in windows
      repeat with t in tabs of w
        if URL of t is ${JSON.stringify("https://football.fantasysports.yahoo.com" + teamPath)} or URL of t is ${JSON.stringify("https://football.fantasysports.yahoo.com" + teamPath + "/prerank")} then
          set end of matches to t
        end if
      end repeat
    end repeat
    if (count of matches) is not 1 then error "ambiguous_team_tabs"
    return do JavaScript ${JSON.stringify(js)} in item 1 of matches
  end tell`;
  let observed;
  try { observed = JSON.parse(execFileSync("osascript", [], { input: applescript, encoding: "utf8", timeout: 20000, stdio: ["pipe", "pipe", "pipe"] })); }
  catch { throw new Error("browser_read_unavailable"); }
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
