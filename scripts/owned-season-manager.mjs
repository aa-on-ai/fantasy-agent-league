import { readFile, writeFile, realpath, mkdir, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// No implicit execution, generated approval, config changes or scheduler enrollment.
// This host supports only the separately reviewed atomic two-player lineup release.
process.umask(0o077);
const root = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const privateRoot = join(root, 'runtime/private');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
const protectedPaths = ['src', 'scripts', 'agents', 'package.json', 'package-lock.json', 'tsconfig.json'];
const sha256 = text => createHash('sha256').update(text).digest('hex');
let submissionMayHaveOccurred = false;
async function privateFile(path, directory) {
  const candidate = resolve(root, path), base = join(privateRoot, directory);
  if (!candidate.startsWith(base + '/') || (await lstat(candidate)).isSymbolicLink() || await realpath(candidate) !== candidate)
    throw Error('unsafe_owned_release_path');
  return candidate;
}
async function sourceIdentity() {
  const paths = git(['ls-files', '-z', '--', ...protectedPaths]).split('\0').filter(Boolean).sort();
  const contents = [];
  for (const path of paths) contents.push([path, sha256(await readFile(join(root, path)))]);
  return { repositoryRoot: root, runningSha: git(['rev-parse', 'HEAD']), sourceHash: sha256(JSON.stringify(contents)),
    sourceClean: !git(['diff', 'HEAD', '--', ...protectedPaths]) && !git(['ls-files', '--others', '--exclude-standard', '--', ...protectedPaths]),
    seasonConfig: JSON.parse(await readFile(join(privateRoot, 'season-2026.json'), 'utf8')) };
}

async function main() {
  const [mode, manifestArgument, eventArgument, extra] = process.argv.slice(2);
  if (!['inspect', 'execute'].includes(mode) || !manifestArgument || extra || (mode === 'execute') !== !!eventArgument)
    throw Error('explicit_lineup_release_and_mode_required');
  const manifestPath = await privateFile(manifestArgument, 'owned-releases');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const initialEnvironment = await sourceIdentity();
  if (manifest.releaseSha !== initialEnvironment.runningSha || !initialEnvironment.sourceClean) throw Error('lineup_release_not_pinned');
  // dist is ignored by git; rebuild from the pinned source before importing any runtime.
  execFileSync('npm', ['run', 'build', '--silent'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const [{ inspectOwnedLineupRelease, authorizeOwnedLineupRelease, assertOwnedLineupAuthorization, withOwnedManagerLease },
    { digest }, { readStop }] = await Promise.all([
    import('../dist/src/runtime/owned-lineup-release.js'), import('../dist/src/manager/season.js'), import('../dist/src/runtime/native-read-proof.js')]);
  const evidencePath = await privateFile(manifest.evidence.path, 'owned-release-evidence');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  const inspection = inspectOwnedLineupRelease(manifest, await sourceIdentity(), evidence);
  if (mode === 'inspect') {
    console.log(JSON.stringify({ status: 'inspected_not_activated', ...inspection, browserOpened: false, actorInvoked: false, submissions: 0 }));
    return;
  }
  const authorization = authorizeOwnedLineupRelease(manifest, await sourceIdentity(), evidence);
  const specPath = await privateFile(eventArgument, 'owned-schedule-specs');
  const spec = JSON.parse(await readFile(specPath, 'utf8')), event = spec.event;
  if (spec.schemaVersion !== 1 || spec.mode !== 'execute' || spec.releaseManifestHash !== inspection.manifestHash ||
      spec.leagueId !== '425299' || spec.teamId !== '11' || event?.phase !== 'lineup' || !event.id ||
      !Number.isFinite(Date.parse(event.opensAt)) || !Number.isFinite(Date.parse(event.closesAt)) ||
      Date.parse(event.opensAt) >= Date.parse(event.closesAt) || Date.parse(event.closesAt) - Date.parse(event.opensAt) > 15 * 60000 ||
      Date.parse(event.opensAt) < Date.parse(manifest.opensAt) || Date.parse(event.closesAt) > Date.parse(manifest.expiresAt)) throw Error('invalid_lineup_release_occurrence');
  const emergencyStopPath = join(privateRoot, 'emergency-stop');
  const checkpoint = async () => {
    if (await readStop(emergencyStopPath) !== 'clear') throw Error('emergency_stop');
    if (Date.now() < Date.parse(event.opensAt) || Date.now() >= Date.parse(event.closesAt)) throw Error('owned_task_window_closed');
    if (digest(JSON.parse(await readFile(manifestPath, 'utf8'))) !== inspection.manifestHash ||
        digest(JSON.parse(await readFile(evidencePath, 'utf8'))) !== inspection.evidenceHash) throw Error('lineup_release_changed');
    const current = inspectOwnedLineupRelease(manifest, await sourceIdentity(), evidence);
    if (current.activationBlockers.length) throw Error(current.activationBlockers[0]);
  };
  await checkpoint();
  const [{ withOwnedBrowser, OWNED_BROWSER_PROFILE, YahooOwnedDriver }, { collectOwnedLineup }, { normalizeOwnedAssessment },
    { runOwnedSeasonTask }, { createOpenClawManagerDecide }, { FileLedger }] = await Promise.all([
    import('../dist/src/platforms/yahoo/owned-browser.js'), import('../dist/src/platforms/yahoo/owned-collector.js'),
    import('../dist/src/platforms/yahoo/owned-sources.js'), import('../dist/src/runtime/owned-season-task.js'),
    import('../dist/src/runtime/openclaw-manager.js'), import('../dist/src/execution/file-ledger.js')]);
  const directory = join(privateRoot, 'owned-operational-runs', digest(event));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw Error('unsafe_owned_release_path');
  const binding = { ...manifest.scope, maxAgeMs: 900000 };
  const counts = { collections: 0, decisions: 0, submissions: 0 };
  const browserLedger = new FileLedger(join(privateRoot, 'browser-ledger'));
  const actionLedger = new FileLedger(join(privateRoot, 'action-ledger'));
  const decide = createOpenClawManagerDecide({ directory: join(privateRoot, 'openclaw-manager-runs'), emergencyStopPath });
  const lineupRelease = { authorization, releaseSha: manifest.releaseSha, runningSha: manifest.releaseSha };
  let rules;
  const record = async observation => {
    await writeFile(join(directory, observation.observationId + '.json'), JSON.stringify(observation) + '\n', { flag: 'wx', mode: 0o600 });
    if (new URL(observation.url).pathname === '/f1/425299/settings') rules = observation;
  };
  const receipt = await withOwnedManagerLease(browserLedger, binding.profileId,
    run => withOwnedBrowser({ profilePath: OWNED_BROWSER_PROFILE }, run), async (page, borrowed) => {
      let dispatchOpen = false;
      await page.route('**/*', route => {
        const request = route.request();
        if (new URL(request.url()).origin === 'https://football.fantasysports.yahoo.com' && !['GET', 'HEAD'].includes(request.method()) && !dispatchOpen)
          return route.abort();
        return route.fallback();
      });
      const driver = new YahooOwnedDriver(page, { binding, profileId: binding.profileId, emergencyStopPath, allowSubmission: true,
        lineupRelease, atomicSwapEvidence: relative(root, evidencePath), atomicAcquisitionEvidence: null, swapSelection: inspection.swapSelection,
        record, normalize: async observation => {
          await checkpoint();
          if (!rules) throw Error('lineup_rules_unobserved');
          const current = normalizeOwnedAssessment({ roster: observation, rules }, binding, 'lineup');
          if (!current.snapshot) throw Error('owned_sources_incomplete');
          return { observation, snapshot: current.snapshot, lineupDeadlines: current.lineupDeadlines, acquisitionDeadlines: {}, pendingClaims: null };
        } });
      const transport = {
        read: async () => { await checkpoint(); return driver.read(); },
        prepare: async (action, state) => {
          await checkpoint();
          assertOwnedLineupAuthorization(authorization, { ...binding, ...lineupRelease, snapshot: state.snapshot, action });
          return driver.prepare(action, state);
        },
        commit: async (ticket, beforeCommit) => {
          try { return await driver.commit(ticket, async () => {
            await beforeCommit(); await checkpoint(); counts.submissions++; submissionMayHaveOccurred = true; dispatchOpen = true;
          }); } finally { dispatchOpen = false; }
        },
        readback: async () => { await checkpoint(); return driver.readback(); }
      };
      return runOwnedSeasonTask({ event, repositoryRoot: root, privateDirectory: privateRoot, binding, mode: 'execute', ledger: actionLedger,
        collect: async check => { await checkpoint(); await check(); counts.collections++;
          const assessment = await collectOwnedLineup(page, binding, record, async () => { await check(); await checkpoint(); });
          await writeFile(join(directory, 'assessment.json'), JSON.stringify(assessment) + '\n', { flag: 'wx', mode: 0o600 });
          return assessment;
        }, decide: async request => { await checkpoint(); counts.decisions++;
          const packet = await decide({ ...request, instructions: request.instructions + '\nThis reviewed release supports only one atomic two-player lineup swap or a justified no_action. It cannot execute multiple swaps, pickups, waivers or rename actions. Do not decompose a larger plan or invent a no-action result; return your own sourced judgment within that capability limit.' });
          await checkpoint(); return packet;
        },
        transport, execution: { profileId: binding.profileId, emergencyStopPath, approval: null, pendingClaimsPageUrl: null, lineupRelease,
          browserLedger: borrowed, execution: { leagueId: binding.leagueId, teamId: binding.teamId, maxAgeMs: binding.maxAgeMs,
            writesEnabled: true, releaseSha: manifest.releaseSha, runningSha: manifest.releaseSha, verifiedCapabilities: ['set_lineup'],
            policy: { tradesEnabled: false, allowedActions: ['set_lineup'], windows: [{ kind: 'set_lineup', opensAt: event.opensAt, closesAt: event.closesAt }] } }
        }
      });
    });
  const result = { schemaVersion: 1, releaseSha: manifest.releaseSha, manifestHash: inspection.manifestHash,
    capability: 'atomic_two_player_lineup', receipt, counts, directory };
  await writeFile(join(directory, 'result.json'), JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600, flush: true });
  console.log(JSON.stringify(result));
  if (!receipt.managementCompleted) process.exitCode = 2;
}

main().catch(error => {
  // Never dump browser, source, actor or process exceptions into a scheduler alert.
  const code = error instanceof Error && /^(?:lineup_|season_writes_disabled|explicit_lineup_|invalid_lineup_|unsafe_owned_|emergency_stop$|owned_task_window_closed$)/.test(error.message) && /^[a-z_]+$/.test(error.message)
    ? error.message : 'owned_lineup_host_failed';
  console.log(JSON.stringify({ status: submissionMayHaveOccurred ? 'uncertain' : 'blocked',
    code: submissionMayHaveOccurred ? 'owned_lineup_host_outcome_uncertain' : code, managementCompleted: false }));
  process.exitCode = 2;
});
