export type ManagerProfile = "steady" | "upside";

export interface YahooSnapshotPlayer {
  playerKey: string;
  name: string;
  displayPosition: string;
  selectedPosition: string | null;
}

export interface YahooSnapshot {
  schemaVersion: 1;
  source: "yahoo";
  capturedAt: string;
  snapshotHash: `sha256:${string}`;
  league: {
    leagueKey: string;
    name: string;
    season: string;
  };
  team: {
    teamKey: string;
    name: string;
  };
  roster: readonly YahooSnapshotPlayer[];
}

export interface DryRunReport {
  schemaVersion: 1;
  runId: string;
  mode: "dry-run";
  manager: ManagerProfile;
  source: "yahoo";
  snapshotHash: `sha256:${string}`;
  dataCutoff: string;
  team: {
    teamKey: string;
    name: string;
    rosterCount: number;
  };
  decision: {
    kind: "no_action";
    rationale: string;
  };
}

export function createDryRunReport(snapshot: YahooSnapshot, manager: ManagerProfile): DryRunReport {
  return {
    schemaVersion: 1,
    runId: `${manager}:${snapshot.snapshotHash}`,
    mode: "dry-run",
    manager,
    source: snapshot.source,
    snapshotHash: snapshot.snapshotHash,
    dataCutoff: snapshot.capturedAt,
    team: {
      teamKey: snapshot.team.teamKey,
      name: snapshot.team.name,
      rosterCount: snapshot.roster.length
    },
    decision: {
      kind: "no_action",
      rationale: "Read-only proof completed. No Yahoo action was proposed."
    }
  };
}
