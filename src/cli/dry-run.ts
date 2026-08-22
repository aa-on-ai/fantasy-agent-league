import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { YahooHttpReadGateway } from "../platforms/yahoo/http-gateway.js";
import { readYahooSnapshot, type YahooReadGateway } from "../platforms/yahoo/read.js";
import { createDryRunReport, type ManagerProfile, type YahooSnapshot } from "../runtime/dry-run.js";
import { computeYahooSnapshotHash } from "../runtime/snapshot-hash.js";

export interface DryRunCliDependencies {
  createGateway(accessToken: string): YahooReadGateway;
  env: Readonly<Record<string, string | undefined>>;
  now(): string;
  readFixture(path: string): Promise<string>;
  writeOutput(value: string): void;
}

const defaultDependencies: DryRunCliDependencies = {
  createGateway: (accessToken) => new YahooHttpReadGateway({ accessToken }),
  env: process.env,
  now: () => new Date().toISOString(),
  readFixture: (path) => readFile(path, "utf8"),
  writeOutput: (value) => process.stdout.write(value)
};

function argumentValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function managerProfile(value: string | undefined): ManagerProfile {
  if (value === undefined || value === "steady") {
    return "steady";
  }

  if (value === "upside") {
    return value;
  }

  throw new Error("Manager must be steady or upside.");
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSnapshotPlayer(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["playerKey", "name", "displayPosition", "selectedPosition"])) {
    return false;
  }

  return (
    isNonEmptyString(value.playerKey) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.displayPosition) &&
    (value.selectedPosition === null || isNonEmptyString(value.selectedPosition))
  );
}

function parseSnapshot(value: string): YahooSnapshot {
  const snapshot: unknown = JSON.parse(value);

  if (!isRecord(snapshot) || !hasExactKeys(snapshot, [
    "schemaVersion",
    "source",
    "capturedAt",
    "snapshotHash",
    "league",
    "team",
    "roster"
  ])) {
    throw new Error("Fixture is not a sanitized Yahoo snapshot.");
  }

  const league = snapshot.league;
  const team = snapshot.team;
  const roster = snapshot.roster;
  const valid =
    snapshot.schemaVersion === 1 &&
    snapshot.source === "yahoo" &&
    isNonEmptyString(snapshot.capturedAt) &&
    !Number.isNaN(Date.parse(snapshot.capturedAt)) &&
    typeof snapshot.snapshotHash === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(snapshot.snapshotHash) &&
    isRecord(league) &&
    hasExactKeys(league, ["leagueKey", "name", "season"]) &&
    isNonEmptyString(league.leagueKey) &&
    isNonEmptyString(league.name) &&
    isNonEmptyString(league.season) &&
    isRecord(team) &&
    hasExactKeys(team, ["teamKey", "name"]) &&
    isNonEmptyString(team.teamKey) &&
    isNonEmptyString(team.name) &&
    Array.isArray(roster) &&
    roster.every(isSnapshotPlayer);

  if (!valid) {
    throw new Error("Fixture is not a sanitized Yahoo snapshot.");
  }

  const parsed = snapshot as unknown as YahooSnapshot;

  if (computeYahooSnapshotHash(parsed) !== parsed.snapshotHash) {
    throw new Error("Fixture snapshot hash does not match its sanitized contents.");
  }

  return parsed;
}

export async function runDryRunCli(
  args: readonly string[],
  dependencies: DryRunCliDependencies = defaultDependencies
): Promise<void> {
  if (args.includes("--access-token")) {
    throw new Error("Yahoo access tokens must be provided through the runtime environment.");
  }

  const fixture = argumentValue(args, "--fixture");
  const manager = managerProfile(argumentValue(args, "--manager"));
  let snapshot: YahooSnapshot;

  if (fixture) {
    snapshot = parseSnapshot(await dependencies.readFixture(fixture));
  } else {
    const accessToken = dependencies.env.YAHOO_ACCESS_TOKEN;
    const leagueKey = argumentValue(args, "--league-key") ?? dependencies.env.YAHOO_LEAGUE_KEY;
    const teamKey = argumentValue(args, "--team-key") ?? dependencies.env.YAHOO_TEAM_KEY;

    if (!accessToken || !leagueKey || !teamKey) {
      throw new Error(
        "Live mode requires YAHOO_ACCESS_TOKEN plus --league-key and --team-key, or their environment equivalents."
      );
    }

    snapshot = await readYahooSnapshot({
      gateway: dependencies.createGateway(accessToken),
      leagueKey,
      teamKey,
      capturedAt: dependencies.now()
    });
  }

  const report = createDryRunReport(snapshot, manager);
  dependencies.writeOutput(`${JSON.stringify(report, null, 2)}\n`);
}

const entrypoint = process.argv[1];

if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runDryRunCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Yahoo dry run failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
