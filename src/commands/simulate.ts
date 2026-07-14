/**
 * `paylod simulate` — drive paylod's hosted sandbox simulator.
 *
 * No Safaricom dependency, no real STK prompt, no money. But it drives the SAME
 * settle → buildEvent → enqueue_webhook path a real payment does, so the webhook it
 * fires is genuinely signed and delivered. That means you can test your entire
 * integration — including every failure code — before you even have Daraja creds.
 *
 * Two shapes:
 *   paylod simulate --outcome wrong_pin      one-shot: create + settle
 *   paylod simulate --interactive            pick the outcome from a menu ("fake phone")
 */

import { Command, Option } from "commander";
import * as p from "@clack/prompts";
import { loadConfig, currentProfile } from "../lib/config.js";
import { requireOAuth } from "../lib/session.js";
import {
  oauthRequest,
  type SimulateCollectResponse,
  type SimulateOutcomeResponse,
} from "../lib/client.js";
import { renderPayment } from "../lib/render.js";
import { color as c, emit, isJson, kes, kv, line, rule, spinner } from "../lib/ui.js";
import { PaylodError } from "../lib/errors.js";

/** The outcomes paylod's simulator supports (supabase/functions/simulate). */
const OUTCOMES = [
  "approve",
  "wrong_pin",
  "insufficient_funds",
  "user_cancelled",
  "timeout",
] as const;
type Outcome = (typeof OUTCOMES)[number];

const OUTCOME_LABEL: Record<Outcome, string> = {
  approve: "Approve — customer enters the correct PIN",
  wrong_pin: "Wrong PIN (2001)",
  insufficient_funds: "Insufficient funds (1)",
  user_cancelled: "Customer cancels (1032)",
  timeout: "Timeout — phone unreachable (1037)",
};

export function simulateCommand(): Command {
  return new Command("simulate")
    .description("Simulate a payment in the paylod sandbox — no Daraja, no money")
    .option("-p, --phone <msisdn>", "test number to simulate", "254708374149")
    .option("-a, --amount <kes>", "amount in KES", "1")
    .option("-r, --ref <reference>", "account reference")
    .addOption(
      new Option("-o, --outcome <outcome>", "force this outcome").choices([...OUTCOMES]),
    )
    .option("-i, --interactive", "pick the outcome from a menu")
    .option("--app <applicationId>", "application to simulate on")
    .addHelpText(
      "after",
      `
Outcomes:
${OUTCOMES.map((o) => `  ${o.padEnd(19)} ${OUTCOME_LABEL[o]}`).join("\n")}

Examples:
  $ paylod simulate --outcome approve
  $ paylod simulate --outcome user_cancelled     # see the decoded 1032
  $ paylod simulate --interactive                # the "fake phone"
`,
    )
    .action(async (opts: SimOpts) => {
      const session = await requireOAuth("`paylod simulate`");
      const config = loadConfig();
      const applicationId = opts.app ?? currentProfile(config).applicationId;

      if (!applicationId) {
        throw new PaylodError("No application selected.", {
          hint: "Pass --app <applicationId>, or run `paylod apps use <id>`.",
          exitCode: 2,
        });
      }

      const amount = Number.parseInt(String(opts.amount), 10);
      if (!Number.isInteger(amount) || amount < 1) {
        throw new PaylodError(`Invalid amount: ${opts.amount}`, { exitCode: 2 });
      }

      if (!isJson()) {
        line();
        rule("simulate · sandbox");
        line();
        kv([
          ["amount", c.bold(kes(amount))],
          ["phone", c.bold(opts.phone)],
          ["mode", c.green("simulated — no real STK push, no money")],
        ]);
        line();
      }

      // 1. Create the pending simulated payment.
      const spin = spinner("Creating a simulated payment…");
      let created: SimulateCollectResponse;
      try {
        created = await oauthRequest<SimulateCollectResponse>(
          session.apiBase,
          session.accessToken,
          "POST",
          "/simulate/collect",
          {
            body: {
              applicationId,
              phone: opts.phone,
              amount,
              ...(opts.ref ? { accountRef: opts.ref } : {}),
            },
          },
        );
      } catch (e) {
        spin.error("Could not create the simulated payment.");
        throw e;
      }
      spin.succeed(`Simulated STK push sent. ${c.dim(created.paymentId)}`);

      // 2. Decide the outcome.
      const outcome = await resolveOutcome(opts, created);

      // 3. Settle it — this fires a REAL signed webhook.
      const spin2 = spinner(`Settling as ${c.bold(outcome)}…`);
      let settled: SimulateOutcomeResponse;
      try {
        settled = await oauthRequest<SimulateOutcomeResponse>(
          session.apiBase,
          session.accessToken,
          "POST",
          "/simulate/outcome",
          { body: { paymentId: created.paymentId, outcome } },
        );
      } catch (e) {
        spin2.error("Could not settle the simulated payment.");
        throw e;
      }
      spin2.succeed(
        settled.webhookQueued
          ? `Settled — a signed webhook was queued. ${c.dim("(paylod listen will show it)")}`
          : "Settled.",
      );

      if (isJson()) {
        emit({ ok: settled.status === "success", outcome, ...settled });
      } else {
        renderPayment(
          {
            id: settled.paymentId,
            status: settled.status,
            mpesaReceipt: settled.mpesaReceipt,
            resultCode: settled.resultCode,
            resultDesc: settled.resultDesc,
          },
          { amount, phone: opts.phone },
        );
      }

      if (settled.status === "failed") process.exitCode = 3;
    });
}

interface SimOpts {
  phone: string;
  amount: string;
  ref?: string;
  outcome?: Outcome;
  interactive?: boolean;
  app?: string;
}

/**
 * --outcome wins. --interactive shows the "fake phone" menu. Otherwise default to
 * `approve` in non-interactive contexts (CI) and prompt when we have a TTY.
 */
async function resolveOutcome(
  opts: SimOpts,
  created: SimulateCollectResponse,
): Promise<Outcome> {
  if (opts.outcome) return opts.outcome;

  const canPrompt = process.stdin.isTTY && !isJson();
  if (!opts.interactive && !canPrompt) return "approve";
  if (!opts.interactive) return "approve";

  if (!canPrompt) {
    throw new PaylodError("--interactive needs a TTY.", {
      hint: "Use --outcome <outcome> in scripts and CI.",
      exitCode: 2,
    });
  }

  // Offer what the backend actually said it supports. NOTE: /simulate/collect returns
  // `outcomes` as OBJECTS — [{ id, label, status }] — not bare strings. Use the
  // backend's own label when present so the menu can never drift from the simulator.
  const offered = created.outcomes?.length
    ? created.outcomes
        .filter((o) => (OUTCOMES as readonly string[]).includes(o.id))
        .map((o) => ({ value: o.id as Outcome, label: o.label || OUTCOME_LABEL[o.id as Outcome] }))
    : OUTCOMES.map((o) => ({ value: o, label: OUTCOME_LABEL[o] }));

  const options = offered.length
    ? offered
    : OUTCOMES.map((o) => ({ value: o, label: OUTCOME_LABEL[o] }));

  const chosen = await p.select({
    message: "📱 The customer's phone is ringing. What do they do?",
    options,
  });

  if (p.isCancel(chosen)) {
    throw new PaylodError("Cancelled.", { exitCode: 130 });
  }
  return chosen as Outcome;
}
