/**
 * Test helpers: a scratch config dir, a stub paylod API, and a stub authorization server.
 *
 * NOTHING in the test suite is allowed to touch the real paylod backend, the real AS, the
 * user's real config directory, or the user's real OS keychain. Every test that could
 * plausibly do so goes through here. `sandbox()` gives each test its own PAYLOD_CONFIG_DIR
 * under os.tmpdir() and restores the whole environment afterwards.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";

/* ── Environment sandbox ──────────────────────────────────────────────────────── */

export interface Sandbox {
  readonly dir: string;
  /** Restore every env var this sandbox touched and delete the scratch dir. */
  cleanup(): void;
  /** Set an env var, remembering the old value for cleanup. */
  env(key: string, value: string | undefined): void;
}

export function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "paylod-test-"));
  const saved = new Map<string, string | undefined>();

  const setEnv = (key: string, value: string | undefined): void => {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  // Isolate from the developer's real config, real keychain and real backend by default.
  setEnv("PAYLOD_CONFIG_DIR", dir);
  setEnv("PAYLOD_NO_KEYCHAIN", "1");
  setEnv("PAYLOD_API_KEY", undefined);
  setEnv("PAYLOD_API_BASE", undefined);
  setEnv("PAYLOD_WEBHOOK_SECRET", undefined);
  setEnv("PAYLOD_FAKE_PLATFORM", undefined);
  setEnv("PAYLOD_FAKE_HOME", undefined);
  setEnv("XDG_CONFIG_HOME", undefined);

  return {
    dir,
    env: setEnv,
    cleanup() {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* ── A recording HTTP stub ────────────────────────────────────────────────────── */

export interface RecordedRequest {
  readonly method: string;
  /** Path only, no query string. */
  readonly path: string;
  readonly query: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly json: unknown;
}

export type Route = (req: RecordedRequest) => {
  status?: number;
  body?: unknown;
  /** Raw body, used when we need to send something that is not JSON. */
  raw?: string;
  headers?: Record<string, string>;
} | undefined;

export interface StubServer {
  readonly url: string;
  readonly requests: RecordedRequest[];
  /** The most recent request, for the common single-call assertion. */
  last(): RecordedRequest | undefined;
  close(): Promise<void>;
}

/**
 * Stand up a loopback HTTP server that records every request and answers via `route`.
 * Returning `undefined` from `route` yields a 404 — which is itself useful: a command that
 * calls the WRONG endpoint fails loudly rather than silently passing.
 */
export async function stubServer(route: Route): Promise<StubServer> {
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    readBody(req).then((body) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
      }
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers,
        body,
        json: safeJson(body),
      };
      requests.push(recorded);

      const answer = route(recorded);
      if (!answer) {
        res
          .writeHead(404, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: `stub has no route for ${recorded.method} ${recorded.path}` }));
        return;
      }
      res.writeHead(answer.status ?? 200, {
        "Content-Type": "application/json",
        ...answer.headers,
      });
      res.end(answer.raw ?? JSON.stringify(answer.body ?? {}));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    last: () => requests[requests.length - 1],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/* ── A stub authorization server ──────────────────────────────────────────────── */

export interface StubAs extends StubServer {
  /** Tokens the stub will hand out next. Mutate to simulate rotation/expiry. */
  readonly issue: {
    accessToken: string;
    refreshToken?: string;
    expiresIn: number;
    scope: string;
  };
  /** Set to make /token reject — simulates a dead refresh token. */
  rejectToken: boolean;
  /** Every refresh_token value the stub has been asked to redeem. */
  readonly redeemed: string[];
}

/**
 * A stub OAuth 2.1 AS that speaks just enough for the CLI: DCR, and a token endpoint that
 * handles both `authorization_code` and `refresh_token`. Point the CLI at it with
 * PAYLOD_AS_ISSUER. This is what lets us test login and refresh without touching production.
 */
export async function stubAuthServer(): Promise<StubAs> {
  const state = {
    issue: {
      accessToken: "at_stub_1",
      refreshToken: "rt_stub_1",
      expiresIn: 3600,
      scope: "paylod:team.read paylod:apps.write",
    },
    rejectToken: false,
    redeemed: [] as string[],
  };

  const base = await stubServer((req) => {
    if (req.method === "POST" && req.path === "/register") {
      return { status: 201, body: { client_id: `client_${randomUUID()}` } };
    }
    if (req.method === "POST" && req.path === "/token") {
      if (state.rejectToken) {
        return { status: 400, body: { error: "invalid_grant" } };
      }
      const form = new URLSearchParams(req.body);
      const rt = form.get("refresh_token");
      if (rt) state.redeemed.push(rt);
      return {
        status: 200,
        body: {
          access_token: state.issue.accessToken,
          ...(state.issue.refreshToken ? { refresh_token: state.issue.refreshToken } : {}),
          expires_in: state.issue.expiresIn,
          scope: state.issue.scope,
          token_type: "Bearer",
        },
      };
    }
    if (req.method === "POST" && req.path === "/revoke") return { status: 200, body: {} };
    return undefined;
  });

  // `issue` and `redeemed` are objects, so they alias `state` for free. `rejectToken` is a
  // primitive: Object.assign would COPY it, and a test setting `as.rejectToken = true` would
  // then mutate a dead field the route never reads. Expose it as an accessor onto `state`.
  return Object.defineProperties(base, {
    issue: { value: state.issue, enumerable: true },
    redeemed: { value: state.redeemed, enumerable: true },
    rejectToken: {
      enumerable: true,
      get: () => state.rejectToken,
      set: (v: boolean) => {
        state.rejectToken = v;
      },
    },
  }) as StubAs;
}

/* ── Webhook signing (the inverse of what the CLI verifies) ───────────────────── */

/** Sign a raw body exactly the way the paylod webhook-worker does. */
export function signWebhook(secret: string, rawBody: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  return `t=${t},v1=${v1}`;
}

/** A realistic paylod webhook event body. */
export function webhookBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "payment.success",
    created: Math.floor(Date.now() / 1000),
    data: {
      paymentId: "pay_test_1",
      applicationId: "app_test_1",
      env: "sandbox",
      status: "success",
      amount: 100,
      phone: "254708374149",
      accountRef: "ORDER-1",
      mpesaReceipt: "TEST123456",
      checkoutRequestId: "ws_CO_1",
      resultCode: 0,
      resultDesc: "The service request is processed successfully.",
      decoded: null,
      ...overrides,
    },
  });
}

/* ── misc ─────────────────────────────────────────────────────────────────────── */

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
