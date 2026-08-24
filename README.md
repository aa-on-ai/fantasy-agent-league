# Fantasy Agent League

Fantasy Agent League is an open-source framework for autonomous fantasy football managers that compete under public, reviewable rules.

The first platform target is Yahoo Fantasy Sports. The core remains platform-neutral so other adapters can be added without changing league policy or agent behavior.

## Current status

This repository is an early public scaffold.

- The league constitution has a first draft.
- Two manager profiles and a shared manager contract are present.
- The policy validator protects team ownership, trade restrictions, and published action windows.
- The Yahoo adapter exposes an explicit capability manifest.
- A local dry-run command can exercise a manager profile against a sanitized snapshot.
- The Yahoo network path is implemented with read-only requests but has not been proven against a live account.
- No Yahoo account is connected.
- No live roster action is implemented or authorized.
- No credentials or private league state belong in this repository.

## Why this is public

Agent teams change the competitive shape of a league. Their rules, permissions, schedules, strategies, tests, and deployed versions should be visible to every manager.

The repository provides three forms of accountability.

1. Humans review every behavior change through a pull request.
2. The live season runs a pinned release instead of automatically following `main`.
3. Verified actions produce public summaries after competitive information is no longer sensitive.

## Repository map

- `constitution/` contains the league-facing agreement.
- `agents/` contains the shared manager contract and declared strategies.
- `src/core/` contains deterministic league-policy enforcement.
- `src/platforms/` contains platform-neutral contracts and adapters.
- `platforms/yahoo/` contains Yahoo integration notes and proof requirements.
- `test/` contains behavioral tests and future historical replays.
- `docs/` contains governance and security boundaries.

## Development

Use Node.js 22 or newer.

```bash
npm install
npm test
```

The project uses the built-in Node.js test runner and TypeScript. Tests exercise public behavior at the policy and platform boundaries.

## Read-only dry run

Run the full local path against the public sanitized fixture:

```bash
npm run dry-run -- \
  --fixture test/fixtures/yahoo/sanitized-snapshot.json \
  --manager steady
```

The command prints a deterministic run report. Dry-run reports always return `no_action`; this slice proves snapshot intake, sanitization, hashing, manager selection, and orchestration without making a Yahoo write.

Live read mode uses a short-lived `YAHOO_ACCESS_TOKEN` injected through the runtime environment. The token is never accepted as a command-line argument. With the token already present, provide the league and team keys through the environment or command flags:

```bash
YAHOO_LEAGUE_KEY=461.l.example \
YAHOO_TEAM_KEY=461.l.example.t.1 \
npm run dry-run -- --manager steady
```

The live path performs authenticated `GET` requests for the league and team roster, converts Yahoo's response into an allowlisted snapshot, then emits the same `no_action` report. It remains unverified until the league approves a Yahoo application and the read proof runs against a disposable identity.

## Yahoo-first plan

Yahoo documents a REST-style Fantasy Sports interface using delegated account authorization. The official guide allows applications to request read or read-and-write Fantasy Sports access.

1. Prove league, team, player, waiver, and matchup reads.
2. Normalize Yahoo data into platform-neutral domain types.
3. Replay a completed week without any Yahoo writes.
4. Prove lineup changes in a disposable test context.
5. Prove add, drop, waiver, and transaction verification paths.
6. Treat draft automation as a separate capability.

Read the [Yahoo Fantasy Sports guide](https://developer.yahoo.com/fantasysports/guide/) and [Yahoo authorization flow](https://developer.yahoo.com/oauth2/guide/flows_authcode/) before working on the adapter.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Agents may open issues and draft pull requests. Only humans may approve, merge, or move the live seasonal release.

## License

Apache License 2.0.
