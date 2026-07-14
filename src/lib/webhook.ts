/**
 * paylod webhook signature verification — the exact inverse of the backend's signer
 * (supabase/functions/_shared/webhooks/sign.ts).
 *
 * Scheme (Stripe-style):
 *   header:  x-webhook-signature: t=<unix-seconds>,v1=<hex-hmac>
 *   HMAC:    HMAC-SHA256(secret, `${t}.${rawBody}`)
 *
 * Two properties the backend relies on and we must match exactly:
 *   1. `t` is the EVENT's own `created` timestamp, not the wall clock at send time
 *      (webhook-worker signs over `event.created`). So a replayed/retried delivery
 *      carries the ORIGINAL t — the tolerance window must be generous enough for the
 *      worker's retry schedule, hence the default 5 minutes and a `0` = disabled escape.
 *   2. The HMAC is over the RAW body bytes. Never re-serialize the JSON before
 *      verifying — key order would change and the signature would break.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Header the paylod webhook-worker sends the signature in. */
export const SIGNATURE_HEADER = "x-webhook-signature";

/** Default replay window, in seconds. Pass 0 to disable the freshness check. */
export const DEFAULT_TOLERANCE_SECS = 300;

export type VerifyResult =
  | { readonly valid: true; readonly timestamp: number }
  | { readonly valid: false; readonly reason: string; readonly timestamp?: number };

/** Parse `t=...,v1=...` into its parts. Tolerates whitespace and extra segments. */
export function parseSignatureHeader(
  header: string,
): { t?: number; v1?: string } {
  const out: { t?: number; v1?: string } = {};
  for (const seg of header.split(",")) {
    const idx = seg.indexOf("=");
    if (idx === -1) continue;
    const key = seg.slice(0, idx).trim();
    const value = seg.slice(idx + 1).trim();
    if (key === "t") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) out.t = n;
    } else if (key === "v1") {
      out.v1 = value;
    }
  }
  return out;
}

function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

/**
 * Verify a received signature header against the raw body.
 *
 * Constant-time compare on the HMAC. Returns a structured result rather than a
 * boolean so `paylod listen` can print *why* a signature failed — a wrong secret
 * and a stale timestamp are very different bugs and the developer needs to know which.
 */
export function verifySignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  toleranceSecs: number = DEFAULT_TOLERANCE_SECS,
): VerifyResult {
  if (!header) return { valid: false, reason: `missing ${SIGNATURE_HEADER} header` };

  const { t, v1 } = parseSignatureHeader(header);
  if (t === undefined) return { valid: false, reason: "signature header has no `t` timestamp" };
  if (!v1) return { valid: false, reason: "signature header has no `v1` value" };

  const expected = hmacHex(secret, `${t}.${rawBody}`);

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(v1, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return {
      valid: false,
      reason: "HMAC mismatch — the signing secret does not match this payload",
      timestamp: t,
    };
  }

  // Freshness (replay protection). Checked AFTER the HMAC so an attacker cannot
  // learn anything from timing on the cheap check.
  if (toleranceSecs > 0) {
    const skew = Math.abs(Math.floor(Date.now() / 1000) - t);
    if (skew > toleranceSecs) {
      return {
        valid: false,
        reason: `timestamp is ${skew}s away from now (tolerance ${toleranceSecs}s)`,
        timestamp: t,
      };
    }
  }

  return { valid: true, timestamp: t };
}

/* ── Event shape, mirroring buildEvent() in the backend ─────────────────── */

export type WebhookEventType = "payment.success" | "payment.failed";

export interface DecodedErrorPayload {
  readonly code: string;
  readonly title: string;
  readonly cause: string;
  readonly fix: string;
  readonly category: string;
  readonly retryable: boolean;
  readonly customerMessage: string;
}

export interface WebhookEvent {
  readonly type: WebhookEventType;
  readonly created: number;
  readonly data: {
    readonly paymentId: string;
    readonly applicationId: string;
    readonly env: string;
    readonly status: string;
    readonly amount: number;
    readonly phone: string;
    readonly accountRef: string | null;
    readonly mpesaReceipt: string | null;
    readonly checkoutRequestId: string | null;
    readonly resultCode: number | string | null;
    readonly resultDesc: string | null;
    readonly decoded: DecodedErrorPayload | null;
  };
}

/** Narrow an unknown parsed body to a WebhookEvent, defensively. */
export function asWebhookEvent(value: unknown): WebhookEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== "string" || typeof v.data !== "object" || v.data === null) return undefined;
  return value as WebhookEvent;
}
