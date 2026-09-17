import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { extractPostDraft, type PostDraftObservations } from "../platforms/yahoo/post-draft.js";
import type { DesktopBinding } from "../platforms/yahoo/desktop-season.js";

// Native capture remains a host-owned operation. This CLI only consumes private
// captures; it cannot launch browsers, alter configuration, or submit actions.
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== "--observations" || args[2] !== "--binding" || args[4] !== "--output") throw new Error("usage_season_extract_observations_binding_output");
  const observations = JSON.parse(await readFile(resolve(args[1]!), "utf8")) as PostDraftObservations;
  const binding = JSON.parse(await readFile(resolve(args[3]!), "utf8")) as DesktopBinding;
  const result = extractPostDraft(observations, binding);
  await writeFile(resolve(args[5]!), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
  process.stdout.write(JSON.stringify({ roster: result.roster.status, executionEligible: false }) + "\n");
  if (result.roster.status !== "pass") process.exitCode = 2;
}
main().catch(() => { process.stderr.write("season_extraction_failed\n"); process.exitCode = 1; });
