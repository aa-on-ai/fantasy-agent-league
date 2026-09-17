# Automatic football outcome memory

`runOwnedSeasonTask` passes its existing, scope-bound participant directory to
`runSeasonManager`. The runtime never initializes or substitutes an identity.
The generic runner's `participantDirectory` option remains optional for legacy
and offline callers; the owned runtime always supplies it.

## Recorded facts

- After packet validation and private decision-file persistence, the selected
  decision is appended as a **proposal**, before any guarded execution. The
  event retains the exact packet, context/snapshot hashes and source references.
- Review-only, blocked and no-action outcomes are **observations** of the actual
  runtime receipt. They do not become executed or verified actions.
- The owned transport wrapper captures its actual pre-action state, commit
  entry and independent readback. Successful first-person attribution requires
  a current-run commit, the guard's verified receipt, and matching independently
  observed lineup, roster membership or pending-claim evidence. A waiver claim
  being pending is explicitly not a waiver win or player acquisition.
- Verified actions retain the existing **proposed → executed → verified** memory
  chain. The execution receipt and independent observation have different
  provenance. Account DOM text is not copied into season memory.
- An uncertain current-run submission is recorded as uncertain, not success.
  A ledger duplicate or historical reconciliation without current-run submission
  evidence is only an observed outcome; it cannot create new personal credit.
- The same numeric team scope is enforced by the stored identity, context and
  memory APIs. Sandbox evidence cannot be written into the production identity.

The season label follows the NFL July-to-June season boundary, using the source
snapshot timestamp; the period is copied exactly from the snapshot.

## Failure and replay behavior

A missing/mismatched/unreadable participant blocks before the decision call.
Proposal persistence failure blocks before transport. Source freshness and stop
checks are repeated after proposal persistence.

Before recording the outcome in canonical memory, the runner writes a private
`<attempt>.outcome.json` containing the exact runtime receipt and sanitized actual
owned readback. If memory persistence subsequently fails, the final receipt
explicitly reports `participant_outcome_persistence_failed`; a possible submitted
action stays uncertain and the original execution receipt is preserved. It does
not retry or select another action. Operators can inspect the private artifact
and existing ledger for reconciliation.

The scheduler occurrence receipt prevents duplicate execution and duplicate
memory intake. Proposal keys and exact outcome intake are also idempotent;
conflicting proposals under the same run/mode key fail closed. Direct calls with
a new attempt ID may add a new outcome observation, but cannot resubmit an action
already protected by the ledger or grant new credit from that ledger alone.

## Limits

Pre-collection stops, absent identity and incomplete source assessment still use
the owned task's durable blocked receipt. They are not invented as manager
decisions or appended through an identity that could not be loaded. Abrupt
process death before the final outcome remains covered by occurrence/ledger
reconciliation, not a fabricated completed outcome event.

The legacy native runtime is unchanged. If a caller opts it into proposal/outcome
memory, it gets receipt observations but no successful-action attribution without
the owned readback evidence. This patch does not enable Yahoo writes, alter
production guards, submit an action, invoke the actor, or validate live memory
delivery. All tests use private temporary fixtures.
