import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

// This bootstrap never accepts an existing browser profile, credentials,
// arbitrary URLs, or a remote debugging address.
process.umask(0o077);
const args = process.argv.slice(2);
const usage = "Usage: npm run agent:browser -- --health-check | --login";

async function main() {
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (args.length !== 1 || !["--health-check", "--login"].includes(args[0])) {
    throw new Error("invalid_arguments");
  }

  const mode = args[0];
  const root = join(homedir(), ".local", "share", "fantasy-agent-league");
  const profile = join(root, "2026", "agent-1", "browser");
  // Reject redirected profile directories rather than accidentally opening a
  // personal Chrome profile through a symlink.
  for (const directory of [root, join(root, "2026"), join(root, "2026", "agent-1"), profile]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("unsafe_profile");
    await chmod(directory, 0o700);
  }
  if (await realpath(profile) !== resolve(profile)) throw new Error("unsafe_profile");

  const context = await chromium.launchPersistentContext(profile, {
    channel: "chrome",
    headless: mode === "--health-check",
    chromiumSandbox: true,
    acceptDownloads: false,
    serviceWorkers: "block",
    timeout: 30_000,
    viewport: { width: 1280, height: 900 }
  });
  let closing;
  const close = () => closing ??= context.close();
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());

  try {
    // Close restored pages without examining their contents. The setup command
    // never reads page text, cookies, storage, or credentials from a Yahoo login.
    for (const page of context.pages()) await page.close();
    if (mode === "--health-check") {
      await context.route("**/*", (route) => route.abort());
      const page = await context.newPage();
      await page.setContent("<title>Agent browser check</title><p>Local browser check</p>");
      if (await page.title() !== "Agent browser check") throw new Error("health_check_failed");
      process.stdout.write(`${JSON.stringify({
        status: "browser_launch_verified",
        mode: "offline_health_check",
        agentId: "agent-1",
        profile,
        yahooAuthenticated: "not_checked",
        yahooActions: "not_implemented"
      }, null, 2)}\n`);
      return;
    }

    const page = await context.newPage();
    await page.goto("https://login.yahoo.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    process.stdout.write("Dedicated agent browser opened for human sign-in. No login details are read or logged. Close this browser when finished.\n");
    await new Promise((done) => context.once("close", done));
  } finally {
    await close();
  }
}

main().catch(() => {
  // Browser errors can contain navigation details. Do not forward raw errors.
  process.stderr.write(`${usage}\nBrowser setup could not complete. Check that Chrome is installed and the dedicated profile is not already open.\n`);
  process.exitCode = 1;
});
