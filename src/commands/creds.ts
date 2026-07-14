/**
 * `paylod creds set` — store the merchant's Daraja credentials with paylod.
 *
 * Interactive by default because these are four long opaque strings copy-pasted out
 * of the Safaricom developer portal, and a typo means a 404.001.03 an hour later.
 * Secrets are read with masked prompts and NEVER echoed, logged, or written to the
 * local config — they go straight to paylod, which encrypts them at rest.
 */

import { Command, Option } from "commander";
import * as p from "@clack/prompts";
import { loadConfig, currentProfile } from "../lib/config.js";
import { requireOAuth } from "../lib/session.js";
import { oauthRequest } from "../lib/client.js";
import { color as c, emit, isJson, line, ok, spinner } from "../lib/ui.js";
import { PaylodError } from "../lib/errors.js";

export function credsCommand(): Command {
  const creds = new Command("creds").description("Manage your Daraja (Safaricom) credentials");

  creds
    .command("set")
    .description("Store or rotate your Daraja credentials")
    .option("--consumer-key <key>")
    .option("--consumer-secret <secret>")
    .option("--passkey <passkey>")
    .option("--shortcode <shortcode>", "paybill or till number")
    .option("--party-b <shortcode>", "Party B — REQUIRED for a till, must differ from --shortcode")
    // `product` is the SHORTCODE KIND, not the Daraja API family: the backend enum is
    // paybill|till and it drives tx_type (CustomerPayBillOnline vs CustomerBuyGoodsOnline).
    // Getting this wrong is exactly what produces result code 2029 in production.
    .addOption(
      new Option("--product <product>", "shortcode kind")
        .choices(["paybill", "till"])
        .default("paybill"),
    )
    .addOption(
      new Option("--env <env>", "environment").choices(["sandbox", "production"]).default("sandbox"),
    )
    .option("--app <applicationId>", "application these credentials belong to")
    .addHelpText(
      "after",
      `
Run with no flags to be prompted (secrets are masked and never echoed):
  $ paylod creds set

Or pass everything (careful: flags land in your shell history):
  $ paylod creds set --consumer-key … --consumer-secret … --passkey … --shortcode 174379
`,
    )
    .action(async (opts: CredsOpts) => {
      const session = await requireOAuth("`paylod creds set`");
      const config = loadConfig();
      const applicationId = opts.app ?? currentProfile(config).applicationId;

      if (!applicationId) {
        throw new PaylodError("No application selected.", {
          hint: "Pass --app <applicationId>, or run `paylod apps use <id>`.",
          exitCode: 2,
        });
      }

      const values = await gather(opts);

      const spin = spinner("Saving your Daraja credentials…");
      try {
        await oauthRequest(session.apiBase, session.accessToken, "POST", "/save-credentials", {
          body: {
            applicationId,
            env: opts.env,
            product: opts.product,
            ...values,
          },
        });
      } catch (e) {
        spin.error("Could not save the credentials.");
        throw e;
      }
      spin.succeed("Daraja credentials saved and encrypted.");

      if (isJson()) {
        emit({ ok: true, applicationId, env: opts.env, product: opts.product });
        return;
      }

      line();
      line(`  ${c.dim("Now try it:")} ${c.cyan("paylod collect --phone 2547… --amount 1")}`);
      line();
    });

  return creds;
}

interface CredsOpts {
  consumerKey?: string;
  consumerSecret?: string;
  passkey?: string;
  shortcode?: string;
  partyB?: string;
  product: "paybill" | "till";
  env: "sandbox" | "production";
  app?: string;
}

interface CredValues {
  consumerKey: string;
  consumerSecret: string;
  passkey: string;
  shortcode: string;
  partyB?: string;
}

/**
 * Enforce the backend's till rule locally so the user gets a clear message instead of
 * a 422 from the API: a till REQUIRES partyB, and partyB must differ from shortcode.
 */
function assertTillRules(opts: CredsOpts, values: CredValues): void {
  if (opts.product !== "till") return;
  if (!values.partyB) {
    throw new PaylodError("A till needs a Party B shortcode.", {
      hint: "Pass --party-b <shortcode>. For a till, Party B is the store number and differs from the till number.",
      exitCode: 2,
    });
  }
  if (values.partyB === values.shortcode) {
    throw new PaylodError("--party-b must be different from --shortcode for a till.", {
      hint: "Sending a till as a paybill (or vice-versa) is what produces M-Pesa result code 2029.",
      exitCode: 2,
    });
  }
}

/** Take what was passed as flags; prompt (masked) for whatever is missing. */
async function gather(opts: CredsOpts): Promise<CredValues> {
  const missing =
    !opts.consumerKey || !opts.consumerSecret || !opts.passkey || !opts.shortcode;

  if (!missing) {
    const values: CredValues = {
      consumerKey: opts.consumerKey!,
      consumerSecret: opts.consumerSecret!,
      passkey: opts.passkey!,
      shortcode: opts.shortcode!,
      ...(opts.partyB ? { partyB: opts.partyB } : {}),
    };
    assertTillRules(opts, values);
    return values;
  }

  if (!process.stdin.isTTY || isJson()) {
    throw new PaylodError("Missing Daraja credentials.", {
      hint:
        "Pass --consumer-key, --consumer-secret, --passkey and --shortcode, " +
        "or run `paylod creds set` in an interactive terminal to be prompted.",
      exitCode: 2,
    });
  }

  p.intro(c.bold("Paste your Daraja credentials"));
  line(
    c.dim("  Find these at developer.safaricom.co.ke → your app → Keys, and Lipa na M-Pesa → Passkey."),
  );

  const required = (label: string) => (v: string | undefined) =>
    !v || v.trim().length === 0 ? `${label} is required` : undefined;

  const answers = await p.group(
    {
      consumerKey: () =>
        opts.consumerKey
          ? Promise.resolve(opts.consumerKey)
          : p.password({ message: "Consumer Key", validate: required("Consumer Key") }),
      consumerSecret: () =>
        opts.consumerSecret
          ? Promise.resolve(opts.consumerSecret)
          : p.password({ message: "Consumer Secret", validate: required("Consumer Secret") }),
      passkey: () =>
        opts.passkey
          ? Promise.resolve(opts.passkey)
          : p.password({ message: "Lipa na M-Pesa Passkey", validate: required("Passkey") }),
      shortcode: () =>
        opts.shortcode
          ? Promise.resolve(opts.shortcode)
          : p.text({
              message: "Shortcode (paybill or till)",
              placeholder: "174379",
              validate: required("Shortcode"),
            }),
    },
    {
      onCancel: () => {
        throw new PaylodError("Cancelled.", { exitCode: 130 });
      },
    },
  );

  // A till needs Party B and we may not have been given it — ask rather than 422.
  let partyB = opts.partyB;
  if (opts.product === "till" && !partyB) {
    const answer = await p.text({
      message: "Party B (store number — must differ from the till number)",
      validate: (v) =>
        !v || v.trim().length === 0
          ? "Party B is required for a till"
          : v.trim() === String(answers.shortcode).trim()
            ? "Party B must be different from the till number"
            : undefined,
    });
    if (p.isCancel(answer)) throw new PaylodError("Cancelled.", { exitCode: 130 });
    partyB = String(answer);
  }

  p.outro(c.dim("Sending to paylod over TLS — nothing is written to disk."));

  const values: CredValues = {
    consumerKey: String(answers.consumerKey),
    consumerSecret: String(answers.consumerSecret),
    passkey: String(answers.passkey),
    shortcode: String(answers.shortcode),
    ...(partyB ? { partyB } : {}),
  };
  assertTillRules(opts, values);
  return values;
}
