# Prepared lineup-only operational host

This is release preparation, **not activation**. `runtime/private/season-2026.json` remains an independent write gate. Root integrated the proof-bound driver/guard interface in `2d77f97`; absent or invalid authorization still blocks production. No write gate or operational schedule has been enabled.

The first supported release is one atomic two-player lineup swap (starter/bench or eligible starter/starter) for Yahoo league `425299`, team `11`, owned profile `fantasy-agent-1-owned-chrome`, season 2026. It is not an acquisition-ready or unrestricted lineup manager. A no-action decision remains the actual persistent actor's judgment. Acquisitions, multi-swap plans, account changes and renaming are refused.

## Execution and lifecycle

`scripts/owned-season-manager.mjs` requires an explicit `inspect` or `execute` command and private reviewed manifest. There is no default execution mode and no generated manifest.

```text
node scripts/owned-season-manager.mjs inspect runtime/private/owned-releases/<reviewed-release>.json
node scripts/owned-season-manager.mjs execute runtime/private/owned-releases/<reviewed-release>.json runtime/private/owned-schedule-specs/<existing-occurrence>.json
```

Inspect validates release/evidence and reports the independent activation blockers without browser or actor access. Execute requires both `manifest.enabled === true` and the independently reread `season-2026.json.yahooWritesEnabled === true`. Enabling neither is part of this patch.

The host locks the existing owned browser ledger **before launch**, holds one page through fresh collection, the existing `fantasy-manager` decision transport, guarded submission and independent readback, then closes its own context before releasing the lease. The runtime's nested ledger is a scope-checked borrowed lease, not a second competing lock. The host uses the same canonical `runtime/private/participant` through `runOwnedSeasonTask`; no fallback identity or actor exists.

Tracked `src`, `scripts`, `agents`, package files and TypeScript config must be clean and match the exact reviewed git SHA. The host rebuilds ignored `dist` before importing it. At collector checkpoints, before and after the actor turn, on fresh action reads, and immediately before commit it checks the canonical emergency stop, event window, unchanged manifest/evidence, git/source identity and independent season config again. Non-GET/HEAD Yahoo requests are blocked outside the guarded atomic commit interval. A possible dispatch followed by a host failure is uncertain, never a blocked/no-action success.

## Required manifest and event contracts

The exact TypeScript schema is `OwnedLineupReleaseManifest` in `src/runtime/owned-lineup-release.ts`. Preparation/review must supply real approval and review references; nonempty placeholders are not human approval. The application cannot authenticate a human review by itself. Hashes bind the reviewed trusted local artifact, not the reviewer identity.

Required bindings are:

- Canonical repository `/Users/moltbot/clawd/worktrees/fantasy-single-agent-20260907`, exact 40-character release SHA and source hash.
- Fixed production league, team, profile, season; explicit numeric week and current team display name.
- Exactly `capabilities: ["atomic_two_player_lineup"]`.
- Explicit opening/expiry window, at most seven days, with no implicit renewal.
- Approval reference bound to SHA and `digest({scope, capabilities, opensAt, expiresAt})`.
- Review reference bound to the same SHA, source hash and evidence hash.
- Evidence file `runtime/private/owned-release-evidence/<name>.json`, parsed-content hash, and original acceptance SHA.
- An explicit boolean `enabled`, initially false during preparation.

`sourceHash` is SHA-256 of `JSON.stringify(sortedPairs)`, where each pair is `[trackedRelativePath, sha256(fileBytes)]` over the above protected path set, lexicographically sorted. This includes the executable host and release validator. Any integration edit requires the final SHA/hash to be reviewed again.

The existing scheduler occurrence spec must have `schemaVersion: 1`, `mode: "execute"`, the exact `releaseManifestHash`, league/team strings, and an `event` with ID, phase `lineup`, opening and closing times. Its window must be within the release window and no longer than 15 minutes. This patch does not enroll or alter a job. Root must reuse the existing continuation/schedule owner.

## Actual capability evidence, not a success boolean

`OwnedLineupCapabilityEvidence` contains the original sandbox binding, acceptance SHA, raw initial roster, selected-source/target capture, rules capture, independent applied roster, original normalized snapshot, exact requested action and exact execution receipt. It is accepted only when:

- Sandbox scope is `1659459/1`, same owned profile and season.
- The original normalized snapshot agrees with the raw initial/rules captures.
- The action is exactly one valid two-player swap, and its fingerprint equals the verified receipt's action ID.
- `swapactive` and `swaptarget` are present on the exact initial player/position rows with exact edit controls.
- Selection preserves the initial roster. Readback is a distinct later capture and changes only the requested assignments; all players and other decision-bearing state remain consistent.
- The receipt is `verified / independent_readback_passed`, not merely a claimed capability.
- The complete evidence hash matches the reviewed manifest.

Read-only replay against the existing actual sandbox proof in `runtime/private/owned-sandbox-swap/2026-09-15T23-03-11.411Z/` passed. Inputs are the plan's initial state/action, selection `9a2b4967-66ef-4a1a-8764-1ad2e9168e80`, rules `8cfaceee-2657-4510-be4a-a351c4499ee1`, readback `8d0ee613-4655-4bbc-9d05-9294f5def102`, and exact `receipt.json`. Original acceptance SHA is `172ea43e0c6be09210145d220c831e381631c5de`. This replay did not create a release manifest or write canonical state.

## Root integration (completed locally)

Add the same optional field to `OwnedDriverOptions` and `GuardedOwnedConfig`:

```ts
import type { OwnedLineupReleaseGrant } from "../../runtime/owned-lineup-release.js";
lineupRelease?: OwnedLineupReleaseGrant;
// { authorization: OwnedLineupAuthorization; releaseSha: string; runningSha: string }
```

The token is an opaque frozen object recognized only by this module's process-local WeakMap. A serialized/reconstructed object or type cast does not authorize anything. `authorizeOwnedLineupRelease()` creates it only after complete pinned release, actual evidence and both write gates pass.

At each existing production hard-block point call:

```ts
assertOwnedLineupAuthorization(grant?.authorization, {
  leagueId, teamId, profileId,
  releaseSha, runningSha,
  snapshot, action
}, now);
```

The guard must use its actual execution SHA fields, compare them to the grant fields, and pass the original/fresh decision snapshot. The driver must use its actual binding, grant SHA fields and action/state, including its retained pending action/state immediately before commit. Preserve the hard block when the grant is absent or fails; never replace it with `allowSubmission` or a nonempty string. Preserve the existing stop, window, freshness, single-use ticket, ownership, ledger and readback checks. Disposable sandbox authorization must remain unchanged.

The host passes `lineupRelease` to both. The integration test exercises the production guard with a test-only proof-bound grant through one independently verified swap, rejects a forged grant in both guard and driver, and confirms a duplicate does not submit again. Helper tests reject wrong SHA/scope/expiry/acquisition/multi-swap. These are local tests, not a real-team action receipt.

## Verification and remaining release work

Focused tests cover altered receipt/action, missing selection evidence, conflicting source/readback, dirty/different SHA/source, wrong scope, broadened capability, independent disabled gates, expiry, forged tokens, immutable authorization, and a single browser/lease lifetime through readback and failures. Synthetic fixtures are labeled tests; they are not acceptance evidence.

Root still owns exact final integration review, concrete manifest/approval provenance, the independent config change if already authorized, one existing scheduler cutover, cold operational acceptance and exact target readback. This patch cannot honestly claim those are done, or claim pickup/waiver support.
