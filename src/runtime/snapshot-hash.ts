import { createHash } from "node:crypto";

import type { YahooSnapshot } from "./dry-run.js";

export type YahooSnapshotContent = Omit<YahooSnapshot, "snapshotHash">;

export function computeYahooSnapshotHash(snapshot: YahooSnapshotContent): `sha256:${string}` {
  const canonical = {
    schemaVersion: snapshot.schemaVersion,
    source: snapshot.source,
    capturedAt: snapshot.capturedAt,
    league: {
      leagueKey: snapshot.league.leagueKey,
      name: snapshot.league.name,
      season: snapshot.league.season
    },
    team: {
      teamKey: snapshot.team.teamKey,
      name: snapshot.team.name
    },
    roster: snapshot.roster.map((player) => ({
      playerKey: player.playerKey,
      name: player.name,
      displayPosition: player.displayPosition,
      selectedPosition: player.selectedPosition
    }))
  };
  const digest = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return `sha256:${digest}`;
}
