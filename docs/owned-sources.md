# Owned Chrome manager sources

`src/platforms/yahoo/owned-sources.ts` is a read-only source lane. The parent owns the Playwright `Page`, profile lease, navigation, runtime, and every Yahoo mutation. This module does not connect to a browser, launch a profile, install a schedule, submit an action, or enable writes.

## Integration contract

```ts
const roster = await captureOwnedObservation(page, profileId);
// Parent performs the observed read-only navigation to rules, pool, drops,
// player notes, transactions, and actual pending queue as required.
const assessment = normalizeOwnedAssessment({
  roster, rules,
  // pools, drops, playerDetails, transactions, pendingClaims
}, {
  leagueId, teamId, teamName, profileId, maxAgeMs,
  period, // optional expected week
  season, // optional explicitly bound season, supports January games
}, "lineup", now);
```

Exports:

- `OwnedObservation` / `OwnedSourceObservation`: `{ observationId, capturedAt, profileId, url, dom }`.
- `OwnedDomCapture`, `OwnedRow`, `OwnedLink`, `OwnedControl`: structured tables, visible table cells, DOM attributes, links, controls, selected option values, headings, and forms. This is DOM evidence, never native CUA or native accessibility evidence.
- `captureOwnedObservation(page, profileId, clock?)`: creates a unique observation id and rejects a document change during its read.
- `readOwnedDom(page)`: read-only extraction. Hidden/password input values are not captured; only explicitly allowlisted numeric form identity fields are retained; link query parameters use a bounded public route-state allowlist.
- `importOwnedCapture(raw, profileId)`: explicit adapter for the parent's September 15 JSON captures. It preserves captured time and handles header-row arrays plus the original `attrs`/`ariaLabel` representation.
- `readOwnedRules`, `readOwnedRoster`, `readOwnedPool`, `readOwnedDrops`, `readOwnedTransactions`, `readOwnedPendingClaims`, `readOwnedPlayerDetails`: separately testable pure parsers.
- `normalizeOwnedAssessment(input, binding, phase, now?)`: returns `{ snapshot, sources, gaps, readiness, lineupDeadlines, acquisitionDeadlines, roster }`.

A domain-valid snapshot can exist while manager readiness is false. This deliberately permits sandbox transaction validation with roster/rules/deadline evidence without pretending that missing news constitutes a complete manager context. Consumers must check `readiness[phase]` and run the existing manager-context validator before a model decision. Keep the actual evidence envelope with an action's readback.

The integrating release needs the parent's explicit `Player.status = "doubtful"` domain extension. An observed `D` is never mapped to out, active, or questionable. This lane retains the original injury label. Without that extension, production's current doubtful player causes the existing snapshot validator to reject the snapshot.

## Current observed schemas

The September 15 parent captures establish:

- Roster: named Offense/Kickers/Defense roster captions bind team and week. Explicit `Proj Pts` columns distinguish projections from actual fantasy scores. Numeric ids come from sports player links and matching `data-ys-playerid`; defense id is independently observed in the same attribute.
- Ownership: exact HTTPS Yahoo league/team route, independent `My Team` link, profile binding, and observation time are required. Unknown edit controls remain unknown, not implicitly locked or unlocked.
- Rules: legal slots, bench/IR counts, rolling waiver configuration, bench locking, all setting rows, and the observed scoring rows are retained. A rules capture lacking scoring cannot establish manager readiness.
- Schedule: game links contain the actual calendar date, such as `...-20260920006/`. It is paired with the row's displayed kickoff and explicit EDT/EST label; weekday, date, and IANA New York offset are cross-checked. A bare `Sun 1:00 pm` never becomes a guessed deadline.
- Drops: permission requires the observed `Click to drop this player` button, enabled state, and exact `data-check-box-value` id. A missing control is unknown.
- Pool: actual selected `stat1=S_PW_<week>` is required for `Fan Pts` to mean a projection. FA and waiver labels stay distinct. A page is a bounded sample, not the entire available universe. Empty requires an explicit `No players found` observation; a missing table is not empty.
- Player details: the unique selected `.player-name` link must match the expected name and independently observed roster player id. `Latest News` and the game-log table must exist. News publication labels remain literal, not replaced by capture time. Explicit no-news text retains its ten-day lookback. Future-week game-log projections form acquisition-horizon evidence, not invented season grades.
- Transactions: an observed feed remains separate from pending claims.

## Known unsupported evidence

Populated pending-claim queues and precise waiver-submission deadline semantics have not yet been supplied to this lane. The pending-claim parser requires a caller-supplied previously observed exact queue URL and distinguishes unobserved from an explicit empty queue. It does not invent a route, normalize arbitrary rows as claims, or treat transactions as a claim queue. Waiver readiness stays false until that evidence-backed implementation exists.

Completed/in-progress game rows without an independently dated kickoff, unknown drop prohibitions, and unsupported injury labels also remain explicit gaps. An available-player news link is not a news observation. A stale or selected-player-ambiguous modal does not cover that player.

The collection module establishes source parsing, not live action correctness or unattended-operation acceptance. Native transport receipts are not fabricated from this DOM structure.

## Verification and provenance

The parser was exercised directly against the parent's private September 15 sandbox roster/settings/drop/pool and Dak player-detail JSON captures. Sandbox roster+rules produced a valid four-player, three-slot snapshot with all four dated deadlines; missing per-player news correctly kept manager readiness false. The Dak modal yielded sixteen observed game-log rows and a news excerpt. Other modal captures with missing selected-player identity were rejected and reported to the parent for a bounded evidence repair.

Fixtures under `test/fixtures/owned-sources/` preserve the observed DOM shape but replace league/team context with `100/1`, `Example Team`, and `fixture-profile`. They omit raw page/account text, global forms, and account navigation. The test news payload is a synthetic explicit-empty protocol case, not a claimed live no-news outcome.

`npm test`: 130 tests passed, including twelve focused owned-source tests. Tests cover identity mismatch, profile mismatch, stale/future observations, wrong periods, unobserved projections, date conflicts, independent drops, unknown versus explicit empty, selected-player binding, and same-millisecond independent captures. Live Yahoo mutation proof belongs to the parent and action lane.
