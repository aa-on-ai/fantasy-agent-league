import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { teamReadJavaScript, verifyTeamReads, browserFailureCode } from './readiness-browser.mjs';

const team = '/f1/425299/11';
function read({ owners = [team], pathname = team, origin = 'https://football.fantasysports.yahoo.com' } = {}) {
  return runInNewContext(teamReadJavaScript(team), { URL,
    location: { origin, pathname },
    document: { querySelectorAll: () => owners.map(path => ({ textContent: 'My Team', href: origin + path })) },
  });
}

test('duplicate correct-team pages and prerank are verified individually', () => {
  const report = verifyTeamReads(read() + '\n' + read({ pathname: team + '/prerank' }) + '\n', team);
  assert.equal(report.matchedTabCount, 2);
  assert.equal(report.assignedTeamVerified, true);
});
test('the observed league landing page verifies access without requiring navigation', () => {
  for (const pathname of ['/f1/425299', '/f1/425299/players', '/f1/425299/transactions']) {
    const report = verifyTeamReads(read({ pathname }), team);
    assert.equal(report.currentPath, pathname);
    assert.equal(report.assignedTeamVerified, true);
    assert.throws(() => read({ pathname, owners: ['/f1/425299/1'] }), /wrong_team/);
  }
});
test('read recovery cannot accept other teams, leagues, lookalike paths or action pages', () => {
  for (const pathname of ['/f1/425299/1', '/f1/4252990', '/f1/425300',
    '/f1/425299/addplayer', '/f1/425299/11/edit', '/f1/425299/players-other']) {
    assert.throws(() => read({ pathname }), /unexpected_page/);
  }
});
test('no matching tab is distinct from an unavailable browser', () => {
  assert.throws(() => verifyTeamReads('\n', team), /team_tab_not_open/);
  assert.throws(() => verifyTeamReads('not json', team), /browser_read_unavailable/);
});
test('missing or conflicting ownership and other pages cannot verify', () => {
  for (const owners of [[], ['/f1/425299/1'], [team, '/f1/425299/1']]) {
    assert.throws(() => read({ owners }), /wrong_team/);
  }
  assert.throws(() => read({ pathname: team + '/edit' }), /unexpected_page/);
  assert.throws(() => read({ origin: 'https://example.com' }), /unexpected_page/);
});
test('one valid read cannot mask conflicting or incomplete duplicate evidence', () => {
  for (const patch of [{ teamPath: '/f1/425299/1' }, { assignedTeamVerified: false },
    { scriptReadVerified: false }, { currentPath: team + '/edit' }]) {
    const bad = JSON.stringify({ ...JSON.parse(read()), ...patch });
    assert.throws(() => verifyTeamReads(read() + '\n' + bad, team), /wrong_team/);
  }
});
test('failure codes preserve diagnosis without exposing browser error text', () => {
  for (const [stderr, expected] of [
    ['execution error: Error: wrong_team (-2700)', 'wrong_team'],
    ['execution error: Error: unexpected_page (-2700)', 'unexpected_page'],
    ['Not authorized to send Apple events to Safari. (-1743)', 'browser_permission_denied'],
    ['Enable Allow JavaScript from Apple Events', 'browser_script_disabled'],
    ['arbitrary private page text', 'browser_read_unavailable'],
  ]) assert.equal(browserFailureCode({ stderr }), expected);
  assert.equal(browserFailureCode(new Error('team_tab_not_open')), 'team_tab_not_open');
});

test('host and Apple Event timeouts stay distinct from unknown browser failures', () => {
  assert.equal(browserFailureCode({ code: 'ETIMEDOUT', signal: 'SIGTERM', stderr: '' }), 'browser_read_timeout');
  assert.equal(browserFailureCode({ stderr: 'Safari got an error: AppleEvent timed out. (-1712)' }), 'browser_read_timeout');
  assert.equal(browserFailureCode({ signal: 'SIGTERM', stderr: '' }), 'browser_read_unavailable');
});
