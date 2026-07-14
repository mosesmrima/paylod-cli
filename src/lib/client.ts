/**
 * HTTP client for the paylod backend.
 *
 * paylod has TWO auth planes and the CLI speaks both:
 *
 *   1. MERCHANT API KEY (`mp_live_` / `mp_test_`) — the runtime/data plane.
 *      POST /collect, GET /status/:id. This is what a merchant's server uses.
 *
 *   2. OAUTH ACCESS TOKEN (ES256, aud=https://mcp.paylod.dev/mcp) — the management
 *      plane. GET /apps, POST /provision, /save-credentials, /mint-key,
 *      /webhook-endpoints, /provider-ops/*, /simulate/*.
 *
 * Both are `Authorization: Bearer <token>` — the backend tells them apart by shape
 * (see _shared/auth/session.ts). Callers pick the plane by choosing `apiKeyRequest`
 * or `oauthRequest`; that keeps a management token from ever leaking into a data-plane
 * call and vice versa.
 */

import { PaylodError } from "./errors.js";

export interface RequestOptions {
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly idempotencyKey?: string;
  readonly timeoutMs?: number;
}

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

const DEFAULT_TIMEOUT_MS = 30_000;
const USER_AGENT = "paylod-cli";

function buildUrl(
  base: string,
  path: string,
  query?: RequestOptions["query"],
): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  const url = `${base.replace(/\/+$/, "")}${clean}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * The one place a request actually goes out. Everything else is a thin wrapper.
 * Non-2xx becomes a PaylodError carrying the status + parsed body so commands can
 * render a good message (and `--json` can still emit structured failure).
 */
async function request<T>(
  base: string,
  bearer: string,
  method: HttpMethod,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const url = buildUrl(base, path, opts.query);

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    Authorization: `Bearer ${bearer}`,
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new PaylodError(`Request to ${path} timed out`, {
        hint: "Check your connection, or raise the timeout with --timeout.",
      });
    }
    throw new PaylodError(
      `Could not reach paylod at ${base}: ${err instanceof Error ? err.message : String(err)}`,
      { hint: "Are you online? Is PAYLOD_API_BASE set correctly?" },
    );
  } finally {
    clearTimeout(timeout);
  }

  const raw = await res.text();
  const parsed: unknown = raw ? safeJson(raw) : undefined;

  if (!res.ok) {
    const message =
      (isRecord(parsed) && typeof parsed.error === "string" && parsed.error) ||
      (isRecord(parsed) &&
        typeof parsed.error_description === "string" &&
        parsed.error_description) ||
      `paylod returned HTTP ${res.status}`;
    throw new PaylodError(message, {
      status: res.status,
      body: parsed ?? raw,
      hint: hintFor(res.status, message),
    });
  }

  return parsed as T;
}

/**
 * Turn a status code (+ the server's message) into an actionable next step.
 * This is most of what "good errors" actually means.
 *
 * The 403 case matters most: verifyAccess returns `insufficient scope: paylod:keys.mint`
 * and the consent screen defaults the high-risk scopes to OFF — so the single most
 * likely failure for a new user is a scope they didn't tick. Name it, and give them
 * the exact command that fixes it.
 */
function hintFor(status: number, message: string): string | undefined {
  if (status === 403) {
    const m = /insufficient scope:\s*(\S+)/i.exec(message);
    if (m?.[1]) {
      const scope = m[1];
      const short = scope.replace(/^paylod:/, "");
      // `paylod login` already REQUESTS every scope — but the consent screen defaults
      // the high-risk ones (keys.mint, credentials.write, payments.payout) to OFF. So
      // the fix is almost always "go tick the box", not "ask for it differently".
      return `Your session was not granted \`${scope}\`. Run \`paylod login\` again and TICK "${short}" on the consent screen — high-risk scopes default to OFF.`;
    }
    return "Your token lacks the required scope, or your role in this organization is not allowed to do this.";
  }
  return hintForStatus(status);
}

function hintForStatus(status: number): string | undefined {
  switch (status) {
    case 401:
      return "Your credentials were rejected. Run `paylod login`, or check PAYLOD_API_KEY.";
    case 404:
      return "Not found — double-check the id, and that it belongs to this application.";
    case 409:
      return "Idempotency-Key was reused with a different body. Use a fresh key.";
    case 422:
      return "The request failed validation — check the field mentioned above.";
    case 429:
      return "Rate limited. Wait a moment and retry.";
    case 502:
      return "paylod reached Safaricom but Daraja failed. This is usually transient — retry.";
    default:
      return undefined;
  }
}

/** Data plane: authenticate with a merchant API key. */
export function apiKeyRequest<T>(
  base: string,
  apiKey: string,
  method: HttpMethod,
  path: string,
  opts?: RequestOptions,
): Promise<T> {
  return request<T>(base, apiKey, method, path, opts);
}

/** Management plane: authenticate with an OAuth access token. */
export function oauthRequest<T>(
  base: string,
  accessToken: string,
  method: HttpMethod,
  path: string,
  opts?: RequestOptions,
): Promise<T> {
  return request<T>(base, accessToken, method, path, opts);
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/* ── Response shapes (mirrors the backend contracts) ───────────────────── */

export interface CollectResponse {
  readonly paymentId: string;
  readonly status: "pending";
  readonly checkoutRequestId: string;
}

export type PaymentStatus = "pending" | "success" | "failed";

export interface StatusResponse {
  readonly id: string;
  readonly status: PaymentStatus;
  readonly mpesaReceipt: string | null;
  readonly resultCode: number | string | null;
  readonly resultDesc: string | null;
}

export interface Application {
  readonly applicationId: string;
  readonly name: string;
  readonly provider: string;
  readonly organizationId: string;
}

export interface AppsResponse {
  readonly applications: readonly Application[];
}

export interface SimulateCollectResponse {
  readonly paymentId: string;
  readonly checkoutRequestId: string;
  readonly status: string;
  readonly provider?: string;
  /** Objects — `[{ id, label, status }]` — NOT bare strings. */
  readonly outcomes?: readonly SimOutcome[];
}

export interface SimulateOutcomeResponse {
  readonly paymentId: string;
  readonly status: PaymentStatus;
  readonly resultCode: number | string | null;
  readonly resultDesc: string | null;
  readonly mpesaReceipt: string | null;
  readonly webhookQueued?: boolean;
}

/**
 * Webhook endpoint.
 *
 * ⚠️ The backend is INCONSISTENT here and the CLI has to absorb it:
 *   POST /webhook-endpoints  → { webhookEndpointId, url, active }
 *   GET  /webhook-endpoints  → { endpoints: [{ id, url, active, ... }] }   ← `id`, not `webhookEndpointId`
 * Use `endpointId()` to read the id from either shape rather than picking one and
 * being silently wrong on the other.
 */
export interface WebhookEndpoint {
  readonly webhookEndpointId?: string;
  readonly id?: string;
  readonly url: string;
  readonly active: boolean;
  readonly hasSigningSecret?: boolean;
  readonly createdAt?: string;
}

/** Read the endpoint id from either the POST or the GET shape. */
export function endpointId(e: WebhookEndpoint): string {
  const id = e.webhookEndpointId ?? e.id;
  if (!id) throw new PaylodError("paylod returned a webhook endpoint with no id.", { body: e });
  return id;
}

/** A sandbox simulator outcome. The backend returns objects, not bare strings. */
export interface SimOutcome {
  readonly id: string;
  readonly label: string;
  readonly status: string;
}

export interface PaymentRow {
  readonly id: string;
  readonly applicationId: string;
  readonly env: string;
  readonly status: PaymentStatus;
  readonly amount: number;
  readonly phone: string;
  readonly accountRef: string | null;
  readonly mpesaReceipt: string | null;
  readonly resultCode: number | string | null;
  readonly resultDesc: string | null;
  readonly createdAt: string;
  readonly settledAt?: string | null;
}

export interface ApiKeyRow {
  readonly id: string;
  readonly prefix: string;
  readonly env: string;
  readonly name?: string | null;
  readonly lastUsedAt?: string | null;
  readonly revokedAt?: string | null;
  readonly createdAt: string;
}

export interface Organization {
  readonly organizationId: string;
  readonly name: string;
  readonly role: string;
  readonly mode?: string;
  readonly createdAt?: string;
}
