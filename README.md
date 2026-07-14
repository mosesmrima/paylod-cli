# paylod CLI

**Accept M-Pesa payments from your terminal.**

```
$ paylod collect --phone 254712345678 --amount 100

── collect ─────────────────────────────────────────────────

   amount  KES 100
    phone  254712345678
     mode  test

✔ STK push sent — 254712345678 should be ringing now. 📲
✔ Customer approved the payment.

── result ──────────────────────────────────────────────────

           Paid ✅  QGR7XK2M9P
   amount  KES 100
    phone  254712345678
  receipt  QGR7XK2M9P
  payment  3f8b2c14-9d5e-4a77-b1c3-6e0a9f2d4b81
```

paylod is a developer-experience layer on Safaricom's M-Pesa Daraja API. No backend
required: one call sends an STK Push, paylod hosts the callback, refreshes the OAuth
token, decodes the result code, and sends you a signed webhook.

This CLI puts all of that — plus a webhook forwarder that **kills ngrok** — in your terminal.

---

## Install

```bash
npx @paylod/cli errors 1032   # zero install, works right now
npm install -g @paylod/cli    # or install it properly
```

The package is `@paylod/cli`; the command it installs is `paylod`.

Node ≥ 20. Works on Linux, macOS and Windows.

## Quickstart — five lines to your first STK push

```bash
paylod login                                    # 1. browser opens, you approve
paylod apps create --name "My Shop"             # 2. create an app (mints an API key)
paylod creds set                                # 3. paste your Daraja keys (masked prompts)
paylod collect --phone 254712345678 --amount 1  # 4. the phone rings
paylod listen --forward localhost:3000/webhook  # 5. webhooks on localhost, no tunnel
```

**No Daraja credentials yet?** You don't need them to start:

```bash
paylod simulate --interactive     # a "fake phone" — approve, wrong PIN, cancel, timeout…
paylod errors 1032                # decode any M-Pesa code, offline, no login
```

---

## `paylod listen` — webhooks on localhost, without ngrok

Daraja's single worst pain point is that the callback must be a **public HTTPS URL**. Testing
locally means running a tunnel, re-registering the URL every restart, and hoping the sandbox
actually calls you back. paylod already hosts and normalizes the callback. `listen` closes the
last mile to `localhost`.

```
$ paylod listen --forward http://localhost:3000/webhook

── paylod listen ───────────────────────────────────────────

   receiving on  http://127.0.0.1:4242
  forwarding to  http://localhost:3000/webhook
     signatures  verified locally

  Waiting for events… (Ctrl-C to stop)

3:13:39 PM  -->  payment.failed   ✔ signature valid
   amount  KES 1,500
    phone  254712345678
     code  1032
      why  Payment cancelled by the customer
      fix  Nothing is wrong with your setup — offer a clear retry so the customer can try again.
  payment  3f8b2c14-9d5e-4a77-b1c3-6e0a9f2d4b81
           <-- [200] POST http://localhost:3000/webhook 13ms
```

### How it's designed

Modelled on `stripe listen`, with one improvement.

`stripe listen` opens an **outbound** WebSocket to a relay; Stripe pushes `{body, headers}`
down it and the CLI replays those bytes verbatim at `--forward-to`. No inbound port, no tunnel.
Notably the Stripe CLI **never computes an HMAC** — the signature is generated server-side and
just passed through.

paylod can do better. Because `POST /webhook-secret` hands the CLI the endpoint's **actual
signing secret**, `paylod listen` **verifies the HMAC locally and prints the verdict**:

```
✔ signature valid
✖ signature invalid — HMAC mismatch — the signing secret does not match this payload
```

That turns "is my signature check right?" — the other thing developers get wrong — into
something you can *see*, live, before writing a line of verification code.

Two event sources feed one pipeline (`verify → filter → print → forward → show response`):

| Source | Status | What it does |
|---|---|---|
| **relay** (default) | ⚠️ **client complete, server route NOT deployed** | SSE stream from paylod. Needs a backend `GET /listen/stream` endpoint that does not exist yet — see below. Degrades gracefully with a clear warning. |
| **direct** (`--port`) | ✅ **works today** | Binds a local receiver. Point a paylod webhook endpoint at it, or POST to it. Exercises the identical verify/forward/print path. |

**Security:** an event whose signature does **not** verify is **never forwarded**. The local
receiver is an open port on `127.0.0.1` — anything on your machine can POST to it. Forwarding
unverified payloads would make `listen` a confused deputy that launders spoofed events into an
app whose author reasonably assumes the CLI checked them. Use `--skip-verify` to opt out.

### What `listen` needs from the backend

The relay is the one piece that is not built. It needs a single endpoint:

```
GET /listen/stream?applicationId=<uuid>
  Authorization: Bearer <OAuth access token>     scope: paylod:webhooks.write
  Accept: text/event-stream

  → text/event-stream, one frame per delivery:
    data: {"body":"<raw JSON bytes exactly as signed>","headers":{"x-webhook-signature":"t=…,v1=…"}}
```

`body` must be the **raw bytes that were signed** — re-serializing the JSON changes key order
and breaks every signature. The CLI side of this is fully implemented in `src/commands/listen.ts`.

---

## Commands

Everything supports `--json` for scripting, and `--help`.

### Payments
| Command | What it does |
|---|---|
| `paylod collect --phone 2547… --amount 100` | Fire a real STK push, live-tail until it settles |
| `paylod status <paymentId> [--watch]` | Look up a payment; decode why it failed |
| `paylod payments list [--status failed]` | Browse the ledger (keyset-paginated) |
| `paylod payments get <paymentId>` | One payment, in full |
| `paylod listen --forward <url>` | Forward webhooks to localhost |
| `paylod simulate [--outcome …] [-i]` | Sandbox simulator — no Daraja, no money |

### Setup & management
| Command | What it does |
|---|---|
| `paylod init` | Guided setup: login → pick app → mint key |
| `paylod login` / `logout` / `whoami` | OAuth 2.1 (PKCE + loopback) |
| `paylod orgs list\|create\|rename` | Organizations |
| `paylod apps list\|use\|create\|rename\|delete` | Applications |
| `paylod creds set` | Store/rotate Daraja credentials (masked prompts) |
| `paylod keys list\|mint\|revoke\|use` | Merchant API keys |
| `paylod webhooks list\|add\|toggle\|delete\|secret` | Webhook endpoints |

### Offline
| Command | What it does |
|---|---|
| `paylod errors <code>` | Decode an M-Pesa result code — no login, instant |
| `paylod errors --list` | The whole catalog |

`paylod errors` uses paylod's **own** error catalog (vendored verbatim from the backend), so
the explanation you get in the terminal is byte-identical to the `decoded` object paylod puts
on your webhook.

---

## Auth, and where your tokens live

paylod has two auth planes and the CLI speaks both:

- **Merchant API keys** (`mp_test_…` / `mp_live_…`) — the runtime/data plane (`collect`,
  `status`). This is what your own server would use.
- **OAuth 2.1** — the management plane. Authorization-code + **PKCE** + **loopback redirect**
  (RFC 8252) against `https://paylod.dev/oauth`, with dynamic client registration.

Tokens are stored, in order of preference:

1. **OS keychain** (macOS Keychain / Windows Credential Manager / libsecret) via the optional
   native `@napi-rs/keyring`. It's an `optionalDependency` on purpose — `npx @paylod/cli` must never
   fail to install because a prebuilt binary is missing for your platform.
2. **A `0600` file** at `~/.config/paylod/config.json` (dir `0700`), written atomically. This is
   the same fallback `gh` and `stripe` ship.

`paylod whoami` always tells you which one is in use. Only the **refresh** token goes to the
keychain; the short-lived access token stays in the config file.

**Scopes.** paylod's consent screen defaults the high-risk scopes (`keys.mint`,
`credentials.write`, `payments.payout`) to **OFF**. If you didn't tick one, the CLI says exactly
that:

```
✖ insufficient scope: paylod:keys.mint
  Your session was not granted `paylod:keys.mint`. Run `paylod login` again and TICK
  "keys.mint" on the consent screen — high-risk scopes default to OFF.
```

## Environment

| Variable | Purpose |
|---|---|
| `PAYLOD_API_KEY` | Merchant API key — skips the config file entirely. Use this in CI. |
| `PAYLOD_API_BASE` | Override the API base URL (default `https://paylod.dev/functions/v1`). |
| `PAYLOD_WEBHOOK_SECRET` | Signing secret for `paylod listen`. |
| `PAYLOD_CONFIG_DIR` | Where config lives (default `~/.config/paylod`). |
| `PAYLOD_NO_KEYCHAIN=1` | Never use the OS keychain; use the `0600` file. |
| `PAYLOD_DEBUG=1` | Print stack traces. |
| `NO_COLOR` | Disable colour. |

See `.env.example`. **No secret is ever committed, logged, or echoed.**

## Exit codes

Scripts can branch on these.

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Generic failure |
| `2` | Bad usage / invalid argument |
| `3` | The payment **failed** (a valid answer, not an error) |
| `4` | Not authenticated |
| `5` | Still pending when we gave up waiting |
| `130` | Interrupted |

```bash
paylod collect -p 254712345678 -a 100 --json > result.json \
  && echo "paid: $(jq -r .mpesaReceipt result.json)" \
  || echo "not paid (exit $?)"
```

## Development

```bash
npm install
npm run build      # tsc → dist/
npm run typecheck
node dist/index.js errors 1032
```

MIT.
