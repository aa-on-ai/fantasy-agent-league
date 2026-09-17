# Same-actor manager decision transport

`createOpenClawManagerDecide` in `src/runtime/openclaw-manager.ts` supplies
`SeasonRunOptions.decide` or `OwnedSeasonTaskOptions.decide`. It never validates a
football choice by itself, executes a Yahoo action, initializes participant state,
changes runtime config, or installs a schedule. The existing runner owns those
boundaries. Production hard blocks remain unchanged.

```js
const decide = createOpenClawManagerDecide({
  directory: join(privateDirectory, 'openclaw-manager-runs'),
  emergencyStopPath,
  // Optional: rpc, clock, timeoutMs (default 240000, max 300000), waitMs (25000).
});
```

For a fresh request produced by the existing collector and review preparer:

```sh
npm run build
node scripts/owned-manager-run.mjs runtime/private/owned-reviews/REVIEW/request.json
```

The script loads the existing canonical participant and requires the same current
continuity hash. It calls `runSeasonManager` in review-only mode and returns its
receipt. Its local path is not remote review evidence. Scheduled collection can
instead supply this adapter directly to `runOwnedSeasonTask`; no manual response
copying is needed. Parent integration and live Gateway verification are separate
from the mocked tests of this module.

## Installed, inspected public contract

Source inspected under OpenClaw `2026.9.4`, installed at
`/Users/moltbot/.openclaw-update-stage/2026.9.4-20260913/source/openclaw-2026.9.4`:

- `src/cli/gateway-cli/register.ts`: `gateway call METHOD --params JSON --json --timeout MS`.
  The CLI's read-only shared-state initialization is not a ban on mutating RPCs.
  Gateway authorizes the method using inherited runtime credentials. This adapter
  never reads or supplies a credential, token, URL override, model, or provider.
- `packages/gateway-protocol/src/schema/agent.ts` and
  `src/gateway/agent-turn/agent-request-routing.ts`: public `agent` accepts the
  exact actor and an existing `sessionId`; omission of `sessionKey` resolves that
  existing ID and rejects missing/ambiguous resolution. `expectedExistingSessionId`
  is backend-only (`agent-expected-session.ts`) and is deliberately not used.
- `src/gateway/server-methods/chat-history-handler.ts`: supported `chat.history`
  returns `sessionKey`, `sessionId`, `sessionInfo.hasActiveRun`. Only a one-message
  request is made; the adapter uses metadata, not message text or private files.
- `src/gateway/agent-turn/agent-request-preflight.ts`: `idempotencyKey` is the run
  ID. `agent-turn-service.ts` exposes `agent.wait` with run ID, status, terminal
  reply/receipt, ending time, warnings and failure state.
- `src/agents/agent-run-terminal-reply.ts`: producer terminal text is sanitized
  and capped to 4096 characters. The prompt requests under 3500; truncated,
  missing, non-JSON or mismatched replies fail closed. The exact text delivered
  by that supported API is persisted, not reconstructed from history.
- `src/agents/agent-run-terminal-receipt.ts`: terminal receipt identifies the
  run, session, turn and requested/effective model route. Wrong identity,
  rerouting, external reply delivery, or error status cannot become success.
  Requested and effective route must both match the currently registered
  `openai/gpt-6-astra`; this is an assertion, never a model override or fallback.

The `agent` RPC avoids the `sessions_send` detached acknowledgement/announcement
flow. It explicitly sets `deliver:false`, `disableMessageTool:true` and the
installed internal channel `webchat`. No A2A ping-pong or publication is requested.
It supplies the public `lane` field as `nested:agent:fantasy-manager:main`, matching
`resolveNestedAgentLaneForSession` used by installed `sessions_send`. Omitting it
can queue the decision behind the calling agent's occupied main lane. The first
live attempt demonstrated that failure and ended with a verified timeout; its
occurrence is retained, never replayed. Cancelled/interrupted pending-input display
records are terminal, not queued work. Incomplete pages or unknown states block.
The live Codex envelope uses `status:ok` with `stopReason:stop` for successful
completion. This normal finish is accepted; abort, timeout, length and unknown
reasons are rejected even if a valid-looking packet is present. The first
scheduled run exposed this separate parser defect; its failed receipt is retained.
The prompt permits a read-only clock for `createdAt`, but no roster/browser/file/
message tool work. This is an instruction boundary, not a new runtime tool policy.

## Failure and replay behavior

One occurrence directory is created exclusively before dispatch. An actor-wide
inflight lock prevents concurrent adapter processes and blocks new occurrences
while a dispatch outcome is unknown. Evidence includes exact request/message,
actor metadata, acceptance, every bounded wait observation, exact returned text,
untrusted parsed packet and terminal receipt, or a sanitized failure record.

The adapter never retries dispatch, even after timeout, process loss, malformed
reply or failure. Repeating the same football run ID fails. Read-only waits are
bounded by both the request window and the configured total wait; stop is checked
between RPCs and before returning output. A stopped or timed-out wait does not
kill or claim cancellation of the existing actor run. Unknown outcomes retain
the lock and require supported run inspection by the owning session. In
particular, `agent.wait` has a 10-minute terminal cache: an old timeout does not
prove the run is still active, absent, or safe to repeat.

After a known terminal result, the lock is released but the occurrence remains
consumed. Wrong/missing terminal provenance still rejects the packet. Any later
separate run's error cannot be mistaken for the bound run's output. The existing
runner's packet validator remains authoritative for source freshness, legality,
creation timestamp, unresolved constraints and action policy.
