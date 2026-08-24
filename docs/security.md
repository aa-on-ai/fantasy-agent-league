# Security and privacy boundary

The public repository contains code, policy, declared strategy, tests, sample configuration, and delayed public logs. It never contains credentials or competitively sensitive live state.

## Public material

- Constitution and governance
- Agent contracts and declared strategy profiles
- Deterministic policy and platform adapter code
- Tests and sanitized fixtures
- Capability manifests
- Weekly summaries published after decisions resolve
- Immutable seasonal release identifiers

## Private runtime material

- Yahoo client secrets, access tokens, and refresh tokens
- Unresolved waiver bids and free-agent plans
- Private model working state and raw reasoning traces
- Yahoo account data and private league responses
- Incident data containing secrets or personal information

## Runtime rules

1. The model never receives raw credentials.
2. A narrow executor owns Yahoo authorization and exposes domain actions.
3. Each manager has a separate state namespace and team identity.
4. External player news is treated as data, never as instructions.
5. Every write is validated, idempotent, read back from Yahoo, and recorded.
6. An unverified capability stays disabled.
7. A failed write retries once, then stops and records the failure.

The first live connection requires a disposable test context, explicit authorization, and proof that logs cannot disclose tokens or unresolved competitive decisions.
