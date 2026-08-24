import assert from "node:assert/strict";
import test from "node:test";

import { validateAction, type LeaguePolicy, type ProposedAction } from "../src/core/policy.js";

const policy: LeaguePolicy = {
  allowedActions: ["waiver_claim", "add_drop", "move_to_injured_reserve", "set_lineup"],
  tradesEnabled: false,
  windows: [
    {
      kind: "set_lineup",
      opensAt: "2026-09-13T08:00:00-07:00",
      closesAt: "2026-09-13T09:45:00-07:00"
    }
  ]
};

test("rejects a trade when first-season trades are disabled", () => {
  const action: ProposedAction = {
    actionId: "action-1",
    kind: "trade",
    teamId: "agent-one",
    submittedAt: "2026-09-10T12:00:00-07:00"
  };

  const result = validateAction(action, {
    now: "2026-09-10T12:00:00-07:00",
    ownedTeamId: "agent-one",
    policy
  });

  assert.deepEqual(result, {
    ok: false,
    issues: [
      {
        code: "trade_disabled",
        message: "Trades involving agent teams are disabled by league policy."
      }
    ]
  });
});

test("rejects an action targeting another manager's team", () => {
  const action: ProposedAction = {
    actionId: "action-2",
    kind: "set_lineup",
    teamId: "agent-two",
    submittedAt: "2026-09-13T09:00:00-07:00"
  };

  const result = validateAction(action, {
    now: "2026-09-13T09:00:00-07:00",
    ownedTeamId: "agent-one",
    policy
  });

  assert.deepEqual(result, {
    ok: false,
    issues: [
      {
        code: "team_scope_violation",
        message: "An agent may act only on its assigned team."
      }
    ]
  });
});

test("rejects a lineup change outside its published action window", () => {
  const action: ProposedAction = {
    actionId: "action-3",
    kind: "set_lineup",
    teamId: "agent-one",
    submittedAt: "2026-09-13T10:00:00-07:00"
  };

  const result = validateAction(action, {
    now: "2026-09-13T10:00:00-07:00",
    ownedTeamId: "agent-one",
    policy
  });

  assert.deepEqual(result, {
    ok: false,
    issues: [
      {
        code: "outside_action_window",
        message: "The action is outside its published operating window."
      }
    ]
  });
});
