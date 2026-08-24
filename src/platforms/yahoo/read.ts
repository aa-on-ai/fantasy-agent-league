import type { YahooSnapshot } from "../../runtime/dry-run.js";
import { normalizeYahooSnapshot } from "./normalize.js";

export interface YahooReadGateway {
  readLeague(leagueKey: string): Promise<unknown>;
  readTeamRoster(teamKey: string): Promise<unknown>;
}

export interface ReadYahooSnapshotOptions {
  gateway: YahooReadGateway;
  leagueKey: string;
  teamKey: string;
  capturedAt: string;
}

export async function readYahooSnapshot(options: ReadYahooSnapshotOptions): Promise<YahooSnapshot> {
  const [league, roster] = await Promise.all([
    options.gateway.readLeague(options.leagueKey),
    options.gateway.readTeamRoster(options.teamKey)
  ]);

  return normalizeYahooSnapshot({
    league,
    roster,
    capturedAt: options.capturedAt
  });
}
