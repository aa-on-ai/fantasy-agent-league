# Season acceptance, September 7 implementation

## What is executable

- `npm run acceptance` builds and runs the behavioral checks, including the planner and execution coordinator.
- `npm run agent:readiness` performs a domain-scoped, read-only observation of an already-open assigned Yahoo team tab in Safari. It records private receipts and names missing readiness evidence. It never reads login forms or cookies and cannot submit transactions. An open ranking editor is intentionally not treated as a team observer tab.
- `npm run agent:plan -- --snapshot <private-snapshot.json> --config <private-binding.json> --phase lineup` produces a private decision packet. Other phases are `free_agents` and `waivers`. It never executes a decision, and its console summary does not disclose player choices.

The private planner binding contains string `leagueId` and `teamId`, a positive
`maxAgeMs`, and an optional positive `minimumGain`. The snapshot contract is
`SeasonSnapshot` in `src/manager/season.ts`; its integrity hash is computed with
`snapshotHash`. It requires platform-observed legal slots, availability, locks,
drop permissions, projections and current ownership. Unknown projections are not
silently replaced with invented numbers. Raw Yahoo responses are not this contract.

## Strategy boundary

This first mechanical baseline computes the exact highest-projected legal weekly
lineup, retains current assignments on ties, and preserves locked starters and
locked bench players. Acquisitions propose at most one legal rolling claim or
free-agent swap when it improves the complete weekly lineup by the configured
threshold. No bid is invented for rolling waivers.

This is not a complete judgment-based Steady manager. It does not evaluate
long-term upside, future bye-week coverage, roster scarcity, future waiver
opportunity cost or narrative player news. The season owner must review that
tradeoff before enabling it as competitive behavior. The documented neutral
highest-projected-lineup fallback is its present basis.

## Execution contract

The coordinator requires a fresh, integrity-checked snapshot for the assigned
team; an exact release pin; explicit verified capabilities; a legal decision;
and a published action window. A filesystem lock spans fresh read, submit and
independent verification. The ledger records pending submission before the call.

The real adapter must perform its own team-bound, fresh platform reads for both
`read` and `verify`, and must implement an atomic domain action or stop on any
partial/unknown state. It must never return `applied` based on a successful click
or request status alone. No such live roster adapter is included in this slice.

A crashed process leaves its lock in place. Recovery requires inspection of the
private ledger and independent Yahoo readback, not a guessed lock timeout.
Pending/uncertain entries are reconciled without automatic resubmission. A
verification result that is missing or ambiguous remains uncertain. Deliberate
retry/reset after reconciliation is a separate operator action.

Place `runtime/private/emergency-stop` to stop the read-only observer. A live
adapter must expose the same stop control through `Executor.stopped` before
submission. Removing the stop file does not verify any capability or enable writes.

## Browser boundary

The Chrome login helper has its own private profile. The authenticated Safari
session is a different route; Chrome isolation does not prove Safari isolation.
The native desktop Computer Use client was discovered and successfully listed
its tool interface, but app-state acquisition failed because its runtime could
not start from the OpenClaw agent environment. No native screenshot/click success
or scheduled native computer-use success is claimed.

## Required live evidence still missing

1. Native Computer Use app-state and interaction proof in the actual scheduled runtime, or an explicitly selected and verified Safari execution route.
2. Dedicated authenticated profile isolation and login recovery.
3. Complete Yahoo snapshot extraction and live roster-action adapters.
4. Disposable-context lineup, rolling-claim and add/drop transaction readbacks.
5. Yahoo autopick using persisted rankings in a mock draft.
6. Reviewed behavior and immutable season release promotion by the human owner.
7. A scheduled end-to-end competitive action, failure alert, and emergency-stop proof.

Read-only readiness monitoring is useful on its own. It must remain labeled as
observation, not season management. Daily free-agent decisions, waiver windows,
pre-kickoff checks and weekly public records require the remaining source and
approval gates before activation. Preserve the league's rules and action windows.
