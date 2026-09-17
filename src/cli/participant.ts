import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { importParticipantOwnerReport, initializeParticipant, prepareParticipantWake,
  readParticipantInput, recordParticipantAuthored, writeParticipantOutput } from "../runtime/participant-wake.js";

export const PARTICIPANT_USAGE = `Participant writing harness (local only, fixed yahoo:f1:425299:team:11)
  init --directory /absolute/private/participant
  import-report --directory DIR --file /absolute/private/report.json --trusted-owner-report
  prepare-wake --directory DIR --season 2026 --period 1 --brief "Personal debut account" --output /absolute/private/wake.json
  record-authored --directory DIR --file /absolute/private/response.json --run-id ACTUAL_MODEL_RUN_ID
Inputs and outputs must be private. Output paths must be new lowercase .json filenames.
import-report is trusted-host only; model-authored responses are accepted only by record-authored.
No command submits a rename, publishes a note, changes an avatar or starts a model/schedule.`;

export async function main(args: string[]): Promise<void> {
  process.umask(0o077);
  if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
    process.stdout.write(PARTICIPANT_USAGE + "\n"); return;
  }
  const command = args[0];
  const permitted: Record<string, string[]> = {
    init: ["directory"], "import-report": ["directory", "file", "trusted-owner-report"],
    "prepare-wake": ["directory", "season", "period", "brief", "output"], "record-authored": ["directory", "file", "run-id"],
  };
  const names = permitted[command!];
  if (!names) throw new Error("invalid_participant_command");
  const options = Object.fromEntries(names.map(name => [name, { type: name === "trusted-owner-report" ? "boolean" as const : "string" as const }]));
  const { values } = parseArgs({ args: args.slice(1), options, strict: true, allowPositionals: false });
  if (names.some(name => values[name] === undefined || values[name] === "")) throw new Error("missing_participant_argument");
  const directory = values.directory as string;
  let result: unknown;
  switch (command) {
    case "init": result = await initializeParticipant(directory); break;
    case "import-report":
      if (values["trusted-owner-report"] !== true) throw new Error("trusted_owner_report_required");
      result = await importParticipantOwnerReport(directory, await readParticipantInput(values.file as string)); break;
    case "prepare-wake": {
      const wake = await prepareParticipantWake(directory, { season: values.season as string, period: values.period as string, brief: values.brief as string });
      await writeParticipantOutput(values.output as string, wake);
      result = { identityId: wake.identityId, wakeId: wake.wakeId, continuityHash: wake.continuityHash,
        evidenceState: wake.continuity.evidenceState, output: values.output, publish: false, reviewRequired: true }; break;
    }
    case "record-authored": result = await recordParticipantAuthored(directory, await readParticipantInput(values.file as string), values["run-id"] as string); break;
  }
  process.stdout.write(JSON.stringify(result) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    // Do not print raw source data, filesystem paths or parseArgs values in shared logs.
    const message = error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : "participant_command_failed";
    process.stderr.write(JSON.stringify({ error: message }) + "\n"); process.exitCode = 2;
  });
}
