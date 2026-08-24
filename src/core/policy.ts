export type ActionKind =
  | "draft"
  | "waiver_claim"
  | "add_drop"
  | "move_to_injured_reserve"
  | "set_lineup"
  | "trade";

export interface ProposedAction {
  actionId: string;
  kind: ActionKind;
  teamId: string;
  submittedAt: string;
}

export interface PolicyWindow {
  kind: ActionKind;
  opensAt: string;
  closesAt: string;
}

export interface LeaguePolicy {
  allowedActions: readonly ActionKind[];
  tradesEnabled: boolean;
  windows: readonly PolicyWindow[];
}

export interface ValidationContext {
  now: string;
  ownedTeamId: string;
  policy: LeaguePolicy;
}

export interface ValidationIssue {
  code: "action_not_allowed" | "outside_action_window" | "team_scope_violation" | "trade_disabled";
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: readonly ValidationIssue[];
}

export function validateAction(action: ProposedAction, context: ValidationContext): ValidationResult {
  if (action.teamId !== context.ownedTeamId) {
    return {
      ok: false,
      issues: [
        {
          code: "team_scope_violation",
          message: "An agent may act only on its assigned team."
        }
      ]
    };
  }

  if (action.kind === "trade" && !context.policy.tradesEnabled) {
    return {
      ok: false,
      issues: [
        {
          code: "trade_disabled",
          message: "Trades involving agent teams are disabled by league policy."
        }
      ]
    };
  }

  if (!context.policy.allowedActions.includes(action.kind)) {
    return {
      ok: false,
      issues: [
        {
          code: "action_not_allowed",
          message: "The action is not allowed by league policy."
        }
      ]
    };
  }

  const now = Date.parse(context.now);
  const insideWindow = context.policy.windows.some(
    (window) =>
      window.kind === action.kind && now >= Date.parse(window.opensAt) && now <= Date.parse(window.closesAt)
  );

  if (!insideWindow) {
    return {
      ok: false,
      issues: [
        {
          code: "outside_action_window",
          message: "The action is outside its published operating window."
        }
      ]
    };
  }

  return { ok: true, issues: [] };
}
