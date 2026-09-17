# Proof-bound acquisition release

This is default-off local implementation, not an activation receipt. Each capability requires its separate original private sandbox proof. A waiver capability cannot authorize `add_drop`, even if both write switches are enabled.

## Scope and integration

`src/runtime/owned-acquisition-release.ts` exports:

- `OwnedAcquisitionReleaseGrant`: `{ authorization, releaseSha, runningSha }`.
- `verifyOwnedAcquisitionCapability(evidence)`: original before/rules/pool/drop captures, exact stage-3 confirmation, matching snapshot/action fingerprint, original one-preview/one-final receipt, independently captured outcome and final verification receipt. A pending waiver is not an acquired player.
- `inspectOwnedAcquisitionRelease(manifest, environment, evidenceBundle, now)`: exact production `425299/11`, profile `fantasy-agent-1-owned-chrome`, season 2026 and reviewed period; clean pinned repository/source/SHA; per-kind actual evidence; review/approval/window binding. Inspection never opens a browser or changes either switch.
- `authorizeOwnedAcquisitionRelease(...)`: only returns an opaque process-local token after all inspection checks and both `manifest.enabled` and `seasonConfig.yahooWritesEnabled` are true. Plain JSON/casts cannot confer authority.
- `assertOwnedAcquisitionAuthorization(token, { leagueId, teamId, profileId, releaseSha, runningSha, snapshot, action }, now)`: invoke at guard entry and immediately before driver preparation/dispatch. It checks kind-specific proof, numeric scope, period, release and fresh legal snapshot.
- `assertOwnedAcquisitionClaims(state, action, binding, now)`: invoke for **both** acquisition kinds before preparation/dispatch. Unknown/malformed/wrong-scope claims and an existing same-add or same-drop obligation block.
- `OwnedAcquisitionRequestGate`: exactly one stage-2 XHR/fetch preview and one separately armed stage-3 document POST, to the bound team addplayer path, with exactly one matching stage/apid/dpid field. It rejects other Yahoo mutations, repeated previews/finals, changed identities and wrong request type. It never logs form bodies.

The root-owned integration adds `acquisitionRelease?: OwnedAcquisitionReleaseGrant` to `GuardedOwnedConfig` and `OwnedDriverOptions`, dispatches authority checks by action kind, and checks claims before preparation/dispatch. A lineup token cannot authorize an acquisition or vice versa. Driver `getAcquisitionPoolSources?: () => readonly OwnedObservation[]` consumes captured pool pages and independently reobserves the exact add control and current-week/status filters on the selected source. Existing source collection, DOM gesture validation, deadline checks, ledger and readback remain mandatory.

The separate worker did not modify the lineup host, driver or guard. Root subsequently integrated and independently verified those changes locally. Both release manifests and the season write switch remain disabled.

## Prior pending claims and acceptance

An empty prior queue requires original source-bound observed-zero evidence, two distinct supporting document IDs, two independent complete roster captures, no pending signals, and no invented empty response.

A populated prior queue requires `beforeClaimDetails`: original pre-submission detail observations for every current claim. Their numeric IDs and Add/Drop forms must replay against the prior My Team queue. Existing conflicting claims block. A new waiver must add exactly the intended claim while preserving every prior claim; a pickup must show the exact roster delta and preserve every prior pending obligation. Changed/unknown queue evidence blocks capability verification. This allows a pickup dropping benched Prescott while a nonconflicting Purdy/Goff claim is still pending; it does not assume the queue is empty.

`receipt` may be the same directly verified one-submit receipt, or the actual zero-submit `reconciled_without_resubmission` receipt paired with the original `uncertain/submission_not_verified` one-submit receipt. A synthesized `verified` flag, a test result, or a capability label is insufficient.

## Host

`scripts/owned-acquisition-manager.mjs` has two explicit commands:

```
node scripts/owned-acquisition-manager.mjs inspect runtime/private/owned-releases/<reviewed-manifest>.json
node scripts/owned-acquisition-manager.mjs execute runtime/private/owned-releases/<enabled-manifest>.json runtime/private/owned-schedule-specs/<bounded-occurrence>.json
```

There are no implicit execution, release generation, activation, configuration edits or scheduler enrollment. The host:

1. Rebuilds ignored `dist` from clean pinned source and verifies original evidence, scope and both gates before browser/actor access.
2. Holds the existing single browser lease across fresh acquisition collection, the **same** persistent manager, guarded action, independent readback and browser close. Uses canonical `runtime/private/participant` through `runOwnedSeasonTask`; no new identity, actor, browser profile, action ledger or scheduler.
3. Rechecks stop, event window, source/SHA/config, manifest and evidence at checkpoints and before commit. Uses only the current occurrence's acquisition kind. The occurrence is at most 15 minutes; an unsupported kind or missing pickup proof blocks before collection.
4. Collects the observed first O/K/DEF pages plus all assessed-player evidence and known pending claims. The manager receives the explicit limited candidate universe, not a claim to have scanned the entire league.
5. Restricts preview and final POSTs using the exact observed sandbox protocol. Atomic driver controls and independent queue/roster readback determine outcome. No fallback strategy or manufactured no-action is supplied.
6. Writes execution receipt and network counters privately. The existing runtime records the actual proposal and verified/uncertain outcome into the same participant history. Partial failures never create a second actor or replay an uncertain transaction.

No operational live host run was made. Production code integration is locally verified; activation and its live acceptance remain open. Missing capability evidence remains an activation blocker, not an implementation result disguised as a proof.

## Exact original waiver proof replay

Run from the canonical repository after integrating this module. This creates a **new** private replay bundle from original files, never the minimized test fixture. It refuses to overwrite an existing replay artifact. It performs no browser, actor or Yahoo action.

```sh
npm run build --silent
node --input-type=module <<'JS'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {verifyOwnedAcquisitionCapability} from './dist/src/runtime/owned-acquisition-release.js';
const base='runtime/private';
const first=base+'/owned-sandbox-waiver/2026-09-16T04-20-02.241Z';
const last=base+'/owned-sandbox-waiver/2026-09-16T04-27-12.397Z';
const read=(dir,name)=>JSON.parse(readFileSync(dir+'/'+name+'.json','utf8'));
const plan=read(first,'acceptance-plan');
const proof={schemaVersion:1,
 binding:{leagueId:'1659459',teamId:'1',teamName:'Stiff Arm ae',profileId:'fantasy-agent-1-owned-chrome',season:2026,period:'2',maxAgeMs:900000},
 acceptanceReleaseSha:plan.config.execution.releaseSha,
 before:plan.state.observation,
 rules:read(first,'93047f67-3225-4f10-876c-19c33e81a4c6'),
 pools:[read(first,'c29b7124-05f0-4f58-82fb-85915fe06b1d')],
 drops:read(first,'573f8ad6-e67e-43c0-9f8b-02f5e71824b9'),
 beforeClaims:plan.state.pendingClaims,beforeClaimDetails:[],
 confirmation:read(first,'0ba30ddb-5ba9-42bd-b094-3d5a14962a81'),
 snapshot:plan.state.snapshot,action:plan.action,submission:read(first,'receipt'),
 readback:read(last,'f7102725-4f04-4c7c-bbb3-34a3753eeff8'),
 claimDetails:[read(last,'eed70709-67c1-44c4-9afa-7a8e397c6684')],
 receipt:read(last,'receipt')};
const verified=verifyOwnedAcquisitionCapability(proof);
mkdirSync(base+'/owned-release-evidence',{recursive:true,mode:0o700});
writeFileSync(base+'/owned-release-evidence/waiver-original-replay.json',JSON.stringify(proof)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(verified));
JS
```

Actual original replay result:

- Acceptance SHA: `0420327f4d678670d64d084ccabb2176056c2d88`.
- Action: `4b0420f627586f4afffd7490c1abbb76f2ce36cbc7c6ac88956d5f9ffef1c9a7`.
- Claim: `1_34218_29235`, Purdy 34218 for Goff 29235, **pending**, not acquired.
- Evidence hash with `beforeClaimDetails: []`: `0ded40ee0f5e8c5c4d75c55cbaf6d14b4b606ad4cba58008507f171045ba9f8d`.
- Original submission counters: preview 1, final 1. Independent reconciliation counters: preview 0, final 0.

For a manifest, `evidence` is keyed by each declared kind and includes its private path, `digest(proof)` and acceptance SHA. `review.evidenceHash` is `digest({ [kind]: digest(proof), ... })`, not a digest of filenames. Approval `scopeHash` is `digest({scope,capabilities,opensAt,expiresAt})`. Both approval and review bind the exact **new operational release SHA**, while acceptance evidence keeps its historical acceptance SHA.

## Verification

Eight focused regressions cover original-shaped waiver proof, counterfeit acquired-player claims, populated prior obligations, default-off and missing-kind gates, opaque authorization scope, conflicting/unknown pending claims, exact one-preview/one-final POST gate, and explicit CLI/no implicit execution. Full isolated suite: 233 tests passed against baseline `d0f8ce5` plus this lane. Root's full integrated suite passes **235/235**, including a separate production-port regression proving forged token rejection before read, unknown/conflicting claims before preview, no pickup from a waiver token, independent verification and zero duplicate submissions. Log `/tmp/fantasy-acquisition-integrated-tests.log`. Minimized fixture is provenance-labeled regression data only, not original operational proof; the parent independently replayed the private original bundle and obtained the exact hash above.
