# Yahoo adapter

Yahoo is the first platform target. The adapter translates Yahoo Fantasy Sports resources into platform-neutral league, team, player, roster, waiver, and transaction types.

## Current capability state

- League, team, and player reads are documented by Yahoo but not yet proven in this repository.
- Lineup, add, drop, waiver, and transaction-verification writes remain unverified and disabled.
- Draft-pick automation remains unknown and outside the first implementation slice.

The executable manifest lives in `src/platforms/yahoo/capabilities.ts`.

## Local dry run

The verified local path uses a sanitized fixture and makes no network request:

```bash
npm run dry-run -- \
  --fixture test/fixtures/yahoo/sanitized-snapshot.json \
  --manager steady
```

The live read path is implemented but not yet verified against a Yahoo account. It accepts a short-lived access token from `YAHOO_ACCESS_TOKEN`, sends authenticated `GET` requests for a league and team roster, allowlists the returned fields, and produces a hashed snapshot. It never accepts a token as a command-line argument and never proposes or submits a Yahoo action.

## First proof

1. Register a Yahoo application with the minimum required Fantasy Sports access.
2. Authorize a disposable test identity outside the repository.
3. Read one test league and normalize it into sanitized fixtures.
4. Verify token refresh without logging any credential material.
5. Exercise one lineup change in a disposable context.
6. Read the roster back and prove that the intended change landed exactly once.
7. Keep every write capability disabled if any step fails.

## References

- [Yahoo Fantasy Sports guide](https://developer.yahoo.com/fantasysports/guide/)
- [Yahoo authorization code flow](https://developer.yahoo.com/oauth2/guide/flows_authcode/)
