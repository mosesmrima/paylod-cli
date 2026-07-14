/**
 * Shared renderers for the "settle moment" — the payment result block that
 * `collect`, `status` and `simulate` all print. One implementation so the three
 * commands can never drift into printing three different-looking results.
 */

import { color as c, kv, line, rule, kes } from "./ui.js";
import { decodeDarajaResult, type DecodedError } from "./error-catalog.js";
import type { PaymentStatus, StatusResponse } from "./client.js";

/** The one-line verdict. This is the line that gets screenshotted. */
export function verdict(status: PaymentStatus, receipt?: string | null): string {
  switch (status) {
    case "success":
      return `${c.greenBold("Paid ✅")}${receipt ? `  ${c.bold(receipt)}` : ""}`;
    case "failed":
      return c.redBold("Failed ❌");
    default:
      return c.yellow("Pending …");
  }
}

/** Human-readable category label for a decoded error. */
function categoryLabel(d: DecodedError): string {
  switch (d.category) {
    case "customer":
      return c.yellow("customer");
    case "balance":
      return c.yellow("balance");
    case "limit":
      return c.yellow("limit");
    case "credentials":
      return c.red("your credentials");
    case "network":
      return c.yellow("network");
    case "mpesa_system":
      return c.magenta("m-pesa system");
    case "success":
      return c.green("success");
    default:
      return d.category;
  }
}

/**
 * Print a decoded Daraja result. Used by `paylod errors <code>` AND by the failure
 * path of collect/status/simulate — same strings the webhook `decoded` field carries.
 */
export function renderDecoded(d: DecodedError): void {
  rule(`${d.code}  ${d.title}`);
  line();
  kv([
    ["what happened", d.cause],
    ["how to fix", d.fix],
    ["tell the user", c.dim(`"${d.customerMessage}"`)],
    ["at fault", categoryLabel(d)],
    ["retryable", d.retryable ? c.green("yes") : c.red("no")],
  ]);
  line();
}

/** The full result block for a settled (or still-pending) payment. */
export function renderPayment(
  payment: StatusResponse,
  extra?: { amount?: number; phone?: string },
): void {
  line();
  rule("result");
  line();

  const pairs: (readonly [string, string])[] = [["", verdict(payment.status, payment.mpesaReceipt)]];
  if (extra?.amount !== undefined) pairs.push(["amount", kes(extra.amount)]);
  if (extra?.phone) pairs.push(["phone", extra.phone]);
  if (payment.mpesaReceipt) pairs.push(["receipt", c.bold(payment.mpesaReceipt)]);
  pairs.push(["payment", c.dim(payment.id)]);
  kv(pairs);
  line();

  // A non-zero result code always gets the decoded explanation — this is the whole
  // point of paylod: never make a developer google "1032".
  if (payment.status === "failed") {
    const decoded = decodeDarajaResult(payment.resultCode, payment.resultDesc ?? undefined);
    renderDecoded(decoded);
  }
}
