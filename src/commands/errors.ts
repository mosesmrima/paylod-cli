/**
 * `paylod errors <code>` and `paylod errors --list`.
 *
 * Pure, offline, zero-auth. Decodes a Daraja result code using paylod's OWN catalog
 * (vendored verbatim from the backend), so the explanation you get in the terminal is
 * byte-identical to the `decoded` object paylod puts on your webhook.
 *
 * This is the CLI's "instant value" command — it works before you have an account.
 */

import { Command } from "commander";
import { decodeDarajaResult, ERROR_CATALOG } from "../lib/error-catalog.js";
import { renderDecoded } from "../lib/render.js";
import { color as c, emit, isJson, line, kv } from "../lib/ui.js";
import { PaylodError } from "../lib/errors.js";

export function errorsCommand(): Command {
  const cmd = new Command("errors")
    .description("Decode an M-Pesa / Daraja result code (offline, no login needed)")
    .argument("[code]", "the Daraja ResultCode, e.g. 1032")
    .option("-l, --list", "list every code paylod knows about")
    .addHelpText(
      "after",
      `
Examples:
  $ paylod errors 1032          Why did the payment fail?
  $ paylod errors 2001 --json   Machine-readable, for your error handler
  $ paylod errors --list        The whole catalog
`,
    )
    .action((code: string | undefined, opts: { list?: boolean }) => {
      if (opts.list) {
        listAll();
        return;
      }
      if (!code) {
        throw new PaylodError("Pass a result code to decode, or use --list.", {
          hint: "e.g. `paylod errors 1032`",
          exitCode: 2,
        });
      }
      decodeOne(code);
    });

  return cmd;
}

function decodeOne(code: string): void {
  const decoded = decodeDarajaResult(code);
  const known = code in ERROR_CATALOG;

  if (isJson()) {
    emit({ ok: true, known, ...decoded });
    return;
  }

  line();
  renderDecoded(decoded);

  if (!known) {
    line(
      c.dim(
        `  ${c.yellow("note")}  ${code} is not in paylod's catalog — showing the generic fallback.`,
      ),
    );
    line();
  }
}

function listAll(): void {
  const codes = Object.entries(ERROR_CATALOG);

  if (isJson()) {
    emit({
      ok: true,
      count: codes.length,
      codes: codes.map(([code, entry]) => ({ code, ...entry })),
    });
    return;
  }

  line();
  line(c.bold(`  M-Pesa result codes paylod decodes (${codes.length})`));
  line();
  kv(codes.map(([code, entry]) => [code, entry.title] as const));
  line();
  line(c.dim(`  Run \`paylod errors <code>\` for the cause, the fix, and the customer message.`));
  line();
}
