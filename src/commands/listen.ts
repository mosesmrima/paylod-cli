/**
 * `paylod listen --forward http://localhost:3000/webhook`
 *
 * The command that kills ngrok. Daraja's #1 pain point is that the callback must be
 * a PUBLIC https URL, so testing locally means running a tunnel, re-registering the
 * URL every restart, and praying the sandbox actually calls you back. paylod already
 * hosts and normalizes the callback; `listen` closes the last mile to localhost.
 *
 * ── Architecture (modelled on `stripe listen`) ─────────────────────────────────
 *
 * stripe listen works like this: the CLI opens an OUTBOUND websocket to a relay
 * (wss://stripe-cli.stripe.com), Stripe pushes `{body, headers}` down it, the CLI
 * replays those bytes verbatim at --forward-to, then acks. No inbound port, no tunnel.
 * Notably the Stripe CLI does NOT compute the HMAC — the signature is generated
 * server-side with a per-device session secret and shipped in the headers.
 *
 * paylod can do one thing better. Because `POST /webhook-secret` hands the CLI the
 * endpoint's ACTUAL signing secret, `paylod listen` VERIFIES the HMAC locally and
 * prints the verdict. That turns "did my signature check work?" — the other thing
 * developers get wrong — into something you can see, live, before you write a line
 * of verification code.
 *
 * Two event sources, one pipeline:
 *
 *   relay  (--relay, default)  SSE over HTTPS from paylod. Requires a backend
 *                              streaming endpoint. ⚠️ NOT YET DEPLOYED — see README.
 *                              The client is complete; the server route is the gap.
 *
 *   direct (--port)            The CLI binds a local receiver and accepts POSTs. Point
 *                              a paylod webhook endpoint at it (through any tunnel), or
 *                              curl it. Works TODAY and exercises the exact same
 *                              verify → print → forward → ack pipeline.
 *
 * Both feed `handleEvent()`, so whichever way the bytes arrive the behaviour is identical.
 */

import { createServer, type IncomingMessage } from "node:http";
import { Command } from "commander";
import { loadConfig, currentProfile, resolveApiBase, withProfile, saveConfig } from "../lib/config.js";
import { requireOAuth } from "../lib/session.js";
import { oauthRequest, endpointId, type WebhookEndpoint } from "../lib/client.js";
import {
  verifySignature,
  asWebhookEvent,
  SIGNATURE_HEADER,
  DEFAULT_TOLERANCE_SECS,
  type WebhookEvent,
} from "../lib/webhook.js";
import { color as c, emit, isJson, line, kv, rule, kes, ok, warn, fail } from "../lib/ui.js";
import { PaylodError } from "../lib/errors.js";

const DEFAULT_LISTEN_PORT = 4242;

export function listenCommand(): Command {
  return new Command("listen")
    .description("Forward paylod webhooks to your local server (no ngrok)")
    .option("-f, --forward <url>", "POST each event to this local URL")
    .option("-e, --events <types...>", "only show these event types (payment.success, payment.failed)")
    .option("--secret <whsec>", "webhook signing secret (else your profile, else fetched)")
    .option("--skip-verify", "do not verify the HMAC signature")
    .option("--tolerance <secs>", `signature freshness window (default ${DEFAULT_TOLERANCE_SECS}, 0 = off)`)
    .option("--print-json", "print the full JSON payload of every event")
    .option("--port <port>", `local receiver port (default ${DEFAULT_LISTEN_PORT})`)
    .option("--app <applicationId>", "application whose webhooks to stream")
    .option("--relay <url>", "override the paylod relay endpoint")
    .option("--no-relay", "skip the relay; only accept direct POSTs to the local receiver")
    .addHelpText(
      "after",
      `
Examples:
  $ paylod listen --forward http://localhost:3000/webhook
  $ paylod listen -f http://localhost:3000/hook -e payment.success
  $ paylod listen --print-json --no-relay

Then, in another terminal, make something happen:
  $ paylod simulate --outcome approve
`,
    )
    .action(async (opts: ListenOpts) => {
      const forward = opts.forward;
      if (forward && !/^https?:\/\//i.test(forward)) {
        throw new PaylodError(`--forward must be an http(s) URL, got: ${forward}`, {
          hint: "e.g. --forward http://localhost:3000/webhook",
          exitCode: 2,
        });
      }

      const tolerance = opts.tolerance
        ? Number.parseInt(String(opts.tolerance), 10)
        : DEFAULT_TOLERANCE_SECS;
      const port = opts.port ? Number.parseInt(String(opts.port), 10) : DEFAULT_LISTEN_PORT;

      const secret = opts.skipVerify ? undefined : await resolveSecret(opts);

      const ctx: Ctx = {
        forward,
        secret,
        skipVerify: Boolean(opts.skipVerify),
        tolerance,
        printJson: Boolean(opts.printJson),
        events: opts.events,
        seen: 0,
        queue: Promise.resolve(),
      };

      // ── Local receiver (the "direct" source). Always on: it is also the health
      //    surface and the thing you point a tunnel at.
      const server = createServer((req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "text/plain" }).end("POST only\n");
          return;
        }
        readBody(req)
          .then((raw) => {
            // Ack the sender FIRST — paylod's webhook-worker retries on non-2xx, and a slow
            // local handler must never cause a duplicate delivery. Then hand off to the
            // serial queue so the printed log stays coherent under concurrent deliveries.
            res.writeHead(200, { "Content-Type": "application/json" }).end('{"received":true}\n');
            enqueue(ctx, () => handleEvent(ctx, raw, headersOf(req)));
          })
          .catch(() => {
            if (!res.headersSent) res.writeHead(400).end();
          });
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });

      printBanner(ctx, port, opts);

      // ── Relay (the "push" source), unless --no-relay.
      let relayAbort: AbortController | undefined;
      if (opts.relay !== false) {
        relayAbort = new AbortController();
        void connectRelay(ctx, opts, relayAbort.signal);
      }

      // Stay alive until Ctrl-C.
      await new Promise<void>((resolve) => {
        const shutdown = (): void => {
          relayAbort?.abort();
          server.close();
          if (!isJson()) {
            line();
            line(c.dim(`  Stopped. ${ctx.seen} event${ctx.seen === 1 ? "" : "s"} handled.`));
            line();
          }
          resolve();
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
    });
}

interface ListenOpts {
  forward?: string;
  events?: string[];
  secret?: string;
  skipVerify?: boolean;
  tolerance?: string;
  printJson?: boolean;
  port?: string;
  app?: string;
  relay?: string | false;
}

interface Ctx {
  forward?: string;
  secret?: string;
  skipVerify: boolean;
  tolerance: number;
  printJson: boolean;
  events?: string[];
  seen: number;
  /** Tail of the serialization chain — see enqueue(). */
  queue: Promise<void>;
}

/**
 * Serialize event handling.
 *
 * Deliveries arrive concurrently (paylod's webhook-worker fans out, and retries can land on
 * top of new events). Without this, two events interleave and you get both `-->` lines
 * followed by both `<--` lines — the log stops being readable exactly when you most need it.
 * Chaining onto a single promise keeps each event's request/response pair adjacent, at the
 * cost of forwarding strictly in order, which is what a human tailing a log actually wants.
 */
function enqueue(ctx: Ctx, task: () => Promise<void>): void {
  ctx.queue = ctx.queue.then(task).catch(() => {
    /* one bad event must never break the stream */
  });
}

/* ── The one pipeline every event goes through ──────────────────────────────── */

/**
 * verify → filter → print → forward → print the local response.
 *
 * `raw` MUST be the exact bytes as received: the HMAC is computed over the raw body,
 * so re-serializing the parsed JSON would silently break every signature.
 */
async function handleEvent(
  ctx: Ctx,
  raw: string,
  headers: Record<string, string>,
): Promise<void> {
  const sigHeader = headers[SIGNATURE_HEADER];

  let verified: { valid: boolean; reason?: string } = { valid: false, reason: "not checked" };
  if (ctx.skipVerify) {
    verified = { valid: true };
  } else if (ctx.secret) {
    const r = verifySignature(raw, sigHeader, ctx.secret, ctx.tolerance);
    verified = r.valid ? { valid: true } : { valid: false, reason: r.reason };
  } else {
    verified = { valid: false, reason: "no signing secret available" };
  }

  const parsed: unknown = safeJson(raw);
  const event = asWebhookEvent(parsed);

  if (ctx.events?.length && event && !ctx.events.includes(event.type)) return;

  ctx.seen += 1;

  if (isJson()) {
    emit({
      ok: true,
      signature: ctx.skipVerify ? "skipped" : verified.valid ? "valid" : "invalid",
      ...(verified.reason ? { signatureError: verified.reason } : {}),
      forwarded: Boolean(ctx.forward) && verified.valid,
      event: parsed,
    });
  } else {
    printEvent(ctx, event, parsed, verified);
  }

  // SECURITY: never replay an unverified payload at the developer's server.
  //
  // The local receiver is an open port on 127.0.0.1 — any process on this machine can POST
  // to it. If we forwarded whatever arrived, `paylod listen` would be a confused deputy that
  // launders spoofed events into an app whose author reasonably assumes the CLI checked them.
  // A failed HMAC means "this did not come from paylod", so we drop it and say so loudly.
  // `--skip-verify` remains the explicit opt-out for someone who knows what they are doing.
  if (!ctx.forward) return;

  if (!verified.valid) {
    if (!isJson()) {
      line(
        `           ${c.yellow("⚠")}  ${c.dim("not forwarded — signature did not verify")}`,
      );
      if (!ctx.secret && !ctx.skipVerify) {
        line(
          c.dim("               set a secret with `paylod webhooks secret`, or pass --skip-verify"),
        );
      }
    }
    return;
  }

  await forwardEvent(ctx, raw, headers);
}

function printEvent(
  ctx: Ctx,
  event: WebhookEvent | undefined,
  parsed: unknown,
  verified: { valid: boolean; reason?: string },
): void {
  const time = c.dim(new Date().toLocaleTimeString());
  const sig = ctx.skipVerify
    ? c.dim("sig skipped")
    : verified.valid
      ? c.green("✔ signature valid")
      : c.red(`✖ signature invalid — ${verified.reason}`);

  if (!event) {
    line(`${time}  ${c.yellow("-->")} ${c.dim("(unrecognized payload)")}   ${sig}`);
    if (ctx.printJson) line(c.dim(JSON.stringify(parsed, null, 2)));
    return;
  }

  const d = event.data;
  const isSuccess = event.type === "payment.success";
  const badge = isSuccess ? c.greenBold(" payment.success ") : c.redBold(" payment.failed ");

  line();
  line(`${time}  ${c.cyan("-->")} ${badge}  ${sig}`);

  const pairs: (readonly [string, string])[] = [
    ["amount", kes(d.amount)],
    ["phone", d.phone],
  ];
  if (d.mpesaReceipt) pairs.push(["receipt", c.bold(d.mpesaReceipt)]);
  if (d.resultCode !== null && d.resultCode !== undefined && !isSuccess) {
    pairs.push(["code", c.red(String(d.resultCode))]);
  }
  // The `decoded` block paylod puts on the webhook — the whole reason this product exists.
  if (d.decoded) {
    pairs.push(["why", d.decoded.title]);
    pairs.push(["fix", c.dim(d.decoded.fix)]);
  }
  pairs.push(["payment", c.dim(d.paymentId)]);
  kv(pairs);

  if (ctx.printJson) {
    line();
    line(c.dim(JSON.stringify(parsed, null, 2)));
  }
}

/** Replay the raw bytes + signature headers at the local endpoint, verbatim. */
async function forwardEvent(
  ctx: Ctx,
  raw: string,
  headers: Record<string, string>,
): Promise<void> {
  if (!ctx.forward) return;
  const started = Date.now();

  try {
    const res = await fetch(ctx.forward, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "paylod-cli/listen",
        // Pass the signature through UNCHANGED so the developer's real verification
        // code — the code that will run in production — is what gets exercised.
        ...(headers[SIGNATURE_HEADER] ? { [SIGNATURE_HEADER]: headers[SIGNATURE_HEADER] } : {}),
      },
      body: raw,
      signal: AbortSignal.timeout(30_000),
    });

    const ms = Date.now() - started;
    const code = res.status;
    const okish = code >= 200 && code < 300;
    const painted = okish ? c.green(`[${code}]`) : c.red(`[${code}]`);
    line(
      `           ${c.cyan("<--")} ${painted} POST ${c.dim(ctx.forward)} ${c.dim(`${ms}ms`)}`,
    );
    if (!okish) {
      line(
        c.dim(
          `               your handler returned ${code} — paylod would retry this delivery`,
        ),
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    line(`           ${c.red("<--")} ${c.red("connection failed")} ${c.dim(ctx.forward)}`);
    line(c.dim(`               ${msg}`));
    line(c.dim(`               is your server running on ${ctx.forward}?`));
  }
}

/* ── Event sources ──────────────────────────────────────────────────────────── */

/**
 * Connect to the paylod relay and stream events (SSE).
 *
 * ⚠️ The backend route this talks to (`GET /listen/stream`) DOES NOT EXIST YET. The
 * client below is complete and correct; deploying the server side is a separate,
 * small piece of work (see README → "What `listen` needs from the backend"). Until
 * then we degrade gracefully: warn once, and keep the direct receiver running so the
 * command is still useful.
 */
async function connectRelay(
  ctx: Ctx,
  opts: ListenOpts,
  signal: AbortSignal,
): Promise<void> {
  let session;
  try {
    session = await requireOAuth("`paylod listen`");
  } catch {
    if (!isJson()) {
      warn("Not logged in — the relay is disabled. The local receiver is still running.");
      line(c.dim("  Run `paylod login` to stream events from paylod."));
      line();
    }
    return;
  }

  const config = loadConfig();
  const applicationId = opts.app ?? currentProfile(config).applicationId;
  const base = typeof opts.relay === "string" ? opts.relay : `${resolveApiBase(config)}/listen/stream`;
  const url = applicationId
    ? `${base}?applicationId=${encodeURIComponent(applicationId)}`
    : base;

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Accept: "text/event-stream",
      },
      signal,
    });

    if (!res.ok || !res.body) {
      relayUnavailable(res.status);
      return;
    }

    if (!isJson()) {
      ok(`Streaming live events from paylod. ${c.dim("(Ctrl-C to stop)")}`);
      line();
    }

    // Minimal SSE framing: events are separated by a blank line; we only care about
    // `data:` lines, each of which carries one webhook delivery as JSON.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!data) continue;

        // The relay envelope mirrors Stripe's: the raw body plus the headers we signed
        // it with, so the CLI can verify AND replay without re-serializing anything.
        const envelope = safeJson(data) as
          | { body?: string; headers?: Record<string, string> }
          | undefined;
        if (!envelope?.body) continue;

        const body = envelope.body;
        const hdrs = lowerKeys(envelope.headers ?? {});
        enqueue(ctx, () => handleEvent(ctx, body, hdrs));
      }
    }
  } catch (e) {
    if (signal.aborted) return;
    relayUnavailable(undefined, e instanceof Error ? e.message : String(e));
  }
}

/** One clear, honest message when the relay isn't there. Never a stack trace. */
function relayUnavailable(status?: number, detail?: string): void {
  if (isJson()) return;
  warn(
    `The paylod event relay is not available${status ? ` (HTTP ${status})` : ""} — running in direct mode.`,
  );
  if (detail) line(c.dim(`  ${detail}`));
  line(
    c.dim(
      "  The local receiver below still works: point a paylod webhook endpoint at it,\n" +
        "  or POST to it directly. Events will be verified and forwarded as normal.",
    ),
  );
  line();
}

/* ── Setup helpers ──────────────────────────────────────────────────────────── */

/**
 * Find the signing secret: --secret > profile > ask paylod for it.
 *
 * We cache it in the profile so `listen` starts instantly next time and so the same
 * secret is used across restarts (matching Stripe's "stable whsec per device" feel).
 */
async function resolveSecret(opts: ListenOpts): Promise<string | undefined> {
  if (opts.secret) return opts.secret;
  if (process.env.PAYLOD_WEBHOOK_SECRET) return process.env.PAYLOD_WEBHOOK_SECRET;

  const config = loadConfig();
  const cached = currentProfile(config).webhookSecret;
  if (cached) return cached;

  // Not cached → try to mint/read one. Requires login + an application.
  let session;
  try {
    session = await requireOAuth("`paylod listen`");
  } catch {
    return undefined;
  }

  const applicationId = opts.app ?? currentProfile(config).applicationId;
  if (!applicationId) return undefined;

  // /webhook-secret takes { webhookEndpointId } — NOT { applicationId }. Resolve the
  // app's single endpoint first. We deliberately do NOT roll a secret when there are
  // several endpoints: rolling invalidates the previous secret, and silently breaking
  // a live integration just because someone ran `listen` would be unforgivable.
  try {
    const list = await oauthRequest<{ endpoints?: readonly WebhookEndpoint[] }>(
      session.apiBase,
      session.accessToken,
      "GET",
      "/webhook-endpoints",
      { query: { applicationId } },
    );
    const endpoints = list.endpoints ?? [];
    if (endpoints.length !== 1) return undefined;

    const res = await oauthRequest<{ signingSecret?: string }>(
      session.apiBase,
      session.accessToken,
      "POST",
      "/webhook-secret",
      { body: { webhookEndpointId: endpointId(endpoints[0]!) } },
    );
    if (res.signingSecret) {
      saveConfig(withProfile(loadConfig(), { webhookSecret: res.signingSecret }));
      return res.signingSecret;
    }
  } catch {
    /* no secret → listen still runs, it just cannot verify */
  }
  return undefined;
}

function printBanner(ctx: Ctx, port: number, opts: ListenOpts): void {
  if (isJson()) return;

  line();
  rule("paylod listen");
  line();

  const pairs: (readonly [string, string])[] = [
    ["receiving on", c.cyan(`http://127.0.0.1:${port}`)],
  ];
  if (ctx.forward) pairs.push(["forwarding to", c.cyan(ctx.forward)]);
  else pairs.push(["forwarding to", c.dim("nothing — printing only (use --forward)")]);

  pairs.push([
    "signatures",
    ctx.skipVerify
      ? c.yellow("not verified (--skip-verify)")
      : ctx.secret
        ? c.green("verified locally")
        : c.yellow("no secret — cannot verify"),
  ]);
  if (ctx.events?.length) pairs.push(["filter", ctx.events.join(", ")]);

  kv(pairs);
  line();

  if (!ctx.secret && !ctx.skipVerify) {
    warn("No webhook signing secret found — signatures will show as unverified.");
    line(c.dim("  Get one with `paylod webhooks secret`, or pass --secret whsec_…"));
    line();
  }

  line(c.dim("  Waiting for events… (Ctrl-C to stop)"));
  line(c.dim("  Try: paylod simulate --outcome approve"));
  line();
}

/* ── Small utilities ────────────────────────────────────────────────────────── */

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // A webhook is a few KB. Anything huge is not ours — don't buffer it.
      if (size > 1_000_000) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function headersOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
    else if (Array.isArray(v) && v[0]) out[k.toLowerCase()] = v[0];
  }
  return out;
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
