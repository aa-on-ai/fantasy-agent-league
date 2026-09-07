import { createHash } from "node:crypto";

export interface Player {
  id: string;
  eligible: string[];
  slot: string | null;
  projectedPoints: number;
  status: "active" | "questionable" | "out" | "injured_reserve";
  locked: boolean;
  canDrop: boolean;
  availability: "rostered" | "free_agent" | "waivers";
}
export interface StarterSlot { id: string; position: string }
export interface SeasonSnapshot {
  schemaVersion: 1;
  leagueId: string;
  teamId: string;
  period: string;
  capturedAt: string;
  hash: string;
  roster: Player[];
  available: Player[];
  slots: StarterSlot[];
  rosterLimit: number;
  waiverType: "rolling";
}
export type Lineup = Record<string, string>;
export type Decision =
  | { kind: "no_action"; reason: string }
  | { kind: "set_lineup"; lineup: Lineup; projectedPoints: number }
  | { kind: "add_drop" | "waiver_claim"; addId: string; dropId: string; improvement: number };
export interface Binding {
  leagueId: string;
  teamId: string;
  maxAgeMs: number;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function snapshotHash(snapshot: Omit<SeasonSnapshot, "hash">): string {
  const { hash: _, ...content } = snapshot as SeasonSnapshot;
  return digest(content);
}

// Validate external JSON before it can reach a planner or executor.
export function validateSnapshot(value: unknown, binding: Binding, now: Date): SeasonSnapshot {
  const fail = (code: string): never => { throw new Error(code); };
  if (!value || typeof value !== "object") return fail("invalid_snapshot");
  const s = value as SeasonSnapshot;
  if (s.schemaVersion !== 1 || typeof s.leagueId !== "string" || typeof s.teamId !== "string" ||
      typeof s.period !== "string" || !s.period || s.waiverType !== "rolling" ||
      typeof s.capturedAt !== "string" || !Array.isArray(s.roster) || !Array.isArray(s.available) ||
      !Array.isArray(s.slots) || !Number.isInteger(s.rosterLimit) || s.rosterLimit < 1 || s.rosterLimit > 24 ||
      s.roster.length > s.rosterLimit || s.slots.length < 1 || s.slots.length > 12 || s.available.length > 500) {
    return fail("invalid_snapshot");
  }
  if (s.leagueId !== binding.leagueId || s.teamId !== binding.teamId) return fail("wrong_team");
  const age = now.getTime() - Date.parse(s.capturedAt);
  if (!Number.isFinite(age) || !Number.isFinite(binding.maxAgeMs) || binding.maxAgeMs <= 0 ||
      age < 0 || age > binding.maxAgeMs) return fail("stale_snapshot");
  const slotIds = new Set<string>();
  for (const slot of s.slots) {
    if (!slot || typeof slot.id !== "string" || !slot.id || typeof slot.position !== "string" ||
        !slot.position || slotIds.has(slot.id)) return fail("invalid_slots");
    slotIds.add(slot.id);
  }
  const ids = new Set<string>();
  const occupied = new Set<string>();
  for (const p of [...s.roster, ...s.available]) {
    if (!p || typeof p.id !== "string" || !p.id || ids.has(p.id) || !Array.isArray(p.eligible) ||
        !p.eligible.length || p.eligible.some(x => typeof x !== "string" || !x) ||
        !Number.isFinite(p.projectedPoints) || typeof p.locked !== "boolean" || typeof p.canDrop !== "boolean" ||
        !["active", "questionable", "out", "injured_reserve"].includes(p.status) ||
        !["rostered", "free_agent", "waivers"].includes(p.availability) ||
        !(p.slot === null || (typeof p.slot === "string" && slotIds.has(p.slot)))) return fail("invalid_player");
    if (p.slot !== null && occupied.has(p.slot)) return fail("duplicate_slot");
    if (p.slot !== null) occupied.add(p.slot);
    if (p.slot !== null && !p.eligible.includes(s.slots.find(x => x.id === p.slot)!.position)) {
      return fail("ineligible_current_slot");
    }
    ids.add(p.id);
  }
  if (s.roster.some(p => p.availability !== "rostered") ||
      s.available.some(p => p.availability === "rostered" || p.slot !== null || p.locked)) return fail("invalid_ownership");
  if (s.hash !== snapshotHash(s)) return fail("snapshot_hash_mismatch");
  return s;
}

export interface LineupResult { lineup: Lineup; projectedPoints: number }

// Exact constrained assignment, including flex slots; never greedy by position.
// The <=24-player bound makes the bit-mask representation safe.
export function bestLineup(snapshot: SeasonSnapshot): LineupResult | null {
  const players = [...snapshot.roster].sort((a, b) => a.id.localeCompare(b.id));
  if (players.length > 24) throw new Error("roster_limit_exceeded");
  const lockedBySlot = new Map(players.filter(p => p.locked && p.slot !== null).map(p => [p.slot!, p]));
  const slots = [...snapshot.slots].sort((a, b) => {
    const count = (slot: StarterSlot) => players.filter(p => p.eligible.includes(slot.position)).length;
    return count(a) - count(b) || a.id.localeCompare(b.id);
  });
  const memo = new Map<string, (LineupResult & { retained: number }) | null>();
  function solve(index: number, used: number): (LineupResult & { retained: number }) | null {
    if (index === slots.length) return { lineup: {}, projectedPoints: 0, retained: 0 };
    const key = `${index}:${used}`;
    if (memo.has(key)) return memo.get(key)!;
    const slot = slots[index]!;
    const fixed = lockedBySlot.get(slot.id);
    let best: (LineupResult & { retained: number }) | null = null;
    for (let i = 0; i < players.length; i++) {
      const player = players[i]!;
      if ((used & (1 << i)) || !player.eligible.includes(slot.position)) continue;
      if (fixed ? player.id !== fixed.id : player.locked || !["active", "questionable"].includes(player.status)) continue;
      const rest = solve(index + 1, used | (1 << i));
      if (!rest) continue;
      const projectedPoints = rest.projectedPoints + player.projectedPoints;
      const retained = rest.retained + Number(player.slot === slot.id);
      if (!best || projectedPoints > best.projectedPoints ||
          (projectedPoints === best.projectedPoints && retained > best.retained)) {
        best = { lineup: { ...rest.lineup, [slot.id]: player.id }, projectedPoints, retained };
      }
    }
    memo.set(key, best);
    return best;
  }
  const result = solve(0, 0);
  return result && { lineup: result.lineup, projectedPoints: result.projectedPoints };
}

export function decideLineup(snapshot: SeasonSnapshot): Decision {
  const best = bestLineup(snapshot);
  if (!best) return { kind: "no_action", reason: "no_complete_legal_lineup" };
  if (snapshot.slots.every(slot => snapshot.roster.find(p => p.slot === slot.id)?.id === best.lineup[slot.id])) {
    return { kind: "no_action", reason: "best_legal_lineup_already_set" };
  }
  return { kind: "set_lineup", ...best };
}

// A bounded, transparent mechanical baseline. No invented long-term player grades.
// Claims are proposed only; a rolling waiver has no fabricated bid amount.
export function decideAcquisition(snapshot: SeasonSnapshot, kind: "add_drop" | "waiver_claim", minimumGain: number): Decision {
  if (!Number.isFinite(minimumGain) || minimumGain <= 0) throw new Error("invalid_improvement_threshold");
  const baseline = bestLineup(snapshot);
  if (!baseline) return { kind: "no_action", reason: "incomplete_lineup_requires_review" };
  let best: Extract<Decision, { addId: string }> | null = null;
  for (const add of [...snapshot.available].sort((a, b) => a.id.localeCompare(b.id))) {
    if (add.availability !== (kind === "add_drop" ? "free_agent" : "waivers") ||
        !["active", "questionable"].includes(add.status) || add.locked) continue;
    for (const drop of [...snapshot.roster].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!drop.canDrop || drop.locked) continue;
      const roster = [...snapshot.roster.filter(p => p.id !== drop.id), { ...add, availability: "rostered" as const }];
      const result = bestLineup({ ...snapshot, roster });
      const improvement = result ? result.projectedPoints - baseline.projectedPoints : 0;
      if (improvement >= minimumGain && (!best || improvement > best.improvement)) {
        best = { kind, addId: add.id, dropId: drop.id, improvement };
      }
    }
  }
  return best ?? { kind: "no_action", reason: "no_material_legal_improvement" };
}

export function validateDecision(snapshot: SeasonSnapshot, decision: Decision): string[] {
  if (decision.kind === "no_action") return [];
  if (decision.kind === "set_lineup") {
    const keys = Object.keys(decision.lineup);
    if (keys.length !== snapshot.slots.length || keys.some(k => !snapshot.slots.some(s => s.id === k))) return ["invalid_lineup_slots"];
    if (new Set(Object.values(decision.lineup)).size !== keys.length) return ["duplicate_player"];
    for (const slot of snapshot.slots) {
      const player = snapshot.roster.find(p => p.id === decision.lineup[slot.id]);
      if (!player || !player.eligible.includes(slot.position)) return ["ineligible_player"];
      if (!player.locked && !["active", "questionable"].includes(player.status)) return ["unavailable_player"];
    }
    for (const player of snapshot.roster.filter(p => p.locked)) {
      const target = keys.find(key => decision.lineup[key] === player.id) ?? null;
      if (target !== player.slot) return ["locked_player"];
    }
    return [];
  }
  if (decision.kind !== "add_drop" && decision.kind !== "waiver_claim") return ["unsupported_action"];
  const add = snapshot.available.find(p => p.id === decision.addId);
  const drop = snapshot.roster.find(p => p.id === decision.dropId);
  if (!add || !drop || add.id === drop.id) return ["wrong_player_ownership"];
  if (drop.locked || add.locked) return ["locked_player"];
  if (!drop.canDrop) return ["cannot_drop"];
  if (!["active", "questionable"].includes(add.status)) return ["unavailable_player"];
  if (add.availability !== (decision.kind === "add_drop" ? "free_agent" : "waivers")) return ["wrong_acquisition_type"];
  return [];
}
