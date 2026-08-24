import type { YahooSnapshot } from "../../runtime/dry-run.js";
import { computeYahooSnapshotHash } from "../../runtime/snapshot-hash.js";

export interface YahooReadPayloads {
  league: unknown;
  roster: unknown;
  capturedAt: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findValuesForKey(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => findValuesForKey(item, key));
  }

  if (!isRecord(value)) {
    return [];
  }

  const matches = Object.hasOwn(value, key) ? [value[key]] : [];
  return [...matches, ...Object.values(value).flatMap((item) => findValuesForKey(item, key))];
}

function firstStringForKey(value: unknown, key: string): string | undefined {
  return findValuesForKey(value, key).find((candidate): candidate is string => typeof candidate === "string");
}

function requiredString(value: unknown, key: string, label: string): string {
  const result = firstStringForKey(value, key);

  if (!result) {
    throw new Error(`Yahoo response is missing ${label}.`);
  }

  return result;
}

function playerName(value: unknown): string {
  const nameValue = findValuesForKey(value, "name")[0];

  if (typeof nameValue === "string") {
    return nameValue;
  }

  return requiredString(nameValue, "full", "player name");
}

function selectedPosition(value: unknown): string | null {
  const selected = findValuesForKey(value, "selected_position")[0];
  return selected ? firstStringForKey(selected, "position") ?? null : null;
}

export function normalizeYahooSnapshot(payloads: YahooReadPayloads): YahooSnapshot {
  const league = {
    leagueKey: requiredString(payloads.league, "league_key", "league key"),
    name: requiredString(payloads.league, "name", "league name"),
    season: requiredString(payloads.league, "season", "league season")
  };
  const team = {
    teamKey: requiredString(payloads.roster, "team_key", "team key"),
    name: requiredString(payloads.roster, "name", "team name")
  };
  const roster = findValuesForKey(payloads.roster, "player").map((player) => ({
    playerKey: requiredString(player, "player_key", "player key"),
    name: playerName(player),
    displayPosition: requiredString(player, "display_position", "player display position"),
    selectedPosition: selectedPosition(player)
  }));
  const hashInput = {
    schemaVersion: 1,
    source: "yahoo",
    capturedAt: payloads.capturedAt,
    league,
    team,
    roster
  } as const;
  return {
    ...hashInput,
    snapshotHash: computeYahooSnapshotHash(hashInput)
  };
}
