/**
 * OAuth 2.1 client: dynamic client registration + authorization code + PKCE,
 * with a loopback redirect (RFC 8252 native-app flow).
 *
 * Why this shape, given paylod's actual AS (supabase/functions/authz/app.ts):
 *
 *  - The AS supports DCR (RFC 7591) with `token_endpoint_auth_method: none`, i.e.
 *    PUBLIC clients. A CLI cannot keep a client secret, so this is exactly right.
 *  - It accepts `http://127.0.0.1:<port>/...` redirect URIs for native clients, BUT
 *    it matches the redirect_uri by EXACT STRING (`client.redirect_uris.includes(uri)`).
 *    It does NOT do RFC 8252 §7.3 port-agnostic loopback matching. Therefore we must
 *    BIND THE PORT FIRST and only then register a client for that exact URI. Doing it
 *    the other way round (register, then bind) breaks whenever the port is taken.
 *  - `/authorize` REQUIRES `resource` to equal the MCP canonical URI exactly
 *    (`if (q.resource !== MCP_CANONICAL_URI) fail("invalid_target")`). So every token
 *    the CLI holds is audience-bound to https://mcp.paylod.dev/mcp — the same audience
 *    the backend edge functions verify. We pass `resource` on BOTH /authorize and /token.
 *  - PKCE is S256-only. No plain fallback.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { AS_ISSUER, RESOURCE_URI, ALL_SCOPES } from "./config.js";
import { PaylodError } from "./errors.js";

const AUTHORIZE_ENDPOINT = `${AS_ISSUER}/authorize`;
const TOKEN_ENDPOINT = `${AS_ISSUER}/token`;
const REGISTRATION_ENDPOINT = `${AS_ISSUER}/register`;

/** Preferred loopback port (wrangler-style). We fall back to an ephemeral port if taken. */
const PREFERRED_PORT = 8976;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** RFC 7636 PKCE pair. 32 random bytes → 43-char verifier, S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: number;
  readonly scope: string;
  readonly clientId: string;
}

interface TokenEndpointResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

/** Register a fresh public client for THIS exact loopback redirect URI. */
async function registerClient(redirectUri: string, scopes: readonly string[]): Promise<string> {
  const res = await fetch(REGISTRATION_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "paylod CLI",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: scopes.join(" "),
    }),
  });

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.client_id !== "string") {
    throw new PaylodError(
      `Could not register the CLI with paylod's authorization server: ${
        (body.error_description as string) ?? (body.error as string) ?? `HTTP ${res.status}`
      }`,
      { status: res.status, hint: "Is https://paylod.dev/oauth reachable from this machine?" },
    );
  }
  return body.client_id;
}

/** Exchange an authorization code (+ PKCE verifier) for tokens. */
async function exchangeCode(params: {
  code: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
}): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    code_verifier: params.verifier,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    // RFC 8707: the AS pins this to the MCP canonical URI and stamps it as `aud`.
    resource: RESOURCE_URI,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });

  const body = (await res.json().catch(() => ({}))) as Partial<TokenEndpointResponse> &
    Record<string, unknown>;

  if (!res.ok || typeof body.access_token !== "string") {
    throw new PaylodError(
      `Token exchange failed: ${
        (body.error_description as string) ?? (body.error as string) ?? `HTTP ${res.status}`
      }`,
      { status: res.status },
    );
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    // Default to 1h if the AS omits expires_in; we refresh on 401 regardless.
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    scope: body.scope ?? "",
    clientId: params.clientId,
  };
}

/** Refresh an access token. Returns undefined if the refresh token is dead. */
export async function refreshToken(
  refresh: string,
  clientId: string,
): Promise<TokenSet | undefined> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: clientId,
    resource: RESOURCE_URI,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });

  if (!res.ok) return undefined;
  const body = (await res.json().catch(() => ({}))) as Partial<TokenEndpointResponse>;
  if (typeof body.access_token !== "string") return undefined;

  return {
    accessToken: body.access_token,
    // Rotating refresh tokens: keep the NEW one if the AS sent one, else reuse.
    refreshToken: body.refresh_token ?? refresh,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    scope: body.scope ?? "",
    clientId,
  };
}

/** Open a URL in the user's default browser. Best-effort — we always print the URL too. */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* headless / no browser — the printed URL is the fallback */
    });
    child.unref();
  } catch {
    /* ignore — user can copy the URL */
  }
}

/** Constant-time compare for the CSRF `state` echo. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function html(title: string, body: string, accent: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
  body{font:16px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif;display:grid;
       place-items:center;height:100vh;margin:0;background:#0b0d10;color:#e6e9ef}
  .card{text-align:center;padding:2.5rem 3rem;border:1px solid #1e232b;border-radius:14px;background:#11151a}
  h1{margin:0 0 .5rem;font-size:1.4rem;color:${accent}}
  p{margin:0;color:#9aa4b2}
</style>
<div class="card"><h1>${title}</h1><p>${body}</p></div>`;
}

/** Bind the loopback listener, preferring PREFERRED_PORT, else an ephemeral port. */
function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    const tryPort = (port: number, isRetry: boolean): void => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && !isRetry) {
          tryPort(0, true); // 0 → OS picks a free ephemeral port
          return;
        }
        reject(err);
      });
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") resolve({ server, port: addr.port });
        else reject(new Error("Could not determine the loopback port"));
      });
    };
    tryPort(PREFERRED_PORT, false);
  });
}

export interface LoginHandle {
  /** The URL the user must visit. Printed AND opened. */
  readonly authorizeUrl: string;
  /** Resolves once the browser hits the loopback redirect. */
  readonly result: Promise<TokenSet>;
  /** Tear down the loopback server (safe to call twice). */
  cancel(): void;
}

/**
 * Start the login flow. Returns as soon as the loopback server is up and the
 * authorize URL is known, so the caller can print/open it and show a spinner while
 * `handle.result` settles.
 *
 * Order is load-bearing: bind port → register client for that exact URI → authorize.
 */
export async function startLogin(
  scopes: readonly string[] = ALL_SCOPES,
): Promise<LoginHandle> {
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(16));

  let settle!: (t: TokenSet) => void;
  let reject!: (e: unknown) => void;
  const result = new Promise<TokenSet>((res, rej) => {
    settle = res;
    reject = rej;
  });

  let clientId = "";
  let redirectUri = "";
  let done = false;

  const { server, port } = await listen((req, res) => {
    if (done) {
      res.writeHead(404).end();
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    done = true;

    const err = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const gotState = url.searchParams.get("state") ?? "";

    const finish = (status: number, page: string, outcome: () => void): void => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(page);
      outcome();
      setImmediate(() => server.close());
    };

    if (err) {
      finish(400, html("Login cancelled", "You can close this tab.", "#f87171"), () =>
        reject(
          new PaylodError(
            err === "access_denied" ? "You declined the consent screen." : `Login failed: ${err}`,
            { exitCode: 4 },
          ),
        ),
      );
      return;
    }

    // CSRF: the state we generated must come back byte-for-byte.
    if (!gotState || !safeEqual(gotState, state)) {
      finish(400, html("Login failed", "State mismatch — please retry.", "#f87171"), () =>
        reject(
          new PaylodError("OAuth state mismatch — the login response did not match this request.", {
            hint: "This can indicate a stale browser tab. Run `paylod login` again.",
          }),
        ),
      );
      return;
    }

    if (!code) {
      finish(400, html("Login failed", "No authorization code returned.", "#f87171"), () =>
        reject(new PaylodError("The authorization server did not return a code.")),
      );
      return;
    }

    finish(
      200,
      html("You're signed in to paylod", "You can close this tab and return to your terminal.", "#34d399"),
      () => {
        exchangeCode({ code, verifier, redirectUri, clientId }).then(settle, reject);
      },
    );
  });

  redirectUri = `http://127.0.0.1:${port}/callback`;

  try {
    clientId = await registerClient(redirectUri, scopes);
  } catch (e) {
    server.close();
    throw e;
  }

  const authorizeUrl = `${AUTHORIZE_ENDPOINT}?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE_URI,
  }).toString()}`;

  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    server.close();
    reject(new PaylodError("Login timed out after 5 minutes.", { exitCode: 4 }));
  }, LOGIN_TIMEOUT_MS);
  timer.unref();

  return {
    authorizeUrl,
    result: result.finally(() => clearTimeout(timer)),
    cancel: () => {
      done = true;
      clearTimeout(timer);
      server.close();
    },
  };
}
