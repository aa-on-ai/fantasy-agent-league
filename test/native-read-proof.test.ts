import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateNativeRead, readStop, verifyNativeTeamCapture, nativeDocumentUrl } from "../src/runtime/native-read-proof.js";
const capture = `0 standard window Team
  4 HTML content Description: Team, URL: football.fantasysports.yahoo.com/f1/100/2
  24 link My Team, Value: football.fantasysports.yahoo.com/f1/100/2
  59 text Sample Agent`;
const binding = { leagueId: '100', teamId: '2', teamName: 'Sample Agent' };
test('elided native document uses only a unique external address field and rejects conflicts', () => {
  const bar = '\n 5 text field (settable) Description: smart search field, Value: https://football.fantasysports.yahoo.com/f1/100/2, ID: WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD';
  const elided = capture.replace('URL: football.fantasysports.yahoo.com/f1/100/2', 'URL: …');
  assert.equal(nativeDocumentUrl(elided + bar), 'football.fantasysports.yahoo.com/f1/100/2');
  assert.ok(verifyNativeTeamCapture(elided + bar, binding));
  assert.equal(nativeDocumentUrl(elided), null);
  assert.equal(nativeDocumentUrl(elided + bar + bar), null);
  assert.equal(nativeDocumentUrl(elided + bar.replace('\n ', '\n    ')), null);
  assert.equal(nativeDocumentUrl(capture + bar.replace('/100/2', '/100/3')), null);
  assert.equal(nativeDocumentUrl(elided + bar.replace('https:', 'http:')), null);
  assert.equal(nativeDocumentUrl(elided + bar.replace('https://', 'https://user@')), null);
  assert.equal(nativeDocumentUrl(elided + bar + '\n99 standard window Other'), null);
});
const now = new Date("2026-09-08T17:00:00Z");
const input = { binding, runId: "test-only", startedAt: "2026-09-08T16:48:00Z", capturedAt: now.toISOString(),
  tool: "mcp__cua_repl", profile: "existing authenticated Safari session", capture };
test("native proof requires assigned primary document and consistent ownership", () => {
  assert.ok(verifyNativeTeamCapture(capture, binding));
  assert.ok(!verifyNativeTeamCapture(capture.replace('/100/2', '/100/3'), binding));
  assert.ok(!verifyNativeTeamCapture(capture + '\n  70 link My Team, Value: football.fantasysports.yahoo.com/f1/100/3', binding));
  assert.ok(!verifyNativeTeamCapture(capture.replace('4 HTML', '+4 HTML'), binding));
});
test("test-scoped stop blocks capture and failure remains a failed proof", async () => {
  const root = await mkdtemp(join(tmpdir(), 'fantasy-native-proof-'));
  const stop = join(root, 'stop');
  try {
    await writeFile(stop, 'test only');
    let captures = 0;
    if (await readStop(stop) === 'clear') captures++;
    assert.equal(captures, 0);
    await symlink(join(root,'missing-target'),join(root,'dangling-stop'));
    assert.equal(await readStop(join(root,'dangling-stop')),'stopped');
    assert.equal(await readStop(join(stop,'child')),'unknown');
    assert.equal((await evaluateNativeRead(input, stop, now)).status, 'fail');
    assert.equal((await evaluateNativeRead(input, join(root,'absent'), now)).status, 'pass');
    assert.equal((await evaluateNativeRead({...input,capture:''},join(root,'absent'),now)).code, 'identity_or_capture_failed');
    assert.equal((await evaluateNativeRead({...input,capturedAt:'2026-09-08T16:50:00Z'},join(root,'absent'),now)).status,'fail');
    assert.equal((await evaluateNativeRead({...input,tool:'scripted-browser'},join(root,'absent'),now)).code,'wrong_route');
  } finally { await rm(root,{recursive:true,force:true}); }
});
