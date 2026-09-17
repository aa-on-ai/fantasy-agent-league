import { readFile, realpath } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSeasonManager } from '../dist/src/runtime/season-run.js';
import { createOpenClawManagerDecide } from '../dist/src/runtime/openclaw-manager.js';
import { loadManagerIdentity } from '../dist/src/manager/identity.js';
import { buildManagerContinuityContext, loadSeasonMemory } from '../dist/src/manager/season-memory.js';

// Local review only. No browser, action transport, scheduler, config edit, or initialization.
const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
if (process.argv.length !== 3) throw Error('usage: node scripts/owned-manager-run.mjs REQUEST_JSON');
const path = await realpath(resolve(process.argv[2]));
if (!path.startsWith(join(root, 'runtime/private/owned-reviews/')) || !path.endsWith('/request.json')) throw Error('unbound_review_request');
const request = JSON.parse(await readFile(path, 'utf8'));
if (request.mode !== 'review') throw Error('review_only');
const participant = join(root, 'runtime/private/participant');
const identity = await loadManagerIdentity(participant, { platform: 'yahoo', leagueId: '425299', teamId: '11' });
if (!identity) throw Error('participant_not_initialized');
const continuity = buildManagerContinuityContext(identity, await loadSeasonMemory(participant, identity));
if (request.context.continuity?.hash !== continuity.hash) throw Error('participant_continuity_changed_refresh_request');
const emergencyStopPath = join(root, 'runtime/private/emergency-stop');
const receipt = await runSeasonManager({
  context: request.context, binding: request.binding, mode: 'review', emergencyStopPath,
  receiptDirectory: join(dirname(path), 'automatic-receipts'),
  decide: createOpenClawManagerDecide({ directory: join(root, 'runtime/private/openclaw-manager-runs'), emergencyStopPath }),
});
console.log(JSON.stringify(receipt));
if (receipt.status !== 'reviewed') process.exitCode = 1;
