# Proposed season routines

Status: disabled, awaiting observed roster controls, isolated authentication,
disposable execution proof and Aaron's governed release approval. This file
installs no jobs and changes no private runtime configuration.

## Source binding

The checked league binding records continual rolling waivers, a two-day clearance
period, game-time-through-Tuesday weekly waivers, no bidding budget, and the
existing roster slots/scoring. A fresh native read of `/f1/425299/11/settings`
also confirmed Lock Benched Players: No, post-draft players follow waiver rules,
and direct injury-slot additions are allowed. Preserve these settings. Obtain each claim's actual
Yahoo deadline and each player's actual game lock before materializing dates;
“through Tuesday” does not establish a universal clearing hour. Record source URL,
capture time, league/team identity and the source snapshot hash with every run.

The preserved observer is `96e32e82-f55a-4c53-8e46-5780d709aced`, daily at 09:00
America/Los_Angeles. It now starts an admitted Codex run for the read-only script;
it remains separate from native season management. Reserve 08:45–09:15 Pacific for it; shift a proposed native
assessment earlier or report a conflict when an event falls in that interval.

## Exact proposed timing

| Routine | Proposed start | Completion cutoff | Output |
| --- | --- | --- | --- |
| Daily roster/news assessment | 07:45 Pacific daily | 08:10 Pacific | Fresh normalized roster and sourced outlook; at most one legal free-agent proposal inside the approved daily window |
| Rolling-waiver decision | 90 minutes before the observed Yahoo claim deadline | 65 minutes before that deadline | Ranked claim or explicit no-claim, drop condition and opportunity-cost evidence; rolling claims carry no invented bid |
| Early lineup/injury check | 150 minutes before each distinct owned-player kickoff/lock group | 125 minutes before that group | Coverage gaps, missing evidence and legal lineup proposal |
| Final lineup/injury check | 45 minutes before each distinct owned-player kickoff/lock group | 20 minutes before that group | Fresh injury/lock read, legal decision, and independent applied-state verification if execution is approved |
| Private weekly outcome report | Tuesday 07:00 Pacific | 07:25 Pacific | Previous scoring-period verified actions, unresolved outcomes, source cutoffs, incidents and next windows; unresolved competitive plans remain private |
| Failure alert | On terminal run failure | With that run's final private receipt | Owner-facing app inbox failure with safe code, action/run identity and required intervention; no league-member messages |

Kickoff groups come from the actual schedule, including international games and
reschedules; the runner must not assume only Thursday/Sunday/Monday games. A
changed kickoff invalidates the old event window and requires a fresh proposal.
Every proposed write must also fall inside the independently approved public
operating window. An inability to meet either cutoff yields a missed-window
receipt, not a late write or an extra polling loop.

## Latency and overlap control

Budget each native run at 25 minutes: up to 15 for startup (12 minutes observed),
3 for fresh reads, 2 for decision/validation, 2 for submission and 3 for independent
readback. This is a proposed budget, not a measured upper bound. A transport that
cannot enforce the budget remains unsuitable for unattended deadlines.

Use one exclusive native-browser owner across all routines, then the durable team
ledger lock across fresh read, submit and verification. Skip overlapping triggers
with a recorded overlap code. Coalesce early/final triggers for the same kickoff
group. Preserve the observer tab; keep temporary inspection/action tabs separate.
The current coordinator provides the team lock. `runNativeSeasonTask` now holds
the native browser-owner lock across collection, reasoning and execution, and
the guarded driver borrows that lease. All routines must actually use this
integrated path; its presence in code alone does not verify live coordination.

Check the existing emergency stop before any native read and immediately before
submission. Recheck source freshness and the operating window after all awaited
startup/stop/ledger work. Record a pending action before submission. Reconcile a
pending or uncertain action independently; block different actions for that team
until uncertainty is resolved. A submission followed by persistence failure is
uncertain even if an intermediate platform read appeared successful.

## Strategy inputs and release decision

The optional `--strategy steady --evidence <private-file>` planner uses sourced
workload reliability, resolved news status and an explicitly supplied multiweek
projection/bye horizon. It preserves every currently coverable future week,
compares legal horizon lineups, and uses a larger gain threshold for waivers to
represent rolling-priority opportunity cost. All weights and thresholds are
explicit `steadyPolicy` configuration, with no live defaults or activation.

Source collection and qualitative interpretation remain unimplemented: workload
classification, resolution of conflicting news, future availability and projections
need a verified provider/interpretation contract. Source references establish
traceability, not truth by themselves. The finite supplied horizon does not model
every rest-of-season outcome or a learned value of waiver priority. Codex owns
football judgment under the declared strategy; Aaron governs the implementation
release, not player choices or football weights. `codex-season-run.md` now provides
the sourced model-decision route without requiring this numerical experiment. The existing
projection baseline remains explicitly labeled and is not silently replaced.

Promote only a reviewed immutable commit with recorded league approval, after a
scheduled disposable run demonstrates fresh read, justified decision, transaction,
independent applied readback, stop behavior and failure reporting. Bind exact
materialized schedules and private profile to that release. Activate only the
routines Aaron explicitly approves. Verify the real team's first complete legal
lineup before its relevant locks after release approval; this proposal is not that
verification.
