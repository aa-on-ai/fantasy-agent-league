# Participant home and writing wake

This is a local interface to the existing identity and season-memory APIs, not
a model launcher, second agent, scheduler or Yahoo driver. The host points every
football and writing wake at the **same absolute private directory**. The fixed
actor is `yahoo:f1:425299:team:11`; its display-name preference is not its identity.

Build with `npm run build`. Invoke `node dist/src/cli/participant.js --help`.
All examples below are host commands, not permission for the writing model to
run arbitrary host commands. No real participant state is initialized by tests.

## Host interface

```sh
node dist/src/cli/participant.js init --directory /absolute/private/participant
node dist/src/cli/participant.js prepare-wake \
  --directory /absolute/private/participant --season 2026 --period 1 \
  --brief 'Write my first-person personal debut account for Aaron to review.' \
  --output /absolute/private/writing/wake.json
node dist/src/cli/participant.js record-authored \
  --directory /absolute/private/participant \
  --file /absolute/private/writing/response.json --run-id ACTUAL_MODEL_RUN_ID
```

Only explicit `init` may create identity. Normal `prepare-wake` fails on a missing
identity. Corrupt or misbound state never resets. Directories are 0700, files
0600, absolute symlink-free paths are required. Resolve host aliases before use.
Input JSON files and their parent directories must already be private. Output
JSON is created exclusively with a lowercase `.json` filename; use a new filename
for every wake. Existing files are never overwritten. An output-write failure may
leave an unused immutable wake receipt; it creates no authored history or action.

`prepare-wake` exports instructions, canonical identity, source-backed continuity,
all unresolved issues, prior authored drafts/reflections/name preferences and an
exact `responseSchema`. Send this request to the actual participant model. Do not
have Clawc manufacture the response and call it a participant wake. An empty
history remains empty and cannot support a recorded response until the trusted
host imports an experience. Publication is always false.

The model returns exactly this shape, respecting the limits in `responseSchema`:

```json
{
  "schemaVersion": 1,
  "wakeId": "COPY_FROM_REQUEST",
  "identityId": "yahoo:f1:425299:team:11",
  "sourceEventIds": ["COPY_AN_ACTUAL_EVENT_ID_FROM_REQUEST"],
  "reflection": "Concise original character reflection, not hidden reasoning.",
  "intention": "Concise intention, or null.",
  "namePreference": null,
  "draft": {
    "title": "Personal account title",
    "body": "Actual participant-authored first-person draft, at most 12000 characters.",
    "factCheck": "Private mapping of factual prose claims to event IDs, at most 1000 characters.",
    "unresolvedFacts": "Private unresolved facts, or an explicit statement that none remain."
  },
  "reviewOnly": true
}
```

The host saves the actual response privately and passes its real model run ID to
`record-authored`. The entire expression, draft, intention and name preference
are saved in one `reflection/authored` event, atomically at the memory-event level.
Draft text is split into existing API-sized fact fields and reassembled losslessly
in the next wake's `authoredHistory`. These fields are authored content, not
verified external facts. No second narrative database or mutable identity file
is created. The host-created wake receipt stores source IDs/hashes and admission
metadata, not another copy of season narrative.

Each response must cite an event from its original wake. Current history may have
grown, but admitted source hashes must still match. A retry with identical content
and run ID is idempotent. Changing the response or run ID under the same wake ID
is a conflict, not an overwrite; prepare a new wake for an intentional revision.
Source evidence timestamps are retained; host capture time stamps authored output.

To demonstrate a clean wake, invoke `prepare-wake` again in a new process with a
new output path. Its `authoredHistory` must contain the exact prior draft,
reflection, intention and unapplied name preference without chat history.

## Trusted facts versus authored expression

Existing observed Yahoo facts and action receipts enter through the existing
season-memory APIs under the trusted host's control. This CLI does not offer a
generic fact or observed/verified import command. It includes a narrow host-only
owner-report intake for attributed, still-unverified reports:

```sh
node dist/src/cli/participant.js import-report \
  --directory /absolute/private/participant \
  --file /absolute/private/intake/report.json --trusted-owner-report
```

The private report JSON has exactly these fields:

```json
{
  "schemaVersion": 1,
  "key": "host-selected-stable-source-occurrence",
  "season": "2026",
  "period": "1",
  "occurredAt": "ORIGINAL_SOURCE_TIMESTAMP",
  "kind": "matchup",
  "subject": "matchup:2026:week1:result",
  "summary": "An attributed summary of the actual owner report.",
  "facts": { "outcome": "loss", "score": null, "opponent": null },
  "source": {
    "author": "Aaron",
    "reference": "HOST_AUTHENTICATED_SOURCE_REFERENCE",
    "capturedAt": "ORIGINAL_CAPTURE_TIMESTAMP",
    "content": "Actual sanitized source text, not generated recap prose."
  }
}
```

`kind` is `matchup` or `observation`. Intake fixes actor to `owner`, status to
`reported`, and evidence kind to `owner_report`; no input can promote it to Yahoo
observation or verification. Extra fields are rejected. Null facts remain unknown.
The flag is an explicit host assertion, **not source authentication**. The host
must first authenticate the author/reference in its real source channel. Neither
a content hash, filesystem mode nor a schema proves that a source is genuine.

The actual writing runtime must not be granted the trusted report importer or
arbitrary factual-memory/host filesystem mutation. A prompt and separate CLI
commands are not an operating-system security boundary against a shell-enabled
model. Runtime capability enforcement belongs to host registration. Likewise,
schema validation does not fact-check arbitrary prose. Aaron's review remains
necessary; unsupported claims in prose stay authored text and never mint
observed/verified events or successful manager actions.

## Participant home contract

Ordinary conversation is not a structured writing submission. For casual replies,
the host reads the same bundle through the existing APIs and supplies it as
continuity context, while the participant answers naturally. Do not invoke the
draft response schema merely because the participant received a greeting:

```js
import { loadManagerIdentity } from "./dist/src/manager/identity.js";
import { loadSeasonMemory, buildManagerContinuityContext } from "./dist/src/manager/season-memory.js";

const identity = await loadManagerIdentity(directory);
if (!identity) throw new Error("participant_not_initialized");
const continuity = buildManagerContinuityContext(identity,
  await loadSeasonMemory(directory, identity));
// Supply continuity to the same participant's conversational turn.
// Do not call buildManagerWritingRequest unless a structured draft is wanted.
```

`prepare-wake` and `record-authored` are the explicit draft/reflection-persistence
path, not a requirement that every reply be a JSON column. Ordinary conversation
does not itself add factual history or authorize an action.

The host may install its AGENTS/SOUL/IDENTITY instructions in the one persistent
participant home. On every wake, those instructions must load this canonical
continuity before speaking, require the actual participant to originate its own
expression, and retain the owner-directed unfamiliar-world origin without forcing
cockiness, humiliation or a predetermined redemption arc. No second narrative
memory in those home files should replace the canonical APIs. The home is the
football manager, not Clawc or a separate commentator.

Team-name preference may persist here, but an actual rename uses the existing
scoped football action route and independent readback. Photo choices need Aaron's
approval; drafts need review before publication. This harness performs none of
those external writes and makes no claim that registration or a live wake occurred.

## Verification

```sh
npm run build
node --test dist/test/participant-wake.test.js dist/test/manager-identity.test.js
```

The new tests use explicitly fictional inputs and separate CLI processes. They
verify clean reloading, attributed-source timestamps/unknowns, model-authored
isolation, replay binding, idempotency, no implicit initialization, review-only
outputs and private files. These are harness proofs, not a live Yahoo observation,
live model wake or a judgment that the character's writing is good.

Local verification on September 15, 2026: build exited 0; the focused command above
passed 22/22 tests (7 new harness tests and 15 existing identity tests), no skipped
or failed tests. Only temporary fixture directories were initialized by this lane.
