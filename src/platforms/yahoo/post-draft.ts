import { digest } from "../../manager/season.js";
import { readDesktopRoster, readDesktopRules, readDesktopDrops, readDesktopPool, readDesktopTransactions,
  type DesktopBinding, type NativeObservation } from "./desktop-season.js";

export interface PostDraftObservations {
  roster: NativeObservation;
  rules: NativeObservation;
  drops: NativeObservation;
  pool: NativeObservation;
  transactions: NativeObservation;
}
export function extractPostDraft(observations: PostDraftObservations, binding: DesktopBinding, now = new Date()) {
  // Each surface fails independently so a missing transaction-control page does
  // not discard a useful, verified roster. This artifact confers no capability.
  const section = <T>(read: () => T): { status: "pass"; value: T } | { status: "blocked"; code: string } => {
    try { return { status: "pass", value: read() }; }
    catch (e) {
      const code = e instanceof Error && /^[a-z_]+$/.test(e.message) ? e.message : "invalid_native_input";
      return { status: "blocked", code };
    }
  };
  const roster = section(() => readDesktopRoster(observations.roster, observations.rules, binding, now));
  const rules = section(() => readDesktopRules(observations.rules, binding, now));
  const drops = section(() => {
    const result = readDesktopDrops(observations.drops, binding, now);
    if (roster.status !== "pass" || digest(result.map(p => p.key).sort()) !== digest(roster.value.players.map(p => p.key).sort())) throw new Error("drop_roster_identity_mismatch");
    return result;
  });
  const pool = section(() => readDesktopPool(observations.pool, binding, now));
  const transactions = section(() => readDesktopTransactions(observations.transactions, binding, now));
  return { schemaVersion: 1, proofScope: "post_draft_native_read_only", extractedAt: now.toISOString(),
    leagueId: binding.leagueId, teamId: binding.teamId, rosterActionsEnabled: false, executionEligible: false,
    roster, rules, drops, pool, transactions,
    executionBlockers: ["native_control_transport_unverified", "dated_player_lock_evidence_required", "isolated_disposable_context_required",
      "pending_claim_confirmation_unobserved", "pool_weekly_projections_unobserved", "release_not_adopted"] };
}
