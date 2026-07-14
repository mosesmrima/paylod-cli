/**
 * `paylod payments list|get` — the payment ledger.
 *
 * Backed by the NEW `/payments` edge function (this work): the dashboard reads the
 * `payments` table directly under RLS, which an ES256 OAuth token cannot do, so there
 * was previously no headless way to answer "did that payment land?".
 *
 * Keyset pagination (`--before`) rather than OFFSET, so this stays fast on a merchant
 * with a large ledger.
 */

import { Command, Option } from "commander";
import { loadConfig, currentProfile } from "../lib/config.js";
import { requireOAuth } from "../lib/session.js";
import { oauthRequest, type PaymentRow, type PaymentStatus } from "../lib/client.js";
import { renderPayment } from "../lib/render.js";
import { decodeDarajaResult } from "../lib/error-catalog.js";
import { color as c, emit, isJson, kes, line, rule, spinner, warn, kv } from "../lib/ui.js";

interface ListResponse {
  readonly payments: readonly PaymentRow[];
  readonly nextBefore: string | null;
}

export function paymentsCommand(): Command {
  const payments = new Command("payments").description("Browse your M-Pesa payments");

  payments
    .command("list")
    .alias("ls")
    .description("List payments (newest first)")
    .option("--app <applicationId>", "only this application")
    .addOption(new Option("--env <env>", "environment").choices(["sandbox", "production"]))
    .addOption(
      new Option("-s, --status <status>", "filter by status").choices([
        "pending",
        "success",
        "failed",
      ]),
    )
    .option("--phone <msisdn>", "filter by customer phone")
    .option("-n, --limit <n>", "how many to show (max 100)", "20")
    .option("--before <iso>", "keyset cursor — show payments older than this timestamp")
    .addHelpText(
      "after",
      `
Examples:
  $ paylod payments list
  $ paylod payments list --status failed          # what's breaking?
  $ paylod payments list --phone 254712345678
  $ paylod payments list --json | jq '.payments[] | select(.amount > 1000)'
`,
    )
    .action(async (opts: ListOpts) => {
      const session = await requireOAuth("`paylod payments list`");
      // applicationId is OPTIONAL here — omitting it lists across every org you belong to.
      const applicationId = opts.app ?? currentProfile(loadConfig()).applicationId;

      const spin = spinner("Loading payments…");
      let res: ListResponse;
      try {
        res = await oauthRequest<ListResponse>(
          session.apiBase,
          session.accessToken,
          "GET",
          "/payments",
          {
            query: {
              ...(applicationId ? { applicationId } : {}),
              ...(opts.env ? { env: opts.env } : {}),
              ...(opts.status ? { status: opts.status } : {}),
              ...(opts.phone ? { phone: opts.phone } : {}),
              limit: opts.limit ?? "20",
              ...(opts.before ? { before: opts.before } : {}),
            },
          },
        );
      } catch (e) {
        spin.error("Could not load payments.");
        throw e;
      }
      spin.stop();

      if (isJson()) {
        emit({ ok: true, ...res });
        return;
      }

      renderTable(res.payments);

      if (res.nextBefore) {
        line(
          c.dim(`  More results. Next page: paylod payments list --before ${res.nextBefore}`),
        );
        line();
      }
    });

  payments
    .command("get")
    .description("Show one payment in full (with the decoded failure reason)")
    .argument("<paymentId>")
    .action(async (paymentId: string) => {
      const session = await requireOAuth("`paylod payments get`");

      const spin = spinner("Loading payment…");
      let res: { payment: PaymentRow };
      try {
        res = await oauthRequest<{ payment: PaymentRow }>(
          session.apiBase,
          session.accessToken,
          "GET",
          `/payments/${encodeURIComponent(paymentId)}`,
        );
      } catch (e) {
        spin.error("Could not load the payment.");
        throw e;
      }
      spin.stop();

      const p = res.payment;

      if (isJson()) {
        emit({ ok: p.status === "success", ...p });
        return;
      }

      renderPayment(
        {
          id: p.id,
          status: p.status,
          mpesaReceipt: p.mpesaReceipt,
          resultCode: p.resultCode,
          resultDesc: p.resultDesc,
        },
        { amount: p.amount, phone: p.phone },
      );

      kv([
        ["env", p.env],
        ...(p.accountRef ? [["reference", p.accountRef] as const] : []),
        ["created", c.dim(new Date(p.createdAt).toLocaleString())],
        ...(p.settledAt
          ? [["settled", c.dim(new Date(p.settledAt).toLocaleString())] as const]
          : []),
      ]);
      line();

      if (p.status === "failed") process.exitCode = 3;
    });

  return payments;
}

interface ListOpts {
  app?: string;
  env?: "sandbox" | "production";
  status?: PaymentStatus;
  phone?: string;
  limit?: string;
  before?: string;
}

/** Status → a single glyph, so a long list scans at a glance. */
function glyph(status: PaymentStatus): string {
  if (status === "success") return c.green("●");
  if (status === "failed") return c.red("●");
  return c.yellow("◐");
}

function renderTable(rows: readonly PaymentRow[]): void {
  line();
  rule(`payments (${rows.length})`);
  line();

  if (rows.length === 0) {
    warn("No payments found.");
    line(c.dim("  Try `paylod simulate --outcome approve` to create one."));
    line();
    return;
  }

  // Right-align the amount column so the numbers line up and scan vertically.
  const amounts = rows.map((r) => kes(r.amount));
  const width = Math.max(...amounts.map((a) => a.length));

  for (const [i, p] of rows.entries()) {
    const when = new Date(p.createdAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const right =
      p.status === "success"
        ? c.green(p.mpesaReceipt ?? "paid")
        : p.status === "failed"
          ? // Show WHY it failed inline — a list of bare "failed" rows is useless.
            c.red(decodeDarajaResult(p.resultCode, p.resultDesc ?? undefined).title)
          : c.yellow("pending");

    line(
      `  ${glyph(p.status)} ${(amounts[i] ?? "").padStart(width)}  ${c.dim(p.phone.padEnd(13))} ${right}`,
    );
    line(`    ${c.dim(`${when}  ${p.id}`)}`);
  }
  line();
}
