import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOwnedProfile, readOwnedTeam, ownedBrowserFailureCode } from './readiness-owned-browser.mjs';

const team = '/f1/425299/11';
const origin = 'https://football.fantasysports.yahoo.com';
function fixture({ url = origin + team, owned = true, status = 200, failure, launchFailure, cleanupFailure } = {}) {
  const calls = [];
  const page = {
    route: async () => {}, mainFrame: () => ({}),
    goto: async target => { calls.push(['goto', target]); if (failure) throw failure; return { status: () => status }; },
    url: () => url,
    getByRole: () => ({ first: () => ({ waitFor: async () => {} }) }),
    evaluate: async () => ({ currentPath: new URL(url).pathname, origin: new URL(url).origin, assignedTeamVerified: owned }),
  };
  return { calls, options: {
    checkProfile: async () => { calls.push(['checkProfile']); },
    launch: async (path, options) => {
      calls.push(['launch', path, options]);
      if (launchFailure) throw launchFailure;
      return { newPage: async () => { calls.push(['newPage']); return page; },
        close: async () => { calls.push(['close']); if (cleanupFailure) throw cleanupFailure; } };
    },
  } };
}

test('cold start opens the exact team directly and closes only its owned context', async () => {
  const f = fixture();
  const result = await readOwnedTeam(team, f.options);
  assert.equal(result.browserRoute, 'dedicated_chrome');
  assert.equal(result.assignedTeamVerified, true);
  assert.deepEqual(f.calls.filter(c => c[0] === 'goto'), [['goto', origin + team]]);
  assert.equal(f.calls.find(c => c[0] === 'launch')[2].headless, true);
  assert.equal(f.calls.at(-1)[0], 'close');
});

test('login, wrong team, unexpected pages and rate limits never become verified access', async () => {
  for (const [input, error] of [
    [{ url: 'https://login.yahoo.com/' }, 'browser_auth_required'],
    [{ owned: false }, 'wrong_team'],
    [{ url: origin + '/f1/425299/1' }, 'unexpected_page'],
    [{ status: 429 }, 'browser_rate_limited'],
    [{ status: 503 }, 'browser_read_unavailable'],
  ]) {
    const f = fixture(input);
    await assert.rejects(readOwnedTeam(team, f.options), new RegExp(error));
    assert.equal(f.calls.at(-1)[0], 'close');
  }
});

test('timeouts clean up; occupied profiles never close another owner', async () => {
  const timed = fixture({ failure: Object.assign(new Error('private URL'), { name: 'TimeoutError' }) });
  await assert.rejects(readOwnedTeam(team, timed.options), /^Error: browser_read_timeout$/);
  assert.equal(timed.calls.at(-1)[0], 'close');
  const busy = fixture({ launchFailure: new Error('ProcessSingleton private details') });
  await assert.rejects(readOwnedTeam(team, busy.options), /^Error: browser_profile_busy$/);
  assert.equal(busy.calls.some(c => c[0] === 'close'), false);
  assert.equal(ownedBrowserFailureCode(new Error('private URL')), 'browser_read_unavailable');
});

test('invalid identity and failed cleanup cannot report success', async () => {
  const invalid = fixture();
  await assert.rejects(readOwnedTeam('/f1/425299/11/addplayer', invalid.options), /invalid_team_binding/);
  assert.equal(invalid.calls.length, 0);
  const cleanup = fixture({ cleanupFailure: new Error('private details') });
  await assert.rejects(readOwnedTeam(team, cleanup.options), /^Error: browser_cleanup_failed$/);
});

test('profile validation rejects missing, exposed and redirected directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fantasy-profile-test-'));
  try {
    const profile = join(root, 'browser');
    await assert.rejects(assertOwnedProfile(profile), /browser_profile_missing/);
    await mkdir(profile, { mode: 0o700 });
    await assertOwnedProfile(profile);
    await chmod(profile, 0o755);
    await assert.rejects(assertOwnedProfile(profile), /unsafe_browser_profile/);
    await chmod(profile, 0o700);
    await symlink(profile, join(root, 'alias'));
    await assert.rejects(assertOwnedProfile(join(root, 'alias')), /unsafe_browser_profile/);
  } finally { await rm(root, { recursive: true }); }
});
