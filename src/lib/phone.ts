/**
 * Kenyan MSISDN normalisation + validation — the CLI's single source of truth.
 *
 * These are separate npm packages, so a shared module is impossible — keep this byte-identical
 * with the copies (a divergence is a real bug):
 *   - paylod-sdk/src/phone.ts          (reference impl)
 *   - paylod-mcp/src/phone.ts
 *   - mpesa _shared/daraja/primitives.ts (canonical backend copy)
 *
 * Two shapes: MSISDN_INPUT_RE validates RAW input (0712…, 254712…, +254712…, 0112…, 254112…);
 * normalizeMsisdn strips non-digits and emits the wire form matching /^254[17]\d{8}$/. The CLI
 * only validates locally and lets the backend re-normalize, so PHONE_RE / isValidMsisdn is what
 * `collect` actually calls — normalizeMsisdn is exported for parity with the sibling packages.
 */

/** Validates RAW user input in any accepted Kenyan form (before normalization). */
export const MSISDN_INPUT_RE = /^(?:\+?254|0)?[17]\d{8}$/;

/** True if `input` is an acceptable Kenyan MSISDN form. Does not throw. */
export function isValidMsisdn(input: string): boolean {
  return typeof input === "string" && MSISDN_INPUT_RE.test(input.trim());
}

/**
 * Normalize a Kenyan phone number to the `2547XXXXXXXX` / `2541XXXXXXXX` wire form.
 * @throws if the input cannot be resolved to a valid 12-digit MSISDN.
 */
export function normalizeMsisdn(input: string): string {
  const digits = input.replace(/\D+/g, "");

  let msisdn: string;
  if (digits.startsWith("254")) {
    msisdn = digits;
  } else if (digits.startsWith("0")) {
    msisdn = `254${digits.slice(1)}`;
  } else if (digits.startsWith("7") || digits.startsWith("1")) {
    msisdn = `254${digits}`;
  } else {
    throw new Error(`normalizeMsisdn: unrecognized Kenyan phone format: ${input}`);
  }

  if (!/^254[17]\d{8}$/.test(msisdn)) {
    throw new Error(`normalizeMsisdn: not a valid Kenyan MSISDN: ${input}`);
  }
  return msisdn;
}
