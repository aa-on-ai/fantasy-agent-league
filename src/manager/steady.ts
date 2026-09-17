import { bestLineup, digest, validateDecision, validateSnapshot, type Binding, type Decision, type Player, type SeasonSnapshot } from "./season.js";

export interface SteadyPolicy {
  workloadPenaltyPoints: number;
  minimumHorizonGain: number;
  minimumWaiverHorizonGain: number;
  maximumCurrentWeekLoss: number;
  maxSourceAgeMs: number;
}
export interface Outlook {
  id: string;
  workload: "secure" | "uncertain" | "limited";
  newsResolved: boolean;
  sources: Array<{ reference: string; observedAt: string }>;
  weeks: Array<{ period: string; projectedPoints: number; playable: boolean; bye: boolean }>;
}
export interface SteadyEvidence {
  schemaVersion: 1;
  snapshotHash: string;
  capturedAt: string;
  periods: string[];
  outlooks: Outlook[];
}

function validateEvidence(value: unknown, s: SeasonSnapshot, policy: SteadyPolicy, binding: Binding, now: Date): SteadyEvidence {
  const fail = (): never => { throw new Error("steady_evidence_missing_or_conflicting"); };
  const e = value as SteadyEvidence;
  const age = now.getTime() - Date.parse(e?.capturedAt);
  if (!e || e.schemaVersion !== 1 || e.snapshotHash !== s.hash || !Number.isFinite(age) || age < 0 || age > binding.maxAgeMs ||
      !Array.isArray(e.periods) || e.periods.length < 2 || e.periods.length > 18 || e.periods[0] !== s.period ||
      e.periods.some(p => typeof p !== "string" || !p) || new Set(e.periods).size !== e.periods.length || !Array.isArray(e.outlooks)) return fail();
  const players = [...s.roster, ...s.available];
  if (e.outlooks.length !== players.length || new Set(e.outlooks.map(p => p?.id)).size !== players.length) return fail();
  for (const p of players) {
    const o = e.outlooks.find(o => o?.id === p.id);
    if (!o || !["secure", "uncertain", "limited"].includes(o.workload) || typeof o.newsResolved !== "boolean" ||
        !Array.isArray(o.sources) || !o.sources.length || !Array.isArray(o.weeks) || o.weeks.length !== e.periods.length) return fail();
    for (const source of o.sources) {
      const sourceAge = now.getTime() - Date.parse(source?.observedAt);
      if (!source || typeof source.reference !== "string" || !source.reference.trim() || !Number.isFinite(sourceAge) ||
          sourceAge < 0 || sourceAge > policy.maxSourceAgeMs) return fail();
    }
    for (const [i, period] of e.periods.entries()) {
      const w = o.weeks[i];
      if (!w || w.period !== period || !Number.isFinite(w.projectedPoints) || typeof w.playable !== "boolean" || typeof w.bye !== "boolean" ||
          (w.bye && w.playable)) return fail();
      if (i === 0 && (w.projectedPoints !== p.projectedPoints || w.playable !== (["active", "questionable", "doubtful"].includes(p.status) && !w.bye))) return fail();
    }
  }
  return e;
}

// Proposed deterministic Steady behavior. All outlook/news inputs are supplied
// with provenance; this module neither generates forecasts nor reads narrative instructions.
export function planSteady(s: SeasonSnapshot, evidence: unknown, binding: Binding, policy: SteadyPolicy,
  phase: "lineup" | "free_agents" | "waivers", now = new Date()): { decision: Decision; evidenceHash: string } {
  validateSnapshot(s, binding, now);
  if (!policy || [policy.workloadPenaltyPoints, policy.maximumCurrentWeekLoss].some(x => !Number.isFinite(x) || x < 0) ||
      [policy.minimumHorizonGain, policy.minimumWaiverHorizonGain, policy.maxSourceAgeMs].some(x => !Number.isFinite(x) || x <= 0) ||
      policy.minimumWaiverHorizonGain < policy.minimumHorizonGain) throw new Error("invalid_steady_policy");
  const e = validateEvidence(evidence, s, policy, binding, now);
  const result = (decision: Decision) => ({ decision, evidenceHash: digest(e) });
  // Unresolved news is an input gap, not a signal to guess an injury or silently use the baseline.
  if (e.outlooks.some(o => !o.newsResolved)) return result({ kind: "no_action", reason: "unresolved_player_news" });
  const outlook = new Map(e.outlooks.map(o => [o.id, o]));
  const adjusted = (p: Player, index: number): Player => {
    const o = outlook.get(p.id)!; const w = o.weeks[index]!;
    return { ...p, availability: "rostered", slot: index ? null : p.slot, locked: index ? false : p.locked,
      status: w.playable && !w.bye ? ["questionable", "doubtful"].includes(p.status) && !index ? p.status : "active" : "out",
      projectedPoints: w.projectedPoints - policy.workloadPenaltyPoints * ({ secure: 0, uncertain: 1, limited: 2 }[o.workload]) };
  };
  if (phase === "lineup") {
    const best = bestLineup({ ...s, roster: s.roster.map(p => adjusted(p, 0)) });
    if (!best) return result({ kind: "no_action", reason: "no_complete_legal_lineup" });
    if (s.slots.every(slot => s.roster.find(p => p.slot === slot.id)?.id === best.lineup[slot.id])) {
      return result({ kind: "no_action", reason: "steady_lineup_already_set" });
    }
    const decision: Decision = { kind: "set_lineup", lineup: best.lineup,
      projectedPoints: Object.values(best.lineup).reduce((sum,id)=>sum+s.roster.find(p=>p.id===id)!.projectedPoints,0) };
    if (validateDecision(s, decision).length) throw new Error("steady_decision_invalid");
    return result(decision);
  }
  const horizon = (roster: Player[]) => e.periods.map((_, i) => bestLineup({ ...s, roster: roster.map(p => adjusted(p, i)) }));
  const base = horizon(s.roster);
  if (!base[0]) return result({ kind: "no_action", reason: "incomplete_lineup_requires_review" });
  const kind = phase === "waivers" ? "waiver_claim" : "add_drop";
  const minimum = kind === "waiver_claim" ? policy.minimumWaiverHorizonGain : policy.minimumHorizonGain;
  let best: { decision: Decision; coverageGain: number; horizonGain: number } | undefined;
  for (const add of [...s.available].sort((a,b)=>a.id.localeCompare(b.id))) {
    if (add.availability !== (kind === "waiver_claim" ? "waivers" : "free_agent")) continue;
    for (const drop of [...s.roster].sort((a,b)=>a.id.localeCompare(b.id))) {
      const proposal: Decision = { kind, addId: add.id, dropId: drop.id, improvement: 0 };
      if (validateDecision(s, proposal).length) continue;
      const next = horizon([...s.roster.filter(p=>p.id!==drop.id),{...add,availability:"rostered"}]);
      if (!next[0] || next[0].projectedPoints - base[0].projectedPoints < -policy.maximumCurrentWeekLoss) continue;
      // Preserve every currently coverable week; scarce positions and bye coverage
      // are evaluated through exact legal assignments rather than position counts.
      if (base.some((week,i)=>week && !next[i])) continue;
      const coverageGain = next.filter(Boolean).length-base.filter(Boolean).length;
      const horizonGain = next.reduce((sum,w)=>sum+(w?.projectedPoints??0),0)-base.reduce((sum,w)=>sum+(w?.projectedPoints??0),0);
      if (horizonGain < minimum) continue;
      if (!best || coverageGain > best.coverageGain || (coverageGain === best.coverageGain && horizonGain > best.horizonGain)) {
        best={decision:{...proposal,improvement:horizonGain},coverageGain,horizonGain};
      }
    }
  }
  return result(best?.decision ?? {kind:"no_action",reason:"no_sourced_horizon_improvement"});
}
