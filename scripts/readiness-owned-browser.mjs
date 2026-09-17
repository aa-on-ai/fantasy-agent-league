import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const origin = 'https://football.fantasysports.yahoo.com';
const profile = join(homedir(), '.local/share/fantasy-agent-league/2026/agent-1/browser');

// Use only the existing dedicated profile. Never create it, copy authentication,
// attach to an existing process, or inspect personal browser data.
export async function assertOwnedProfile(path = profile) {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('browser_profile_missing');
    throw new Error('browser_profile_unavailable');
  }
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      await realpath(path) !== resolve(path)) throw new Error('unsafe_browser_profile');
}

export function ownedBrowserFailureCode(error) {
  const known = new Set(['invalid_team_binding', 'browser_profile_missing', 'browser_profile_unavailable',
    'unsafe_browser_profile', 'browser_auth_required', 'browser_rate_limited', 'wrong_team', 'unexpected_page']);
  if (known.has(error.message)) return error.message;
  if (/ProcessSingleton|profile.*in use|SingletonLock/i.test(String(error.message))) return 'browser_profile_busy';
  if (error.name === 'TimeoutError' || error.code === 'ETIMEDOUT') return 'browser_read_timeout';
  return 'browser_read_unavailable';
}

export async function readOwnedTeam(teamPath, {
  launch = (path, options) => chromium.launchPersistentContext(path, options),
  checkProfile = assertOwnedProfile,
} = {}) {
  if (!/^\/f1\/\d+\/\d+$/.test(teamPath)) throw new Error('invalid_team_binding');
  let context;
  try {
    await checkProfile();
    // Chrome's own profile lock rejects concurrent owners. Never remove a lock
    // or kill a pre-existing browser to make this read succeed.
    context = await launch(profile, { channel: 'chrome', headless: true,
      chromiumSandbox: true, acceptDownloads: false, serviceWorkers: 'block', timeout: 10000 });
    const page = await context.newPage();
    await page.route('**/*', route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        const host = new URL(request.url()).hostname;
        if (!['football.fantasysports.yahoo.com', 'login.yahoo.com'].includes(host)) return route.abort();
      }
      return route.continue();
    });
    const response = await page.goto(origin + teamPath, { waitUntil: 'domcontentloaded', timeout: 10000 });
    const url = new URL(page.url());
    if (url.hostname === 'login.yahoo.com' || [401, 403].includes(response?.status())) throw new Error('browser_auth_required');
    if (response?.status() === 429) throw new Error('browser_rate_limited');
    if (response && response.status() >= 400) throw new Error('browser_read_unavailable');
    if (url.origin !== origin || url.pathname !== teamPath) throw new Error('unexpected_page');
    await page.getByRole('link', { name: 'My Team', exact: true }).first().waitFor({ state: 'attached', timeout: 5000 });
    const observed = await page.evaluate(expected => {
      const owned = Array.from(document.querySelectorAll('a[href]'))
        .filter(a => a.textContent.trim() === 'My Team').map(a => new URL(a.href).pathname);
      return { currentPath: location.pathname, origin: location.origin,
        assignedTeamVerified: owned.includes(expected) && owned.every(path => path === expected) };
    }, teamPath);
    if (observed.origin !== origin || observed.currentPath !== teamPath) throw new Error('unexpected_page');
    if (!observed.assignedTeamVerified) throw new Error('wrong_team');
    return { teamPath, currentPath: observed.currentPath, assignedTeamVerified: true,
      scriptReadVerified: true, matchedTabCount: 1, browserRoute: 'dedicated_chrome' };
  } catch (error) {
    throw new Error(ownedBrowserFailureCode(error));
  } finally {
    // Only a context successfully launched by this invocation is closed.
    // Restored/shared tabs are never selected, read, or individually discarded.
    if (context) {
      try { await context.close(); }
      catch { throw new Error('browser_cleanup_failed'); }
    }
  }
}
