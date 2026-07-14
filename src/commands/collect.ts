/**
 * `paylod collect` — fire a real STK Push and live-tail it until it settles.
 *
 * This is the command that gets screen-shared: you run it, the phone in your hand
 * rings, you enter your PIN, and the terminal prints `Paid ✅ QGR7XK2M9P`. If it
 * fails, it prints the DECODED reason (cause / fix / what to tell the customer)
 * instead of a bare `1032`.
 *
 * Two auth planes, picked automatically:
 *   • merchant API key present → POST /collect, GET /status/:id   (the data plane a
 *     merchant's own server would use — the honest demo)
 *   • otherwise, an OAuth session → POST /provider-ops/collect + /provider-ops/status
 *
 * Polling: the STK prompt lives ~60s on the handset. We poll /status every 2s (which
 * ALSO makes the backend run a lazy STK Query, so a dropped Daraja callback still
 * settles) until terminal or --timeout.
 */

import { randomUUID } from "node:crypto";
import { Command, Option } from "commander";
import { loadConfig, currentProfile, resolveApiBase, resolveApiKey } from "../lib/config.js";
import { requireOAuth } from "../lib/session.js";
import {
  apiKeyRequest,
  oauthRequest,
  type CollectResponse,
  type StatusResponse,
} from "../lib/client.js";
import { renderPayment } from "../lib/render.js";
import { color as c, emit, isJson, kes, line, spinner, kv, rule } from "../lib/ui.js";
import { PaylodError } from "../lib/errors.js";

const POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_SECS = 120;

/** Accepts 0712…, 254712…, +254712…, 0112…, 254112… — same shape the backend accepts. */
const PHONE_RE = /^(?:\+?254|0)?[17]\d{8}$/;

/**
 * Parse an amount in whole KES, STRICTLY.
 *
 * `Number.parseInt` is the wrong tool for money and this is not a nitpick: `parseInt("1.5")`
 * is `1`, and `parseInt("100abc")` is `100`. So `paylod collect --amount 1.5` used to charge
 * the customer 1 shilling — silently, with no warning, having *looked* like it worked. An
 * amount that is not exactly a whole number of shillings is a typo, and the only safe thing
 * to do with a typo about money is refuse it.
 */
export function parseAmount(raw: unknown): number | undefined {
  const s = String(raw ?? "").trim();
  if (!/^\d+$/.test(s)) return undefined; // no decimals, no signs, no trailing junk, no ""
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1 || n > 150_000) return undefined;
  return n;
}

export function collectCommand(): Command {
  return new Command("collect")
    .description("Send an M-Pesa STK Push and wait for the customer to pay")
    .requiredOption("-p, --phone <msisdn>", "customer's Safaricom number (0712…, 254712…)")
    .requiredOption("-a, --amount <kes>", "amount in KES (whole shillings)")
    .option("-r, --ref <reference>", "account reference the customer sees (≤12 chars)")
    .option("-d, --description <text>", "payment description (≤64 chars)")
    .option("--app <applicationId>", "application to charge on (OAuth plane)")
    .addOption(new Option("--env <env>", "M-Pesa environment").choices(["sandbox", "production"]))
    .option("--api-key <key>", "merchant API key (else PAYLOD_API_KEY, else your profile)")
    .option("--idempotency-key <key>", "reuse to safely retry without double-charging")
    .option("--no-wait", "fire the STK push and exit immediately (do not poll)")
    .option("--timeout <secs>", `how long to wait for settlement (default ${DEFAULT_TIMEOUT_SECS})`)
    .addHelpText(
      "after",
      `
Examples:
  $ paylod collect --phone 254712345678 --amount 100
  $ paylod collect -p 0712345678 -a 1 --ref ORDER-42
  $ paylod collect -p 0712345678 -a 100 --json | jq -r .mpesaReceipt
`,
    )
    .action(async (opts: CollectOpts) => {
      const amount = parseAmount(opts.amount);
      if (amount === undefined) {
        throw new PaylodError(`Invalid amount: ${opts.amount}`, {
          hint:
            "Amount must be a whole number of KES between 1 and 150,000. " +
            "M-Pesa does not accept cents — `1.5` is not a valid amount.",
          exitCode: 2,
        });
      }
      if (!PHONE_RE.test(opts.phone)) {
        throw new PaylodError(`Invalid phone number: ${opts.phone}`, {
          hint: "Use a Safaricom number, e.g. 254712345678, 0712345678 or +254712345678.",
          exitCode: 2,
        });
      }

      const timeoutSecs = opts.timeout
        ? Number.parseInt(String(opts.timeout), 10)
        : DEFAULT_TIMEOUT_SECS;

      const transport = await pickTransport(opts);

      if (!isJson()) {
        line();
        rule("collect");
        line();
        kv([
          ["amount", c.bold(kes(amount))],
          ["phone", c.bold(opts.phone)],
          ...(opts.ref ? [["reference", opts.ref] as const] : []),
          [
            "mode",
            transport.kind === "apiKey"
              ? transport.mode === "live"
                ? c.red("LIVE — this moves real money")
                : c.green("test")
              : c.dim(`oauth · ${transport.env}`),
          ],
        ]);
        line();
      }

      const spin = spinner("Sending STK push to Safaricom…");
      let ack: CollectResponse;
      try {
        ack = await transport.collect({
          amount,
          phone: opts.phone,
          accountReference: opts.ref,
          description: opts.description,
          idempotencyKey: opts.idempotencyKey ?? randomUUID(),
        });
      } catch (e) {
        spin.error("STK push failed.");
        throw e;
      }

      spin.succeed(`STK push sent — ${c.bold(opts.phone)} should be ringing now. 📲`);

      if (opts.wait === false) {
        if (isJson()) {
          emit({ ok: true, ...ack });
          return;
        }
        line();
        kv([
          ["payment", c.dim(ack.paymentId)],
          ["status", c.yellow("pending")],
        ]);
        line();
        line(c.dim(`  Poll it with: paylod status ${ack.paymentId}`));
        line();
        return;
      }

      const settled = await pollUntilSettled(transport, ack.paymentId, timeoutSecs);

      if (isJson()) {
        emit({ ok: settled.status === "success", ...settled, amount, phone: opts.phone });
      } else {
        renderPayment(settled, { amount, phone: opts.phone });
      }

      // A failed payment is a failed command — scripts must be able to `&&` on this.
      if (settled.status === "failed") process.exitCode = 3;
      if (settled.status === "pending") process.exitCode = 5;
    });
}

interface CollectOpts {
  phone: string;
  amount: string;
  ref?: string;
  description?: string;
  app?: string;
  env?: "sandbox" | "production";
  apiKey?: string;
  idempotencyKey?: string;
  wait?: boolean;
  timeout?: string;
}

interface CollectArgs {
  amount: number;
  phone: string;
  accountReference?: string;
  description?: string;
  idempotencyKey: string;
}

/**
 * A transport is "how do I collect and how do I read status" — the two planes
 * implement the same tiny interface so the command body never branches on auth.
 */
interface Transport {
  readonly kind: "apiKey" | "oauth";
  readonly mode?: "test" | "live" | "unknown";
  readonly env?: string;
  collect(args: CollectArgs): Promise<CollectResponse>;
  status(paymentId: string): Promise<StatusResponse>;
}

async function pickTransport(opts: CollectOpts): Promise<Transport> {
  const config = loadConfig();
  const apiBase = resolveApiBase(config);
  const apiKey = resolveApiKey(config, opts.apiKey);

  if (apiKey) {
    const mode = apiKey.startsWith("mp_live_")
      ? "live"
      : apiKey.startsWith("mp_test_")
        ? "test"
        : "unknown";
    return {
      kind: "apiKey",
      mode,
      collect: (a) =>
        apiKeyRequest<CollectResponse>(apiBase, apiKey, "POST", "/collect", {
          body: {
            phone: a.phone,
            amount: a.amount,
            ...(a.accountReference ? { accountReference: a.accountReference } : {}),
            ...(a.description ? { description: a.description } : {}),
          },
          idempotencyKey: a.idempotencyKey,
        }),
      status: (id) =>
        apiKeyRequest<StatusResponse>(apiBase, apiKey, "GET", `/status/${encodeURIComponent(id)}`),
    };
  }

  // No API key → fall back to the OAuth management plane.
  const session = await requireOAuth("`paylod collect`");
  const profile = currentProfile(config);
  const applicationId = opts.app ?? profile.applicationId;
  const env = opts.env ?? profile.env ?? "sandbox";

  if (!applicationId) {
    throw new PaylodError("No application selected.", {
      hint: "Pass --app <applicationId>, or run `paylod apps list` and `paylod apps use <id>`.",
      exitCode: 2,
    });
  }

  return {
    kind: "oauth",
    env,
    collect: (a) =>
      oauthRequest<CollectResponse>(session.apiBase, session.accessToken, "POST", "/provider-ops/collect", {
        body: {
          applicationId,
          env,
          amount: a.amount,
          phone: a.phone,
          ...(a.accountReference ? { accountReference: a.accountReference } : {}),
          ...(a.description ? { description: a.description } : {}),
        },
        idempotencyKey: a.idempotencyKey,
      }),
    status: (id) =>
      oauthRequest<StatusResponse>(session.apiBase, session.accessToken, "POST", "/provider-ops/status", {
        body: { applicationId, env, paymentId: id },
      }),
  };
}

/**
 * Poll until the payment reaches a terminal state. The spinner narrates what the
 * customer is doing so the wait never feels dead — this is the bit that makes the
 * demo feel alive rather than like a hung process.
 */
async function pollUntilSettled(
  transport: Transport,
  paymentId: string,
  timeoutSecs: number,
): Promise<StatusResponse> {
  const deadline = Date.now() + timeoutSecs * 1000;
  const spin = spinner("Waiting for the customer to enter their M-Pesa PIN…");

  let last: StatusResponse = {
    id: paymentId,
    status: "pending",
    mpesaReceipt: null,
    resultCode: null,
    resultDesc: null,
  };

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    try {
      last = await transport.status(paymentId);
    } catch (e) {
      // A transient read failure must not kill a payment that may well have succeeded.
      // Keep polling; only a hard timeout ends the loop.
      if (e instanceof PaylodError && e.status === 404) throw e;
      continue;
    }

    if (last.status === "success") {
      spin.succeed("Customer approved the payment.");
      return last;
    }
    if (last.status === "failed") {
      spin.error("Payment did not go through.");
      return last;
    }

    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    spin.update(`Waiting for the customer to enter their M-Pesa PIN… ${c.dim(`${left}s left`)}`);
  }

  spin.error("Timed out waiting for the payment to settle.");
  line(
    c.dim(
      `  The payment may still complete. Check it with: paylod status ${paymentId}`,
    ),
  );
  return last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
