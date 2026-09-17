# Season acceptance

## Local verification

```sh
npm ci
npm test
node --test scripts/*.test.mjs
```

The TypeScript suite covers source completeness, decision validation, stale-state rejection, duplicate/uncertain submissions, team ownership, persistent identity, manager transport, independent outcomes and default-off releases. Script tests cover browser readiness boundaries. Passing these checks is not live transaction proof.

## Executable interfaces

- `npm run agent:readiness`: read-only observation of the assigned already-open Safari team tab.
- `npm run agent:plan -- --snapshot <private-snapshot.json> --config <private-binding.json> --phase lineup`: proposal-only mechanical baseline, not the persistent manager's judgment.
- `npm run agent:review`: export or validate a source-bound manager packet without execution.
- [Owned lineup host](owned-lineup-operational-release.md): explicit inspect or execute mode, one atomic swap.
- [Owned acquisition host](owned-acquisition-operational-release.md): explicit inspect or execute mode, one phase-bound acquisition.

## Proof and release boundary

Each live capability requires its own original sandbox captures, exact submission receipt and independent platform readback. Waiver proof cannot authorize a pickup. Synthetic or minimized regression fixtures cannot substitute for privately reviewed operational evidence. Both the release manifest and season write switch must be enabled under the exact approved scope before any production action.

A crash or ambiguous outcome leaves the ledger unresolved. Recovery requires independent evidence and explicit reconciliation; absence of a success receipt is not permission to retry. Emergency stop is rechecked immediately before submission. Source/SHA pins, evidence, scope and action windows remain mandatory.

Merging to main does not change the pinned live season. Deployment, scheduler activation and a fresh operational readback are separate from this code-verification milestone. See [implementation map](finish-automatic-manager.md) and [governance](governance.md).
