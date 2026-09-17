// Access observation only. No navigation, page mutation, or account/session reads.
export function supportedReadPaths(teamPath) {
  if (!/^\/f1\/\d+\/\d+$/.test(teamPath)) throw new Error("invalid_team_binding");
  const leaguePath = teamPath.slice(0, teamPath.lastIndexOf('/'));
  return [teamPath, teamPath + '/prerank', leaguePath, leaguePath + '/players', leaguePath + '/transactions'];
}

export function teamReadJavaScript(teamPath) {
  const allowed = supportedReadPaths(teamPath);
  return `(()=>{
    const expected=${JSON.stringify(teamPath)};
    const allowed=${JSON.stringify(allowed)};
    if(location.origin!=='https://football.fantasysports.yahoo.com'||!allowed.includes(location.pathname))throw Error('unexpected_page');
    const owned=Array.from(document.querySelectorAll('a[href]')).filter(a=>a.textContent.trim()==='My Team').map(a=>new URL(a.href).pathname);
    if(!owned.includes(expected)||owned.some(p=>p!==expected))throw Error('wrong_team');
    return JSON.stringify({teamPath:expected,currentPath:location.pathname,assignedTeamVerified:true,scriptReadVerified:true});
  })()`;
}

export function teamReadAppleScript(teamPath) {
  const js = teamReadJavaScript(teamPath);
  const urls = supportedReadPaths(teamPath).map(path => JSON.stringify('https://football.fantasysports.yahoo.com' + path)).join(', ');
  return `tell application "Safari"
    set observations to ""
    set supportedURLs to {${urls}}
    repeat with w in windows
      repeat with t in tabs of w
        set tabURL to URL of t
        set supportedPage to false
        repeat with candidate in supportedURLs
          set baseURL to candidate as text
          if tabURL is baseURL or tabURL starts with (baseURL & "?") or tabURL starts with (baseURL & "#") then
            set supportedPage to true
            exit repeat
          end if
        end repeat
        if supportedPage then
          set observation to do JavaScript ${JSON.stringify(js)} in t
          set observations to observations & observation & linefeed
        end if
      end repeat
    end repeat
    return observations
  end tell`;
}

export function verifyTeamReads(output, teamPath) {
  const allowed = supportedReadPaths(teamPath);
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error("team_tab_not_open");
  let observations;
  try { observations = lines.map(line => JSON.parse(line)); }
  catch { throw new Error("browser_read_unavailable"); }
  // Every matched tab must independently prove the same assigned team. A good
  // tab cannot mask a conflicting identity or a failed read in another tab.
  if (observations.some(o => !o || o.teamPath !== teamPath ||
      !allowed.includes(o.currentPath) ||
      o.assignedTeamVerified !== true || o.scriptReadVerified !== true)) {
    throw new Error("wrong_team");
  }
  return { ...observations[0], matchedTabCount: observations.length };
}

export function browserFailureCode(error) {
  if (["team_tab_not_open", "wrong_team", "unexpected_page"].includes(error.message)) return error.message;
  const detail = String(error.stderr ?? "");
  if (error.code === "ETIMEDOUT" || /\(-1712\)/.test(detail)) return "browser_read_timeout";
  if (/Error: wrong_team\b/.test(detail)) return "wrong_team";
  if (/Error: unexpected_page\b/.test(detail)) return "unexpected_page";
  if (/Allow JavaScript from Apple Events/i.test(detail)) return "browser_script_disabled";
  if (/\(-1743\)/.test(detail)) return "browser_permission_denied";
  return "browser_read_unavailable";
}
