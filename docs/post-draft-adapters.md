# Post-draft extraction and guarded adapters

This is an agent-drafted implementation artifact for Aaron's review. It enables
no Yahoo writes, alters no schedules, and adopts no release or strategy policy.

## Extraction

`desktop-season.ts` consumes full native Safari accessibility captures, binds the
primary Yahoo document and My Team link, excludes nested advertising documents,
and checks freshness independently for each surface. It extracts the observed
roster tables, primary positions, assignments, projections, injury labels, bye
weeks, game-time text, rolling-waiver rules, drop glyphs, a bounded pool page and
the transaction feed. Multiline Description, Value and edit-label identity must
agree. Numeric header text such as `4 Dwn Stops` is not an accessibility node.

Current lineup legality checks slot count, eligibility, bench and roster capacity.
A questionable label is retained without falsely declaring the lineup illegal.
Unsupported occupied injury slots require a separate eligibility check. Missing
tables, projections, identity, or game-time zone fail closed. Displayed player
name plus professional team is explicitly a native lookup key; Yahoo player IDs
remain null because this capture format did not expose them.

`post-draft.ts` produces a partial read-only packet when an independently read
surface is blocked. The reusable command, after building, is:

```sh
node dist/src/cli/season-extract.js --observations runtime/private/native-observations.json --binding runtime/private/native-binding.json --output runtime/private/post-draft-extraction.json
```

The observations file contains `roster`, `rules`, `drops`, `pool` and `transactions`,
each with the actual `capture` and `capturedAt`. Binding contains string league
and team IDs, team name and a positive maximum source age. Output is exclusively
created with private permissions. It is always marked `executionEligible: false`.
This command performs no native interaction. It never substitutes historical
player points for current-week projections or turns a date-only waiver label
into a processing deadline. A pool page is explicitly a sample, not all players.
No recent transactions does not establish an empty pending-claims queue.

## Guarded domain adapters

`runGuardedNativeAction` wraps the existing coordinator and durable ledger. Its
host-owned transport supplies normalized, fresh native state, a reviewed atomic
preparation, a final gesture and a separate readback. This is a trusted adapter
boundary: a caller must derive the normalized state and pending claims from the
captured sources. The interface and its sanitized fake-transport tests are not
proof of a real host implementation or its source normalization.

All writes to competitive league 425299 are hard blocked in this slice. Other
contexts require exact disposable league/team/profile binding, action fingerprint,
recorded owner approval, expiration, verified isolation/recovery, the coordinator's
release pin and capabilities, and the published action window. A browser-owner
ledger spans the team coordinator, and the native capture's window ID must match
the configured window through readback, so concurrent participating routines cannot
share the same native surface. Every host routine must use that same ledger;
an unrelated user or application can still change the foreground window.

The existing team ledger records pending before preparation/submission and
blocks other actions while unresolved. Preparation must represent a proven
atomic action. Multiple sequential lineup edits are not an atomic lineup update.
Source freshness, player deadlines, approval, stop state and the action window
are rechecked after preparation and immediately before the transport's final
gesture. The transport must invoke the guard at that final boundary. This code
cannot certify an arbitrary implementation that violates its contract.

Lineup readback checks the full requested assignment and unchanged roster
identity. Add/drop readback checks both ownership changes and every retained
player. A waiver submission requires an independently captured, fresh, owned and
normalized pending-claim page with the exact add/drop pair, period and claim ID;
it does not require ownership before processing. Its page URL remains unset until
observed in the disposable environment. A click, response status, empty feed,
cached observation or ambiguous result cannot satisfy verification. Pending or
uncertain actions reconcile independently without automatic resubmission.

## Native evidence and remaining implementation boundary

Native evidence showed a selected lineup slot and highlighted eligible swap
targets. Accessibility text did not distinguish every visually disabled target.
Drop glyphs were independently visible as blue minus or red prohibited controls,
but the saved full drop capture shortened its primary document URL to an ellipsis.
The strict parser therefore rejects that capture; it does not reconstruct the
missing URL from expectation. A subsequent attempted drop read found a different
Safari window on Start Page. The next independent team read was owned and valid;
further native navigation stopped because exclusive window ownership was not
established. No source or receipt was rewritten to conceal those failures.

No transaction confirmation or pending-claim page was submitted or tested. The
native host transport, explicit eligible-target readback, full dated player lock
evidence, candidate weekly projections and pending-claim normalization must be
completed from the approved disposable controls before the adapter can be wired.
The code does not claim to have an executable unattended Yahoo writer.

## Concrete approvals still required

1. **Disposable environment and session.** Aaron provisions or explicitly approves
   provisioning a free private roster league named `Fantasy agent acceptance sandbox
   2026`, separate from league 425299, with every participating team designated
   disposable by its owner. It must have a completed draft, active scoring period,
   rolling waivers and genuinely replaceable roster players. No public competitive
   team or draft mock qualifies. Record the actual league/team IDs after creation;
   none currently exists in the inspected account. No fees, prize contest, public
   league enrollment or invitations are included. Use a dedicated Safari profile
   named `Fantasy disposable` and a host-owned test login. Aaron authorizes those
   precise profile/authentication changes and completes any required human login
   steps. Never copy observer cookies or sign it out. Prove recovery on that route.
2. **Exact bounded transaction test.** Once populated disposable controls and IDs
   are observed, Aaron authorizes one lineup swap, one add/drop and one rolling
   claim in that isolated context, with a UTC window/expiry, source version and
   recovery plan. Codex selects the players and binds each concrete action to its
   fingerprint under that authority; Aaron is not asked to choose players. The permitted maximum is one submitted action per
   approved fingerprint, with independent readback and no automatic retries.
   Separate approval covers any cancellation/reversal; it is not implied by a
   successful test. Retain stop and failure receipts. This approval excludes the
   competitive league even if its configuration flag changes.
3. **Scheduled disposable action proof.** Aaron approves one bounded execution of
   those same actions through the intended scheduler, on the exact isolated route,
   with the shared native lock, private failure delivery, stop-file checks and
   independent applied-state readback. Preserve the daily 09:00 observer and the
   paused read-proof test. This is a new action proof, not a repetition of setup.
4. **Strategy, immutable release and activation.** Codex owns source selection,
   workload/news interpretation and football decisions under the declared Steady
   strategy. Aaron does not choose players or football-policy weights. The sourced
   Codex packet route is in `codex-season-run.md`; the numerical horizon planner
   is optional, not a required human coaching step. Following
   successful disposable proofs, he reviews and adopts an exact immutable commit
   and its evidence. Competitive release requires a separately reviewed change to
   the current hard block, exact team-11 capability/configuration authorization,
   and explicit activation of only the materialized routines and windows in
   `season-routines.md`. No merge, release pin, write flag or schedule change is
   authorized by this artifact. The current uncommitted diff is not a release pin.

The immediate owner concern is the earliest actual player lock in the private
roster report. A legal observed lineup does not remove the need for a fresh injury
check before its players lock. This artifact makes no strategic roster proposal.

## Native driver continuation — September 9

The observed waiver selection/review flow now has a native App driver in
`src/platforms/yahoo/native-driver.ts`. It binds numeric player IDs from stage-2
links and exact confirmation wording, and re-resolves controls before the guarded
final gesture. A live inspection was cancelled before submission. Free-agent
confirmation and the independent pending-claims producer remain explicitly
unavailable pending the disposable context above. See `codex-season-run.md`.
