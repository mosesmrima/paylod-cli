#!/usr/bin/env node
/**
 * paylod — accept M-Pesa from your terminal.
 *
 * Root program. Its only jobs are: wire the global flags, register the command
 * groups, and be the SINGLE place that renders an error and picks an exit code.
 *
 * Exit codes (so scripts can branch on them):
 *   0  success
 *   1  generic failure
 *   2  bad usage / invalid argument
 *   3  the payment FAILED (a valid answer, not an error — `collect` uses this)
 *   4  not authenticated
 *   5  still pending when we gave up waiting
 *   130 interrupted
 */

import { Command } from "commander";
import { setJsonMode, isJson, fail, hint, color as c } from "./lib/ui.js";
import { PaylodError } from "./lib/errors.js";
import { errorsCommand } from "./commands/errors.js";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/auth.js";
import { appsCommand } from "./commands/apps.js";
import { collectCommand } from "./commands/collect.js";
import { statusCommand } from "./commands/status.js";
import { simulateCommand } from "./commands/simulate.js";
import { listenCommand } from "./commands/listen.js";
import { keysCommand } from "./commands/keys.js";
import { credsCommand } from "./commands/creds.js";
import { webhooksCommand } from "./commands/webhooks.js";
import { initCommand } from "./commands/init.js";
import { paymentsCommand } from "./commands/payments.js";
import { orgsCommand } from "./commands/orgs.js";

const VERSION = "0.2.0";

const BANNER = `
  ${c.bold("paylod")} ${c.dim("— M-Pesa without the Daraja tax.")}

  ${c.dim("Quickstart")}
    ${c.cyan("paylod login")}                                  sign in
    ${c.cyan("paylod collect --phone 2547… --amount 100")}     ring a phone, get paid
    ${c.cyan("paylod listen --forward localhost:3000/hook")}   webhooks on localhost, no ngrok
    ${c.cyan("paylod errors 1032")}                            decode any M-Pesa code (offline)
`;

function buildProgram(): Command {
  const program = new Command();

  program
    .name("paylod")
    .description("Accept M-Pesa payments from your terminal.")
    .version(VERSION, "-v, --version")
    .option("--json", "machine-readable JSON output (for scripts)")
    .addHelpText("before", BANNER)
    .addHelpText(
      "after",
      `
${c.dim("Environment")}
  PAYLOD_API_KEY          merchant API key (skips the config file — use this in CI)
  PAYLOD_API_BASE         override the API base URL
  PAYLOD_AS_ISSUER        override the OAuth authorization server
  PAYLOD_WEBHOOK_SECRET   webhook signing secret for \`paylod listen\`
  PAYLOD_CONFIG_DIR       where the CLI stores its config (see below)
  PAYLOD_NO_KEYCHAIN=1    never use the OS keychain; use the credential file instead
  NO_COLOR                disable colour

  PAYLOD_SUPPRESS_PERMISSION_WARNING=1
                          silence the warning shown when paylod cannot restrict
                          access to your credential file. Only set this if you
                          have read that warning and accepted the risk.

${c.dim("Where your credentials live")}
  Linux     \$XDG_CONFIG_HOME/paylod  or  ~/.config/paylod
  macOS     ~/Library/Application Support/paylod
  Windows   %APPDATA%\\paylod
  An existing ~/.config/paylod from an older version keeps being used.
  The file is restricted to your user (0600 on Unix, an explicit ACL on Windows).
  If that cannot be done, paylod says so — it does not pretend.

${c.dim("Docs")}  https://paylod.dev/docs
`,
    )
    // Set --json before ANY subcommand action runs, so ui.ts is already in the right
    // mode by the time a command prints its first byte.
    .hook("preAction", (thisCommand) => {
      setJsonMode(Boolean(thisCommand.opts().json));
    });

  // Show the banner + help when invoked bare, rather than a bare usage error.
  program.action(() => {
    program.help();
  });

  // Order matters — this is the order they appear in `paylod --help`. Setup first, then the
  // things you do every day, then management, then the offline utility.
  program.addCommand(initCommand());
  program.addCommand(loginCommand());
  program.addCommand(logoutCommand());
  program.addCommand(whoamiCommand());

  program.addCommand(collectCommand());
  program.addCommand(statusCommand());
  program.addCommand(listenCommand());
  program.addCommand(simulateCommand());
  program.addCommand(paymentsCommand());

  program.addCommand(orgsCommand());
  program.addCommand(appsCommand());
  program.addCommand(credsCommand());
  program.addCommand(keysCommand());
  program.addCommand(webhooksCommand());

  program.addCommand(errorsCommand());

  // Commander EXITS THE PROCESS ITSELF on a usage error (process.exit(1)) unless every
  // command has exitOverride() set. Without this, the try/catch in main() below never
  // runs for a bad flag or an unknown command, and the documented "exit 2 = bad usage"
  // contract silently did not exist: `paylod collect` with no --phone exited 1, exactly
  // like a network failure. Scripts branching on the exit code could not tell the two
  // apart. exitOverride is NOT inherited by subcommands, so we walk the tree.
  applyExitOverride(program);

  return program;
}

/** Make every command in the tree throw instead of calling process.exit. */
function applyExitOverride(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) applyExitOverride(sub);
}

/** The single error renderer. Nothing else in the CLI prints a fatal error. */
function render(err: unknown): number {
  if (err instanceof PaylodError) {
    if (isJson()) {
      process.stdout.write(`${JSON.stringify(err.toJSON(), null, 2)}\n`);
    } else {
      fail(err.message);
      if (err.hint) hint(err.hint);
    }
    return err.exitCode;
  }

  const message = err instanceof Error ? err.message : String(err);
  if (isJson()) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  } else {
    fail(message);
    if (process.env.PAYLOD_DEBUG === "1" && err instanceof Error && err.stack) {
      process.stderr.write(`${c.dim(err.stack)}\n`);
    } else {
      hint("Re-run with PAYLOD_DEBUG=1 for a stack trace.");
    }
  }
  return 1;
}

async function main(): Promise<void> {
  const program = buildProgram();

  // --json may need to be honoured even for a commander-level failure (e.g. a bad
  // option), which happens before the preAction hook. Sniff argv for it.
  if (process.argv.includes("--json")) setJsonMode(true);

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    // Commander throws for --help/--version; those are not failures.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      typeof (err as { code: unknown }).code === "string" &&
      (err as { code: string }).code.startsWith("commander.")
    ) {
      const code = (err as { code: string; exitCode?: number }).code;

      // --help and --version are not failures. Commander signals them as thrown errors
      // once exitOverride is on, so they must be allow-listed explicitly.
      if (
        code === "commander.helpDisplayed" ||
        code === "commander.help" ||
        code === "commander.version"
      ) {
        return;
      }

      // Everything else commander raises is a USAGE error: an unknown command, an unknown
      // option, a missing required argument, a missing required option, a bad option value,
      // too many arguments. All of them are exit 2 — the user's argv was wrong, and no
      // network call was made. Deliberately a catch-all rather than a list of codes, so a
      // commander upgrade that adds a new error code cannot silently start exiting 1 again.
      process.exitCode = 2;
      return;
    }
    process.exitCode = render(err);
  }
}

process.on("unhandledRejection", (err) => {
  process.exitCode = render(err);
});

// Ctrl-C during a spinner should leave a clean terminal, not a half-drawn line.
//
// Long-running commands (`listen`) register their OWN SIGINT handler to shut down
// gracefully. If one is present we must not exit out from under it — so this handler
// only takes over when it is the only listener.
process.on("SIGINT", () => {
  if (process.listenerCount("SIGINT") > 1) return;
  process.stdout.write("\n");
  process.exit(130);
});

await main();
