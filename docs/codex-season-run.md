# Codex-owned season decision runner

September 10 continuation: `native-season-task.ts` now connects the native host,
source producer, admitted Codex decision, guarded driver and durable occurrence
receipt. `startNativeSeasonTask` supports the persistent desktop tool's two-call
decision exchange without launching another model. See
[`finish-automatic-manager.md`](finish-automatic-manager.md) for the exact active
continuation and remaining live work. This does not activate a schedule or
establish live transaction proof.

Implemented locally September 9, 2026. This is not an activated season release,
proof of a submitted Yahoo transaction. The native driver is implemented for the
observed waiver preparation path; unsupported controls remain blocked.

## Ownership

Codex makes the football decisions under `agents/steady-manager.md` and
`agents/manager-contract.md`. Aaron governs release, authority and shutdown, not
player selection, numerical football weights, injury substitutions or claims.
The optional deterministic `planSteady` experiment remains available, but the
new runner does not require it or silently substitute the projection baseline.
It accepts sourced judgment from the admitted Codex runtime and validates it.

## Implemented connection

1. `buildDesktopLineupState` composes full native roster/rules observations with
   independently observed eligibility/locks and a dated schedule. It checks team,
   period, window, source clocks, current assignment and displayed kickoff. The
   oldest source sets snapshot age. Questionable remains questionable. Drop rights,
   pool coverage and pending-claim state are never inferred from a lineup read.
2. `ManagerContext` binds snapshot, source records, published action window and
   repository strategy/contract text. `ManagerBinding.strategyHash` and
   `contractHash` use the repository's `digest` on the exact file strings. These
   are trusted runtime inputs, not values selected in the manager's response.
3. The admitted task receives `codexDecisionInstructions(context)` with the packet
   shape and its own context copy, then returns a `ManagerPacket`. Codex owns
   ranking and rationale. Acquisitions require current pool, drops, pending claims,
   transactions and horizon evidence in addition to the lineup sources.
4. `runSeasonManager` validates the entire packet, checks stop/expiry after model
   work and disk persistence, and saves the bound decision privately before an
   execution attempt. A terminal rejection does not trigger another model turn,
   baseline, alternate adapter or lower-ranked action.
5. In `execute` mode it calls `runGuardedNativeAction` with the first accepted
   action. Team, policy, age bound and stop path must match. Existing release,
   approval, capability, browser/team locks, pending ledger, final gesture guard
   and independent readback remain. Duplicate triggers use the ledger. Unknown
   outcomes stay `uncertain`, with `applied: null`, and are not resubmitted.

The native controls manifest remains a trusted host-normalization boundary. Hashes
and reference strings establish consistency, not the truth of invented source data,
profile isolation, login recovery or atomic Yahoo behavior. The host must supply
actual observations. Re-observing old news does not establish new health clearance.
All source clocks are bounded by the configured maximum age, and the manager must
assess the limitations of the evidence itself.

## Runnable read-only command

After the host has produced an actual fresh context and trusted binding:

```sh
npm run agent:review -- --context runtime/private/context.json --binding runtime/private/manager-binding.json --stop runtime/private/emergency-stop --request runtime/private/codex-request.json
npm run agent:review -- --context runtime/private/context.json --binding runtime/private/manager-binding.json --stop runtime/private/emergency-stop --packet runtime/private/codex-packet.json --receipts runtime/private/manager-runs
```

The admitted Codex task generates the packet between those commands. Each packet
includes schema version, run/context/snapshot binding, strategy, phase, creation
time, ordered `rankedActions` with rationale/source identifiers, and explicit
`unresolvedConstraints`. See `ManagerPacket` for the exact type and the generated
request for its shape. Lineup points must equal the supplied platform projection
sum; acquisitions specify the legal add/drop pair with no invented rolling bid.
A justified no-move/no-claim is one terminal `no_action`. An incomplete or illegal
current lineup cannot pass as a successful no-move lineup review.

The command does not secretly call a model, take credentials, import arbitrary
plugins or offer an execute switch. Request files use exclusive creation;
packet/receipt files are private, durable and attempt-specific. The desktop-native
runtime can import `runSeasonManager` in its admitted task and supply the real
transport. The library is now connected to the guarded executor.

## Verification and remaining work

Behavioral checks cover tampering, wrong team/period, missing controls, stale
sources, lock/schedule disagreement, illegal ranked actions, no-claims,
incomplete-lineup no-ops, model-context mutation, stop during reasoning, guarded
execution, duplicate prevention, uncertain readback, the preserved competitive
hard block and private command output. Execution tests use a synthetic transport.

`YahooNativeDriver` now implements the native App transport using full accessibility
observations and screenshots, exact team/window binding, newly resolved indices,
immutable ticket checks, expiry/stop checks and the existing final gesture guard.
The desktop inspection reached the actual waiver confirmation, resolved both Yahoo
player IDs and its effective week/date, then cancelled. The roster stayed unchanged.
The observed confirmation parser also passed against that private live capture.
Tests exercise the native App driver with sanitized fixtures, not submitted Yahoo
transactions. An independently refreshed roster readback retains a separate native
capture clock while the snapshot still ages from its oldest supporting source.

Lineup execution accepts one atomic swap only and requires host visual confirmation
of the enabled target. Atomicity flags must come from disposable proof. Free-agent
confirmation is explicitly blocked as unobserved. The pending-claims collector is
still a required host producer: no pending queue or successful claim was invented.
The driver cannot submit to league 425299 even if its write setting is toggled.

The exact human prerequisite is authority to provision/use the free private,
populated disposable league and isolated Safari profile described in
`post-draft-adapters.md`, plus any human login challenge. Codex chooses the test
players and records concrete action fingerprints within the authorized action
classes, count limits and expiry. Aaron approves the environment and bounded
execution authority, not football selections. Next, observe free-agent confirmation
and pending-claim controls there, finish their producers, and prove atomic actions
and independent readback. Then obtain the separate scheduled-action and immutable
competitive-release approvals. The scheduled read experiment already passed and
was not repeated. News/horizon evidence also requires actual source collection;
this transport does not manufacture forecasts or injury clearance.

Daily observer, paused read-proof automation, release pin, write flags and
competitive hard block are unchanged. No management job was installed and no
Yahoo action was submitted. The uncommitted work is not an immutable release.
