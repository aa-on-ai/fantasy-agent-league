import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { decideAcquisition, decideLineup, digest, validateDecision, validateSnapshot, type Binding } from "../manager/season.js";

export async function main(args: string[]): Promise<void> {
  process.umask(0o077);
  const { values } = parseArgs({ args, options: {
    snapshot: { type: "string" }, config: { type: "string" }, phase: { type: "string", default: "lineup" }
  }, strict: true, allowPositionals: false });
  if (!values.snapshot || !values.config || !["lineup", "free_agents", "waivers"].includes(values.phase)) throw new Error("invalid_arguments");
  const config = JSON.parse(await readFile(values.config, "utf8")) as Binding & { minimumGain?: number };
  const snapshot = validateSnapshot(JSON.parse(await readFile(values.snapshot, "utf8")), config, new Date());
  const decision = values.phase === "lineup" ? decideLineup(snapshot) :
    decideAcquisition(snapshot, values.phase === "waivers" ? "waiver_claim" : "add_drop", config.minimumGain ?? 2);
  if (validateDecision(snapshot, decision).length) throw new Error("decision_rejected");
  const runId = digest({ snapshot: snapshot.hash, phase: values.phase });
  const output = resolve("runtime/private/decisions");
  await mkdir(output, { recursive: true, mode: 0o700 });
  try { await writeFile(join(output, `${runId}.json`), JSON.stringify({ runId, phase: values.phase,
    snapshotHash: snapshot.hash, decision, executed: false }, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  process.stdout.write(JSON.stringify({ runId, decisionKind: decision.kind, mode: "proposal_only", executed: false }) + "\n");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write("Season planning blocked: check the sanitized snapshot, team binding and data freshness.\n");
    process.exitCode = 2;
  });
}
