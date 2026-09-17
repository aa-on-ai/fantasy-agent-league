# Owned acquisition assessment

`collectOwnedAcquisitions(page, binding, phase, record, checkpoint, options)` is a read-only source collector for `waivers` and `free_agents`. The caller owns the only browser lease. It does not open a browser, submit an action, invoke the manager, initialize participant memory, or change scheduler/configuration.

The collector follows the team's observed settings, player-pool, drop-player and transactions links. Candidate pages come from the actual owned GET filter form and its offered current-week projection, availability and O/K/DEF options. It collects the first page of each category only. Returned `coverage.scope` and every pool source say `observed_page_only`; pagination is not followed and no exhaustive-market claim is made.

Every roster player and every candidate on those pages receives a selected-player card capture. The parser binds player ID/name, selected card, season and projection period. On pool pages the exact selected weekly projection control is the period evidence; on My Team the existing roster caption remains required. Missing news, dated schedule, projection, lock evidence or future game-log horizon prevents readiness. One failed card hydration can retry the same read-only card only when no card opened. The bound defaults to 100 assessed players; exceeding it produces a gap, never a silently truncated recommendation set.

Both the initial and final roster and each candidate page must retain the same assessed players/metrics through collection. Oldest snapshot source time is preserved, and all detail/source observations must remain fresh at normalization. A stop aborts collection. Invalid ownership cannot produce a usable source; a missing optional source is an explicit readiness gap. Non-GET/HEAD Yahoo requests are blocked during collection, and any blocked request leaves readiness false. The route handler is removed on success or failure.

## Claims contract

Supply `options.collectPendingClaims: () => Promise<OwnedClaimsEvidence | null>` using the host-owned queue reader. The callback can navigate the owned page to actual observed queue/detail links. It must not submit or cancel a claim. A missing callback, null response or invalid evidence never becomes an empty queue.

Normalization checks the evidence hash, observation freshness/profile/team route, unique claim IDs and every claim's numeric add/drop IDs and matching league/team/period. The original evidence and `observed_empty`, `explicitly_empty` or `observed_claims` interpretation remain in the returned input/source. This collector does not own the populated-queue parser or manufacture pending claims.

## Deadlines and readiness

Available free-agent deadlines come from the observed add control and dated future kickoff. Waiver deadlines use `ownedAcquisitionDeadline`, which supports only the verified rolling `Game Time - Tuesday` rule plus the candidate's future Wednesday waiver date. The resulting time is explicitly a conservative submission cutoff, not an observed exact Yahoo processing time. Lock-source facts retain that interpretation and the official rule reference. Other waiver schedules or dates keep readiness false.

Droppable roster players receive an independent future kickoff deadline only when the separate drop page explicitly offers their matching drop control. A missing/expired drop deadline also prevents acquisition readiness. The blanket `waiver_submission_deadline_unobserved` stub is removed only for candidates whose live facts satisfy the supported derivation.

The collector returns `{assessment, input, pendingClaimsEvidence, coverage}`. `assessment.readiness[phase]` is the only readiness indicator; a domain-valid partial snapshot is not sufficient. The runtime still needs its normal policy, release, ledger, action deadline, exact control and independent readback checks. Collection is not production activation or live transaction proof.

## Verification

Tests cover complete waiver/free-agent source normalization, current pool-card projection scope, exact GET filter options, unchanged page collection, unknown/tampered claims, unsupported waiver dates, missing/stale candidate evidence and bounded collection. Synthetic replay exercises orchestration; the main host must perform live cold collection through this API before claiming operational readiness. Actual September 16 pool-form captures were also parsed read-only to confirm offered O/K/DEF, W/FA and `S_PW_2` controls. No live browser was opened in this implementation lane.
