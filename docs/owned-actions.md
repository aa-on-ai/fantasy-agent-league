# Owned Yahoo browser action lane

This lane is DOM automation in an owned Chrome context, not native CUA. It never constructs a native accessibility capture from DOM. Competitive league `425299` writes are blocked unless both guard and driver receive the matching proof-bound, process-local release authorization. Lineup and acquisition capabilities are distinct; write flags or disposable test grants cannot substitute. See `owned-lineup-operational-release.md` and `owned-acquisition-operational-release.md`. Production write gates remain off.

## Integration

- `withOwnedBrowser({ profilePath }, async page => ...)` opens only the existing private dedicated Chrome profile at `~/.local/share/fantasy-agent-league/2026/agent-1/browser` and closes only the context it launched. It does not attach, create a missing profile, copy authentication, remove browser locks or kill other processes. A profile ownership conflict must remain a blocker.
- `new YahooOwnedDriver(page, options)` accepts the parent's existing Playwright `Page`. This is the route for the current acceptance owner. The driver never opens another profile.
- `OwnedObservation` and `captureOwnedObservation` come from `owned-sources.ts`. `normalize(observation)` must return `OwnedState` preserving that exact observation, oldest supporting source time, numeric Yahoo IDs, `SeasonSnapshot`, and independently resolved player deadlines. Unknown pending claims are `null`, not an empty queue.
- `runGuardedOwnedAction(original, decision, config, driver, actionLedger)` retains `executeDecision`, policy validation, action fingerprints, cross-process ledger exclusion, release pinning, stop controls, freshness, unresolved-action blocking and readback. A separate `browserLedger` holds the profile scope. The runtime must also own the browser across source collection and model review, not only the transaction itself.
- Sandbox actions need an exact `OwnedDisposableApproval`, including league, team, profile, action fingerprint, expiry, recovery/isolation evidence and approval reference. An initial capability proof additionally needs the coordinator's matching `acceptanceTest` grant when the capability is not yet verified.
- `OwnedReviewedRelease` records exact release SHA, team/profile, approval, independent review and capability evidence for a later reviewed release. Supplying it does not activate competitive-team writes.

## Observed control protocol

Parent-owned captures from September 15, 2026 established these control structures in sandbox league `1659459`, team `1`. They establish the observed preview protocol, not successful action acceptance.

1. Roster players have numeric `data-ys-playerid` identities, including defense `100034`. Lineup controls have exact `Click here to edit <position> <name>` labels. Selecting the source changed its row to `swapactive`; the offered target changed to `swaptarget`. Configure `swapSelection` with those tokens and an inspected `atomicSwapEvidence` reference. The driver supports one exact two-player swap only. Multiple independent swaps are blocked and must be replanned as separate verified operations.
2. Pool acquisition uses the observed `Add Player` link for the numeric candidate. Where Yahoo requires a manager choice, the driver verifies and submits the observed `Select Team` GET form with the bound numeric `mid`. It verifies the form's destination remains the same league/add ID.
3. The drop preview is an observed `button[type=button]` with title `Click to drop this player` and `data-check-box-value` equal to the drop ID. This click causes an XHR preview, not the final transaction. The driver waits for the final submit input before reading the confirmation.
4. Final waiver confirmation uses `input[type=submit][name=submit_add_player]` with exact value `Create claim to Add <name>, Drop <name>`. The submission POST form carries numeric `stage=3`, `apid`, and `dpid`; the Stats link independently exposes the stage-2 pair. The displayed effective week must match the decision. Free-agent confirmation has a separate `Add Free Agent` heading and exact `Add <name>, Drop <name>` label. Its live acceptance remains required independently.

Private source captures are in the original checkout's `runtime/private/owned-manager-2026-09-15/`, notably `sandbox-swap-selection-2026-09-15T22-39-20.354Z.json`, `sandbox-waiver-selection-2026-09-15T22-45-28.159Z.json`, and `sandbox-waiver-confirmation-inspect-2026-09-15T22-48-35.337Z.json`. Do not publish these private captures or treat sanitized test fixtures as live evidence.

## Commit and readback

Preparation creates a single-use ticket bound to exact action, original observation, snapshot hash, league, team, period, control evidence hash and expiry. It may select a lineup source or create an acquisition preview, but never final-submit. An uncertain preview is not blindly retried.

Immediately before the final dispatch, the driver awaits the guard callback. The subsequent single synchronous browser task checks current URL, My Team ownership, every numeric player row and its selection state, exact target control, effective period and, for acquisitions, actual form IDs and action. It then calls that one DOM control's `click()`. There is no Playwright click retry or actionability wait across this boundary. Ticket consumption precedes dispatch, so timeout or transport failure cannot replay the gesture.

Verification independently reloads the team, with a distinct observation and current source time. A lineup requires exact assignments and identical roster identities. Add/drop requires both ownership changes and preservation of every other roster identity. Waivers require an independently captured, source-hashed, normalized pending-claim queue at its exact observed URL. Neither ownership nor the general transaction feed proves a pending claim. The initial queue must also be known and contain no equivalent claim.

Unknown readback or any dispatch error remains uncertain in the durable ledger. Repeated triggers reconcile and never resubmit. No automatic fallback action follows an uncertain result. Profile-cleanup failure after a possibly submitted action must remain uncertain at the enclosing runtime boundary.

## Verification limits

Tests exercise identity, stale snapshots/captures, deadline expiry, action/window/release approval, stop immediately before commit, exact prepared controls, current DOM mutation, input/form bindings, single-use tickets, uncertain dispatch, independent readback, duplicate claims and replay. They use local fixtures and fake Page ports. The worker did not launch a browser, open a live profile, submit to Yahoo, change configuration, deploy, activate a scheduler or publish anything.

Live acceptance receipts remain private. The public regression suite is not an activation receipt. See [the implementation map](finish-automatic-manager.md) for current boundaries.
