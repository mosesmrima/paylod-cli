/**
 * `paylod status <paymentId>` — read one payment, optionally live-tailing it.
 *
 * Hitting /status also makes the backend run a lazy STK Query and settle a payment
 * whose Daraja callback never arrived — so this command is both a read AND the
 * manual repair for Daraja's famously flaky callbacks.
 */

import { Command, Option } from "commander";
import { loadConfig, currentProfile, resolveApiBase, resolveApiKey } from "../lib/config.js";
import { requireOAuth } from "../lib/session.js";
import { apiKeyRequest, oauthRequest, type StatusResponse } from "../lib/client.js";
import { renderPayment } from "../lib/render.js";
import { emit, isJson, spinner, color as c, line } from "../lib/ui.js";
import { PaylodError } from "../lib/errors.js";

const POLL_INTERVAL_MS = 2_000;

export function statusCommand(): Command {
  return new Command("status")
    .description("Look up a payment by id (and decode why it failed)")
    .argument("<paymentId>", "the paymentId returned by `paylod collect`")
    .option("-w, --watch", "keep polling until the payment settles")
    .option("--app <applicationId>", "application the payment belongs to (OAuth plane)")
    .addOption(new Option("--env <env>", "M-Pesa environment").choices(["sandbox", "production"]))
    .option("--api-key <key>", "merchant API key (else PAYLOD_API_KEY, else your profile)")
    .option("--timeout <secs>", "with --watch, give up after this many seconds (default 120)")
    .action(async (paymentId: string, opts: StatusOpts) => {
      const read = await pickReader(opts);

      const spin = spinner("Fetching payment…");
      let payment: StatusResponse;
      try {
        payment = await read(paymentId);
      } catch (e) {
        spin.error("Could not read the payment.");
        throw e;
      }
      spin.stop();

      if (opts.watch && payment.status === "pending") {
        payment = await watch(read, paymentId, opts.timeout ? Number(opts.timeout) : 120);
      }

      if (isJson()) {
        emit({ ok: payment.status === "success", ...payment });
      } else {
        renderPayment(payment);
      }

      if (payment.status === "failed") process.exitCode = 3;
      if (payment.status === "pending") process.exitCode = 5;
    });
}

interface StatusOpts {
  watch?: boolean;
  app?: string;
  env?: "sandbox" | "production";
  apiKey?: string;
  timeout?: string;
}

type Reader = (paymentId: string) => Promise<StatusResponse>;

async function pickReader(opts: StatusOpts): Promise<Reader> {
  const config = loadConfig();
  const apiBase = resolveApiBase(config);
  const apiKey = resolveApiKey(config, opts.apiKey);

  if (apiKey) {
    return (id) =>
      apiKeyRequest<StatusResponse>(apiBase, apiKey, "GET", `/status/${encodeURIComponent(id)}`);
  }

  const session = await requireOAuth("`paylod status`");
  const profile = currentProfile(config);
  const applicationId = opts.app ?? profile.applicationId;
  const env = opts.env ?? profile.env ?? "sandbox";

  if (!applicationId) {
    throw new PaylodError("No application selected.", {
      hint: "Pass --app <applicationId>, or run `paylod apps use <id>`.",
      exitCode: 2,
    });
  }

  return (id) =>
    oauthRequest<StatusResponse>(session.apiBase, session.accessToken, "POST", "/provider-ops/status", {
      body: { applicationId, env, paymentId: id },
    });
}

async function watch(read: Reader, paymentId: string, timeoutSecs: number): Promise<StatusResponse> {
  const deadline = Date.now() + timeoutSecs * 1000;
  const spin = spinner("Payment is still pending — watching…");

  let last: StatusResponse = {
    id: paymentId,
    status: "pending",
    mpesaReceipt: null,
    resultCode: null,
    resultDesc: null,
  };

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      last = await read(paymentId);
    } catch {
      continue;
    }
    if (last.status !== "pending") {
      if (last.status === "success") spin.succeed("Settled.");
      else spin.error("Settled — failed.");
      return last;
    }
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    spin.update(`Payment is still pending — watching… ${c.dim(`${left}s left`)}`);
  }

  spin.error("Still pending when the watch window expired.");
  line(c.dim("  Daraja can take a while. Re-run `paylod status` in a minute."));
  return last;
}
