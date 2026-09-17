# Single-agent preparation for September 8, 2026

## Confirmed scope

Aaron confirmed September 7: eleven human teams and one agent team, $20 entry,
existing league scoring and settings unchanged. This preparation does not change
Yahoo, publish rules, install a schedule, or authorize a roster transaction.

The local starting profile is `agents/steady-manager.md`. It emphasizes reliable
workload, legal lineup coverage and measured waiver spending. The shared manager
contract and constitution remain in force. Selecting it here does not promote a
seasonal release or claim league adoption of a new strategy.

## Prepared browser bootstrap

```sh
npm ci
npm run agent:browser -- --health-check
```

The standalone Playwright bootstrap uses installed Google Chrome with a dedicated
persistent profile under `~/.local/share/fantasy-agent-league/2026/agent-1/browser`.
It does not use the OpenClaw browser plugin, personal Chrome data, cookie imports,
or a network-accessible debugging port. The profile directories are private.
Health-check mode loads only local content. Its result proves browser launch,
not Yahoo authentication or fantasy functionality.

For initial human sign-in, when the dedicated bot account is available:

```sh
npm run agent:browser -- --login
```

This opens Yahoo's sign-in page for the human. Do not enter a personal team account.
Do not send credentials or verification codes to the agent. The command does not
read the login form, cookies or page contents. It does not verify successful sign-in.
If Yahoo requires a human challenge, the human handles it; do not bypass it.

## Inputs still needed

- Yahoo league link and exact agent team identity.
- Dedicated Yahoo account created and joined to that league.
- Observed current scoring, roster slots, waiver type/budget/deadline and lock rules.
- Observed draft type/time and the target team's saved pre-draft rankings.

Read these settings from Yahoo and preserve them. Do not infer reception scoring,
quarterback count, roster size or waiver timing from a twelve-team headcount.
Private league responses and rankings belong outside the public repository.

## Draft work

1. Confirm the assigned team and current settings from the signed-in Yahoo surface.
2. Prepare current, scoring-appropriate rankings under the Steady strategy. Record
   data source and timestamp. Check injuries, unavailable players and duplicates.
3. Save the rankings for the agent team, reopen them and confirm they persisted.
4. Verify Yahoo's own autopick behavior uses those rankings in a disposable/mock
   draft. Do not convert the real league's live draft to a different draft type.

A custom live pick loop is outside this preparation. Yahoo handles autopicks;
the agent prepares its rankings. No player list is final until scoring and current
player information have been verified.

## Season-management work still to implement and prove

The repository does not yet implement a browser roster executor. The login helper
is not one. Build domain operations from observed Yahoo pages, not invented
selectors: lineup, add/drop, waiver and read-back verification. Validate assigned
team, eligibility, locks, league budget and action windows before any write.
No trades, commissioner controls, settings changes or human-directed player picks.

Verify in a disposable test context. An uncertain submission needs read-back before
any retry; never blindly repeat it. Stop on identity mismatch, expired login, a
human challenge, unknown page state or an unverified result.

Only after this proof: bind the scheduled decision runs to the pinned release and
dedicated profile. Derive waiver and kickoff windows from the league and actual
game schedule; do not hardcode a guessed waiver weekday. Keep free-agent reviews
at the agreed fixed daily window, not continuous news monitoring. Install and test
the scheduler and emergency stop separately. No scheduled jobs are installed by
this preparation.

## Readiness boundary

Local browser health, account login, draft preparation and season management are
four separate checkpoints. Passing the first does not pass the others. Aaron owns
the go/no-go judgment under the previously proposed pre-draft reliability rule.
