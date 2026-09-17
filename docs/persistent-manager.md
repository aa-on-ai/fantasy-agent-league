# Persistent manager identity and season memory

## What is implemented

`src/manager/identity.ts` persists one private, versioned identity with an immutable
numeric Yahoo league/team binding and the owner-directed character seed. The
production identity is `yahoo:f1:425299:team:11`. A separate sandbox identity can
be created from its exact scope, but sandbox history must not be attributed to
the production participant. Identity persistence means shared history across
runs, not a promise that one process never ends.

`src/manager/season-memory.ts` supplies append-only, content-hashed event records,
deterministic occurrence deduplication, scope checks, provenance validation,
explicit uncertainty/conflict reporting and a shared decision/writing context.
Reflections and intentions are authored records tied to recorded experiences;
they do not become factual observations or hidden reasoning. Proposed names
survive a clean wake without implying any rename took place.

`src/manager/codex-run.ts` accepts `continuity` in `ManagerContext`, validates its
scope and integrity, includes it in the existing context hash, and supplies its
identity/history instructions to the admitted Codex decision turn. Legacy and
offline contexts remain compatible without continuity; that compatibility is
not proof that a runtime has been connected to persistent identity.

## Host integration

Use a single private directory outside per-occurrence receipt folders. Both
football and writing turns must resolve the same absolute directory. Resolve
host symlinks before use; memory storage refuses symlink path components,
nonprivate state and orphaned history with a missing identity. It never changes
permissions of shared parent directories.

```ts
import { join } from "node:path";
import { loadManagerIdentity } from "../manager/identity.js";
import { loadSeasonMemory, buildManagerContinuityContext,
  buildManagerWritingRequest } from "../manager/season-memory.js";

const directory = join(options.privateDirectory, "participant");
const scope = { platform: "yahoo" as const,
  leagueId: binding.leagueId, teamId: binding.teamId };
const identity = await loadManagerIdentity(directory, scope);
if (!identity) throw new Error("participant_not_initialized");
const continuity = buildManagerContinuityContext(identity,
  await loadSeasonMemory(directory, identity));
// Before managerContextHash(context):
context.continuity = continuity;

// A separate writing wake loads the same bundle, not a second persona.
const writingRequest = buildManagerWritingRequest(continuity, {
  season: "2026", period: "1", brief: "Draft my personal debut account."
});
// The existing admitted manager turn consumes writingRequest.
// No recursive model bridge, new bot, schedule or publication is started here.
```

Both football runtime entry points load this existing bundle on every wake,
before browser collection and building the decision context. Ordinary wakes do
not initialize or recreate it. Missing identity returns
`participant_not_initialized`; corrupt or orphaned state fails closed without
resetting it. Only explicit trusted-host setup uses `initializeParticipant` or
the scope-bound `loadOrCreateManagerIdentity` API.

Host integration must persist new facts/receipts/reflections after the actual
event. The host remains the trusted producer: schema checks establish
binding and consistency, not that an invented payload really came from Yahoo.
Never pass model-generated claims directly into factual memory.

## Events and provenance

Call `appendSeasonMemoryEvent(directory, identity, input)`. The exported
`SeasonMemoryEventInput` is the exact schema. Each input includes a stable `key`,
matching scope, season, period, original `occurredAt`, run ID or null, actor,
kind/status, stable fact/action `subject`, concise summary, structured `facts`,
related event IDs and evidence. Null facts are explicitly unknown. Every source
retains its original `capturedAt`, reference, scope, sanitized content and
`digest(content)`; intake time must not replace source time.

Each saved event is one immutable private `events/<id>.json`, with its identity
hash and content hash. Reappending the same key and body returns
`duplicate: true`. A changed body for the same key throws
`season_memory_occurrence_conflict`; it never overwrites history. New evidence
of a changed or disputed fact gets a new key under the same subject, preserving
both observations and exposing disagreement. Use a period-qualified subject for
changing facts, for example `matchup:2026:week1:result`, not a generic `score`.

Event meanings:

- `action/proposed`: sourced decision, not execution. Evidence content for
  `decision_packet` contains the actual `actionId` and packet.
- `action/executed`: submission occurred, but success has not yet been established
  by this event. Requires a linked proposal and `execution_receipt` content
  with the same `actionId` and `status: submitted` or `verified`.
- `action/uncertain`: actual execution receipt says `status: uncertain`. Requires
  a linked proposal. Never convert uncertainty to success because time elapsed.
- `action/verified`: requires an independent readback with matching `actionId`
  and `result: applied`. Manager attribution also requires the linked executed
  event, itself linked to the proposal. The readback cannot be the same reference
  or content hash as the execution receipt and cannot predate the action.
- `matchup` or `observation`: `reported` requires an attributed owner report;
  `observed` requires source observation; `verified` requires independent readback.
  A match result alone grants no manager-action attribution.
- `reflection` or `intention`: `authored`, by the manager, linked to existing
  experience; no factual evidence payload. Summaries are concise authored
  expression, not instructions, observations or hidden chain-of-thought.

Blocked, no-action and already-verified receipts cannot be relabeled as a new
execution. Unknown historical actors are retained as `actor: unknown`, never
added to `verifiedManagerActionIds`. If a source packet does not support a field,
leave it unknown or retain only the attributable report. Do not mint evidence
from generated recap prose.

## Boundaries and failure behavior

Files are 0600 and created exclusively; owned directories are 0700. The intended
writer is the single governed manager host. Concurrent contenders may fail
closed during a partial write; do not add blind retries or a second writer.
Unreadable, truncated, unexpected or corrupt state requires inspection and is
never silently reset. These APIs do not replace the executor's action ledger,
which still owns duplicate submission prevention and reconciliation.

`buildManagerContinuityContext` exposes `empty`, `found` or `conflict`, recorded
issues and only supported successful manager-action IDs. The existence of history
does not mean every fact is verified. Both requests carry the same continuity
hash. Writing returns `publish: false`; no external write is performed. Neither
memory nor character metadata grants action permission.

## Verification and remaining delivery

The focused tests exercise a separate-process clean wake with no inherited chat,
identity/history/reflection/intention continuity, scope and identity conflicts,
source hashes/timestamps, deterministic dedupe, unknown versus conflicting facts,
action-state attribution, independent readback, immutable-file tampering,
private permissions, and shared context binding for football and writing.
All inputs in these tests are explicitly fictional fixtures, not Yahoo captures.

This lane does not activate the live manager. The parent must integrate the
runtime, seed only source-supported actual history, verify a clean live wake,
return the personal draft for Aaron's judgment, and finish the existing release,
scheduler, action and failure-delivery proofs. No extra scheduler, bot, team
rename, avatar or publication is created by this implementation.
