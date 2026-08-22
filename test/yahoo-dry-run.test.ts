import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { runDryRunCli } from "../src/cli/dry-run.js";
import { YahooHttpReadGateway } from "../src/platforms/yahoo/http-gateway.js";
import { normalizeYahooSnapshot } from "../src/platforms/yahoo/normalize.js";
import { readYahooSnapshot, type YahooReadGateway } from "../src/platforms/yahoo/read.js";
import { createDryRunReport, type YahooSnapshot } from "../src/runtime/dry-run.js";

const execFileAsync = promisify(execFile);

const snapshot: YahooSnapshot = {
  schemaVersion: 1,
  source: "yahoo",
  capturedAt: "2026-08-22T20:00:00.000Z",
  snapshotHash: "sha256:fixture-snapshot",
  league: {
    leagueKey: "461.l.12345",
    name: "Example league",
    season: "2026"
  },
  team: {
    teamKey: "461.l.12345.t.1",
    name: "Steady example"
  },
  roster: [
    {
      playerKey: "461.p.30123",
      name: "Example quarterback",
      displayPosition: "QB",
      selectedPosition: "QB"
    },
    {
      playerKey: "461.p.30124",
      name: "Example receiver",
      displayPosition: "WR",
      selectedPosition: "BN"
    }
  ]
};

test("runs a manager profile against a sanitized Yahoo snapshot without proposing a write", () => {
  assert.deepEqual(createDryRunReport(snapshot, "steady"), {
    schemaVersion: 1,
    runId: "steady:sha256:fixture-snapshot",
    mode: "dry-run",
    manager: "steady",
    source: "yahoo",
    snapshotHash: "sha256:fixture-snapshot",
    dataCutoff: "2026-08-22T20:00:00.000Z",
    team: {
      teamKey: "461.l.12345.t.1",
      name: "Steady example",
      rosterCount: 2
    },
    decision: {
      kind: "no_action",
      rationale: "Read-only proof completed. No Yahoo action was proposed."
    }
  });
});

test("normalizes Yahoo league and roster reads into an allowlisted snapshot", () => {
  const league = {
    fantasy_content: {
      league: [
        {
          league_key: "461.l.12345",
          name: "Example league",
          season: "2026",
          private_note: "must not leave the Yahoo response"
        }
      ]
    }
  };
  const roster = {
    fantasy_content: {
      team: [
        {
          team_key: "461.l.12345.t.1",
          name: "Steady example",
          manager: { email: "private@example.test" }
        },
        {
          roster: {
            players: {
              0: {
                player: [
                  {
                    player_key: "461.p.30123",
                    name: { full: "Example quarterback" },
                    display_position: "QB"
                  },
                  { selected_position: { position: "QB" } }
                ]
              },
              1: {
                player: [
                  {
                    player_key: "461.p.30124",
                    name: { full: "Example receiver" },
                    display_position: "WR"
                  },
                  { selected_position: { position: "BN" } }
                ]
              },
              count: 2
            }
          }
        }
      ]
    }
  };

  assert.deepEqual(
    normalizeYahooSnapshot({
      league,
      roster,
      capturedAt: "2026-08-22T20:00:00.000Z"
    }),
    {
      schemaVersion: 1,
      source: "yahoo",
      capturedAt: "2026-08-22T20:00:00.000Z",
      snapshotHash: "sha256:05f743d5667e48a83526703041ce0139c7a1b649fcc0bff781d0166a0daeed96",
      league: {
        leagueKey: "461.l.12345",
        name: "Example league",
        season: "2026"
      },
      team: {
        teamKey: "461.l.12345.t.1",
        name: "Steady example"
      },
      roster: [
        {
          playerKey: "461.p.30123",
          name: "Example quarterback",
          displayPosition: "QB",
          selectedPosition: "QB"
        },
        {
          playerKey: "461.p.30124",
          name: "Example receiver",
          displayPosition: "WR",
          selectedPosition: "BN"
        }
      ]
    }
  );
});

test("reads a Yahoo snapshot through a read-only gateway before running the manager", async () => {
  const gateway: YahooReadGateway = {
    async readLeague(leagueKey) {
      assert.equal(leagueKey, "461.l.12345");
      return {
        league_key: leagueKey,
        name: "Example league",
        season: "2026"
      };
    },
    async readTeamRoster(teamKey) {
      assert.equal(teamKey, "461.l.12345.t.1");
      return {
        team_key: teamKey,
        name: "Steady example",
        player: [
          {
            player_key: "461.p.30123",
            name: "Example quarterback",
            display_position: "QB",
            selected_position: { position: "QB" }
          }
        ]
      };
    }
  };

  const result = await readYahooSnapshot({
    gateway,
    leagueKey: "461.l.12345",
    teamKey: "461.l.12345.t.1",
    capturedAt: "2026-08-22T20:00:00.000Z"
  });

  assert.deepEqual(result.league, {
    leagueKey: "461.l.12345",
    name: "Example league",
    season: "2026"
  });
  assert.deepEqual(result.team, {
    teamKey: "461.l.12345.t.1",
    name: "Steady example"
  });
  assert.deepEqual(result.roster, [
    {
      playerKey: "461.p.30123",
      name: "Example quarterback",
      displayPosition: "QB",
      selectedPosition: "QB"
    }
  ]);
});

test("reads league data from Yahoo over an authenticated GET request", async () => {
  let request: { input: string; init: RequestInit } | undefined;
  const payload = { fantasy_content: { league: [{ league_key: "461.l.12345" }] } };
  const gateway = new YahooHttpReadGateway({
    accessToken: "test-access-token",
    async fetch(input, init) {
      request = { input, init };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  assert.deepEqual(await gateway.readLeague("461.l.12345"), payload);
  assert.equal(
    request?.input,
    "https://fantasysports.yahooapis.com/fantasy/v2/league/461.l.12345?format=json"
  );
  assert.equal(request?.init.method, "GET");
  assert.deepEqual(request?.init.headers, {
    accept: "application/json",
    authorization: "Bearer test-access-token"
  });
});

test("reads a team roster from Yahoo without using a write method", async () => {
  let request: { input: string; init: RequestInit } | undefined;
  const payload = { fantasy_content: { team: [{ team_key: "461.l.12345.t.1" }] } };
  const gateway = new YahooHttpReadGateway({
    accessToken: "test-access-token",
    async fetch(input, init) {
      request = { input, init };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  assert.deepEqual(await gateway.readTeamRoster("461.l.12345.t.1"), payload);
  assert.equal(
    request?.input,
    "https://fantasysports.yahooapis.com/fantasy/v2/team/461.l.12345.t.1/roster?format=json"
  );
  assert.equal(request?.init.method, "GET");
});

test("runs a steady manager dry run from a sanitized fixture through the CLI", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "dist/src/cli/dry-run.js",
    "--fixture",
    "test/fixtures/yahoo/sanitized-snapshot.json",
    "--manager",
    "steady"
  ]);

  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), {
    schemaVersion: 1,
    runId: "steady:sha256:05f743d5667e48a83526703041ce0139c7a1b649fcc0bff781d0166a0daeed96",
    mode: "dry-run",
    manager: "steady",
    source: "yahoo",
    snapshotHash: "sha256:05f743d5667e48a83526703041ce0139c7a1b649fcc0bff781d0166a0daeed96",
    dataCutoff: "2026-08-22T20:00:00.000Z",
    team: {
      teamKey: "461.l.12345.t.1",
      name: "Steady example",
      rosterCount: 2
    },
    decision: {
      kind: "no_action",
      rationale: "Read-only proof completed. No Yahoo action was proposed."
    }
  });
});

test("runs a live read-only dry run without accepting credentials as arguments", async () => {
  const output: string[] = [];
  const gateway: YahooReadGateway = {
    async readLeague(leagueKey) {
      return {
        league_key: leagueKey,
        name: "Example league",
        season: "2026"
      };
    },
    async readTeamRoster(teamKey) {
      return {
        team_key: teamKey,
        name: "Upside example",
        player: [
          {
            player_key: "461.p.30124",
            name: "Example receiver",
            display_position: "WR",
            selected_position: { position: "WR" }
          }
        ]
      };
    }
  };

  await runDryRunCli(
    [
      "--league-key",
      "461.l.12345",
      "--team-key",
      "461.l.12345.t.2",
      "--manager",
      "upside"
    ],
    {
      createGateway(accessToken) {
        assert.equal(accessToken, "environment-only-token");
        return gateway;
      },
      env: { YAHOO_ACCESS_TOKEN: "environment-only-token" },
      now: () => "2026-08-22T21:00:00.000Z",
      async readFixture() {
        throw new Error("Fixture mode should not run.");
      },
      writeOutput(value) {
        output.push(value);
      }
    }
  );

  assert.equal(output.length, 1);
  const report = JSON.parse(output[0] ?? "");
  assert.equal(report.mode, "dry-run");
  assert.equal(report.manager, "upside");
  assert.equal(report.dataCutoff, "2026-08-22T21:00:00.000Z");
  assert.deepEqual(report.team, {
    teamKey: "461.l.12345.t.2",
    name: "Upside example",
    rosterCount: 1
  });
  assert.deepEqual(report.decision, {
    kind: "no_action",
    rationale: "Read-only proof completed. No Yahoo action was proposed."
  });
});

test("rejects a fixture when its contents do not match its snapshot hash", async () => {
  await assert.rejects(
    runDryRunCli(["--fixture", "tampered.json"], {
      createGateway() {
        throw new Error("Live mode should not run.");
      },
      env: {},
      now: () => "2026-08-22T21:00:00.000Z",
      async readFixture() {
        return JSON.stringify({
          ...snapshot,
          snapshotHash: "sha256:05f743d5667e48a83526703041ce0139c7a1b649fcc0bff781d0166a0daeed96",
          team: {
            ...snapshot.team,
            name: "Tampered team name"
          }
        });
      },
      writeOutput() {}
    }),
    /Fixture snapshot hash does not match its sanitized contents\./
  );
});

test("rejects access tokens passed on the command line in every mode", async () => {
  await assert.rejects(
    runDryRunCli(["--fixture", "snapshot.json", "--access-token", "must-not-be-accepted"], {
      createGateway() {
        throw new Error("Live mode should not run.");
      },
      env: {},
      now: () => "2026-08-22T21:00:00.000Z",
      async readFixture() {
        return JSON.stringify({
          ...snapshot,
          snapshotHash: "sha256:05f743d5667e48a83526703041ce0139c7a1b649fcc0bff781d0166a0daeed96"
        });
      },
      writeOutput() {}
    }),
    /Yahoo access tokens must be provided through the runtime environment\./
  );
});

test("reports Yahoo read failures without exposing the response body or token", async () => {
  const gateway = new YahooHttpReadGateway({
    accessToken: "sensitive-test-token",
    async fetch() {
      return new Response("upstream detail that must stay private", { status: 401 });
    }
  });

  await assert.rejects(gateway.readLeague("461.l.12345"), (error: unknown) => {
    assert.equal(error instanceof Error ? error.message : "", "Yahoo read failed with status 401.");
    assert.doesNotMatch(String(error), /sensitive-test-token|upstream detail/);
    return true;
  });
});

test("rejects fixture fields outside the public snapshot allowlist", async () => {
  await assert.rejects(
    runDryRunCli(["--fixture", "snapshot.json"], {
      createGateway() {
        throw new Error("Live mode should not run.");
      },
      env: {},
      now: () => "2026-08-22T21:00:00.000Z",
      async readFixture() {
        return JSON.stringify({
          ...snapshot,
          snapshotHash: "sha256:05f743d5667e48a83526703041ce0139c7a1b649fcc0bff781d0166a0daeed96",
          privateManagerEmail: "private@example.test"
        });
      },
      writeOutput() {}
    }),
    /Fixture is not a sanitized Yahoo snapshot\./
  );
});
