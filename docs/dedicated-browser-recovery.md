# Dedicated browser recovery

## September 15 verified access repair

The existing fantasy Chrome profile was already authenticated. A gateway-host
headless launch opened `/f1/425299/11` directly and verified its exact owned
My Team link at 16:19:11 UTC. No sign-in, credential migration, browser restart,
permission change or Yahoo transaction was needed. The prior Safari timeout
therefore does not establish an account-access failure.

`scripts/readiness-owned-browser.mjs` now provides the read-only alternative.
It requires the existing private non-symlink profile, launches its own headless
Chrome context, creates its own page, opens the assigned team directly, verifies
origin/path and ownership, and closes that context. It neither attaches to a
shared browser nor relies on any restored tab. It preserves Chrome's profile
lock and reports busy instead of interrupting another owner. It does not enter
login forms, submit actions, copy authentication or automatically use Safari.

Select it directly with:

```sh
node scripts/agent-readiness.mjs --dedicated-chrome
```

The workspace wrapper `scripts/fantasy-readiness-agent.mjs` now selects this
route by default. Existing daily job `96e32e82-f55a-4c53-8e46-5780d709aced`
still runs the same wrapper, with the same 09:00 America/Los_Angeles schedule,
payload, model, delivery and scope. No scheduler migration or additional job.
The legacy observer CLI without the flag remains Safari-only for diagnosis.

The candidate runner passed a second cold start at 16:22:55 UTC. The unchanged
daily command passed at 16:23:53 UTC, taking about 1.5 seconds from observer
start through wrapper evaluation. Its independently read receipt is
`runtime/private/readiness/2026-09-15T16-23-51.604Z.json`, mode 0600, route
`dedicated_chrome`, assigned team `/f1/425299/11`, both verification flags true.
After the run no dedicated-profile process or singleton lock remained.
All 19 focused observer/wrapper tests passed. Fault tests are simulated, not
live forced logouts or Yahoo outages. The next natural daily run, September 16
at 09:00 Pacific, has not yet occurred. Local changes are not committed/pushed.

## What constitutes the durable manager fix

This is an access repair, not a manager adapter or manager activation. Keep the
existing decision logic, league policy, team identity, ledger, stop controls,
source freshness rules and independent transaction verification. Replace the
remaining dependence on a shared desktop window with an owned browser transport.
Do not relabel DOM captures as native Computer Use evidence.

The concrete next checkpoint is to build the source/action transport for this
already-authenticated dedicated route from observed Yahoo controls, preserving
the existing domain contracts. Use the already-provisioned sandbox league
1659459 and the recorded bounded authorization; do not ask for a new sandbox.
Reconcile any existing pending or submitted actions before testing. Execute and
independently read back the authorized lineup swap, pickup and waiver claim.
Do not expand those counts or repeat an uncertain transaction.

Before unattended manager activation, prove the actual scheduled route can cold
start, read sources, make one bounded decision, execute once and independently
read the result. Duplicate triggers and uncertain submissions must reconcile,
not retry blindly. Expired login or an identity mismatch should give one precise
blocker, not a green report. Health must reflect the last manager outcome, not
only scheduler completion. Use one operational owner and the existing approved
release/activation boundaries. Browser access alone does not clear those gates.

Current `yahooWritesEnabled` remains false. No Yahoo roster or league changes
were made by the September 15 recovery work.
