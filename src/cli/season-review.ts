import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { codexDecisionInstructions, validateManagerContext } from "../manager/codex-run.js";
import { runSeasonManager } from "../runtime/season-run.js";

// Safe filesystem entry point for an admitted Codex task. It exports a bound
// prompt or validates the task's judgment; it never starts an unadmitted model,
// enables writes or loads an arbitrary executor plugin from an input file.
export async function main(args: string[]): Promise<void> {
  process.umask(0o077);
  const { values } = parseArgs({ args, options: {
    context: { type: "string" }, binding: { type: "string" }, packet: { type: "string" },
    request: { type: "string" }, receipts: { type: "string" }, stop: { type: "string" }
  }, strict: true, allowPositionals: false });
  if (!values.context || !values.binding || !values.stop || !!values.packet === !!values.request || values.packet && !values.receipts)
    throw new Error("invalid_arguments");
  const binding = JSON.parse(await readFile(values.binding, "utf8"));
  const context = validateManagerContext(JSON.parse(await readFile(values.context, "utf8")), binding);
  if (values.request) {
    const { readStop } = await import("../runtime/native-read-proof.js");
    if (await readStop(values.stop) !== "clear") throw new Error("emergency_stop");
    await writeFile(values.request, JSON.stringify({ instructions: codexDecisionInstructions(context), context }) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write(JSON.stringify({ status: "decision_request_written", runId: context.runId, executed: false }) + "\n");
    return;
  }
  const receipt = await runSeasonManager({ context, binding, emergencyStopPath: values.stop, receiptDirectory: values.receipts!,
    mode: "review", decide: async () => JSON.parse(await readFile(values.packet!, "utf8")) });
  process.stdout.write(JSON.stringify(receipt) + "\n");
  if (receipt.status === "blocked") process.exitCode = 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(() => {
  process.stderr.write("Season review blocked: invalid, missing or stale bound inputs. No Yahoo action was submitted.\n");
  process.exitCode = 2;
});
