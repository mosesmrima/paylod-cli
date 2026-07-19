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

paylod is a developer-experience layer on Safaricom's M-Pesa Daraja API. You do not need a
backend. One call sends an STK push. paylod hosts the callback, refreshes the access token,
decodes the result code, and sends you a signed webhook.

This CLI gives you all of these functions in your terminal. It also gives you a webhook
forwarder that removes the need for a tunnel.

---

## Install

```bash
npx @paylod/cli errors 1032   # zero install, works right now
npm install -g @paylod/cli    # or install it properly
```

The package is `@paylod/cli`. The package installs the command `paylod`.

The CLI needs Node 20 or later. The CLI operates on Linux, macOS and Windows.

## Quickstart — five lines to your first STK push

Run these commands on a server or on your own machine only. Your `PAYLOD_API_KEY` can move
money. Never ship the key in a browser bundle, a mobile application, or any other client.

```bash
paylod login                                    # 1. browser opens, you approve
paylod apps create --name "My Shop"             # 2. create an app (mints an API key)
paylod creds set                                # 3. paste your Daraja keys (masked prompts)
paylod collect --phone 254712345678 --amount 1  # 4. the phone rings
paylod listen --forward localhost:3000/webhook  # 5. webhooks on localhost, no tunnel
```

You do not need Daraja credentials to start. Use these two commands:

```bash
paylod simulate --interactive     # a "fake phone" — approve, wrong PIN, cancel, timeout…
paylod errors 1032                # decode any M-Pesa code, offline, no login
```

---

## `paylod listen` — webhooks on localhost, without ngrok

Daraja requires a **public HTTPS URL** for the callback. A local test therefore needs a tunnel.
You must also register the URL again after each restart. paylod hosts the callback and
normalizes the callback. `listen` then delivers the callback to `localhost`.

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

### The design

The design follows `stripe listen`, with one improvement.

`stripe listen` opens an **outbound** WebSocket to a relay. Stripe pushes `{body, headers}` down
the WebSocket. The CLI then replays those bytes without a change at `--forward-to`. This design
needs no inbound port and no tunnel. The Stripe CLI **never computes an HMAC**. The Stripe
server makes the signature, and the CLI passes the signature through.

`POST /webhook-secret` gives the paylod CLI the **actual signing secret** of the endpoint.
Therefore `paylod listen` **verifies the HMAC locally, and prints the result**:

```
✔ signature valid
✖ signature invalid — HMAC mismatch — the signing secret does not match this payload
```

A signature check is a frequent source of errors. This output shows you the state of the
signature check before you write your own verification code.

Two event sources supply one pipeline (`verify → filter → print → forward → show response`):

| Source | Status | What it does |
|---|---|---|
| **relay** (default) | **The client is complete. The server route is NOT deployed.** | An SSE stream from paylod. The stream needs a backend `GET /listen/stream` endpoint. That endpoint does not exist yet. See the next section. The CLI prints a clear warning, and it continues to operate. |
| **direct** (`--port`) | **This source operates today.** | The CLI binds a local receiver. Point a paylod webhook endpoint at the receiver, or POST to the receiver. This source uses the same verify path, forward path and print path. |

**Security.** The CLI **never forwards** an event with a signature that does not verify. The
local receiver is an open port on `127.0.0.1`. Any program on your machine can POST to that
port. An unverified payload therefore reaches an application whose author expects a checked
event. Use `--skip-verify` to disable the check.

### What `listen` needs from the backend

The relay is the one part that is not built. The relay needs a single endpoint. Verify the
signature against the raw bytes. A re-serialised body does not reproduce the same bytes, and
the signature check then fails.

```
GET /listen/stream?applicationId=<uuid>
  Authorization: Bearer <OAuth access token>     scope: paylod:webhooks.write
  Accept: text/event-stream

  → text/event-stream, one frame per delivery:
    data: {"body":"<raw JSON bytes exactly as signed>","headers":{"x-webhook-signature":"t=…,v1=…"}}
```

`body` must be the **raw bytes that paylod signed**. A second serialization of the JSON changes
the key order, and it breaks every signature. The file `src/commands/listen.ts` contains the
complete CLI part of the relay.

---

## Commands

Every command accepts `--json` for a script, and `--help`.

### Payments
| Command | What it does |
|---|---|
| `paylod collect --phone 2547… --amount 100` | Send a real STK push. Show each event until the payment settles. |
| `paylod status <paymentId> [--watch]` | Read a payment. Decode the reason for a failure. |
| `paylod payments list [--status failed]` | Read the ledger. The list uses keyset pagination. |
| `paylod payments get <paymentId>` | Read one payment in full. |
| `paylod listen --forward <url>` | Forward a webhook to localhost. |
| `paylod simulate [--outcome …] [-i]` | Run the sandbox simulator. No Daraja call. No money. |

### Setup & management
| Command | What it does |
|---|---|
| `paylod init` | Do the guided setup. Log in, select an application, and mint an API key. |
| `paylod login` / `logout` / `whoami` | Use OAuth 2.1 with PKCE and a loopback redirect. |
| `paylod orgs list\|create\|rename` | Manage organizations. |
| `paylod apps list\|use\|create\|rename\|delete` | Manage applications. |
| `paylod creds set` | Store or rotate Daraja credentials. The prompts are masked. |
| `paylod keys list\|mint\|revoke\|use` | Manage merchant API keys. |
| `paylod webhooks list\|add\|toggle\|delete\|secret` | Manage webhook endpoints. |

### Offline
| Command | What it does |
|---|---|
| `paylod errors <code>` | Decode an M-Pesa result code. No login is necessary. |
| `paylod errors --list` | Show the full catalog. |

`paylod errors` uses the **own** error catalog of paylod. paylod vendors the catalog from the
backend without a change. The explanation in your terminal is therefore byte-identical to the
`decoded` object in your webhook.

---

## Auth, and where your tokens live

paylod has two auth planes. The CLI uses both planes:

- **Merchant API keys** (`mp_test_…` / `mp_live_…`) are the runtime plane. `collect` and
  `status` use this plane. Your own server uses a merchant API key.
- **OAuth 2.1** is the management plane. The CLI uses an authorization code with **PKCE** and a
  **loopback redirect** (RFC 8252) against `https://paylod.dev/oauth`. The CLI registers the
  client dynamically.

paylod stores a token in this order of preference:

1. The **OS keychain** (macOS Keychain, Windows Credential Manager or libsecret) through the
   optional native `@napi-rs/keyring`. This package is an `optionalDependency` for a reason. An
   absent prebuilt binary for your platform must never stop `npx @paylod/cli`.
2. **A user-restricted file**. paylod writes the file atomically. `gh` and `stripe` use the same
   fallback.

Only the **refresh** token goes to the keychain. The short-lived access token stays in the
config file.

**paylod tells you when it does not use the keychain, and it tells you the reason.** A refresh
token in the macOS Keychain and a refresh token in a file do not have the same security
posture. Only you can decide whether the difference is important to you. `paylod login` and
`paylod whoami` both report the store in use. If the store is the file, both commands report
the reason.

### Where the credential file lives

| Platform | Path |
|---|---|
| Linux | `$XDG_CONFIG_HOME/paylod` or `~/.config/paylod` |
| macOS | `~/Library/Application Support/paylod` |
| Windows | `%APPDATA%\paylod` |

`PAYLOD_CONFIG_DIR` overrides all of these paths. paylod continues to use a `~/.config/paylod`
directory from an older version. An upgrade therefore keeps your login.

### How the file is protected

| Platform | Mechanism |
|---|---|
| Linux / macOS | A `0600` file inside a `0700` directory. paylod then **verifies** the file with `stat`. |
| Windows | An explicit ACL (`icacls /inheritance:r /grant:r <you>:F`). paylod then **verifies** the ACL with a second read. |

> **Fixed in 0.2.0.** Through 0.1.0 the CLI called `chmod(0600)` on every platform, and the CLI
> called that call the guarantee. On Windows `chmod` is a **no-op**. The call does not throw an
> error, and the call does not restrict any user. The credential file holds OAuth tokens and
> `mp_live_` API keys that move real money. That file kept the inherited ACLs, and other users
> of the machine could read the file.
>
> paylod now applies the mechanism that operates correctly on the host, and paylod verifies the
> mechanism. **If paylod cannot protect the file, paylod reports the failure on stderr.** paylod
> does not claim a protection that paylod does not supply. `paylod whoami` reports the real,
> newly measured state of the file.


**Scopes.** The consent screen of paylod sets the high-risk scopes (`keys.mint`,
`credentials.write`, `payments.payout`) to **OFF** by default. If you did not select a scope,
the CLI reports the exact scope:

```
✖ insufficient scope: paylod:keys.mint
  Your session was not granted `paylod:keys.mint`. Run `paylod login` again and TICK
  "keys.mint" on the consent screen — high-risk scopes default to OFF.
```

## Environment

| Variable | Purpose |
|---|---|
| `PAYLOD_API_KEY` | The merchant API key. The CLI then does not read the config file. Use this variable in CI. |
| `PAYLOD_API_BASE` | Override the API base URL. The default is `https://paylod.dev/functions/v1`. |
| `PAYLOD_WEBHOOK_SECRET` | The signing secret for `paylod listen`. |
| `PAYLOD_CONFIG_DIR` | The location of the config. See "Where the credential file lives". |
| `PAYLOD_NO_KEYCHAIN=1` | Never use the OS keychain. Use the credential file. |
| `PAYLOD_AS_ISSUER` | Override the OAuth authorization server. |
| `PAYLOD_SUPPRESS_PERMISSION_WARNING=1` | Stop the "could not restrict your credential file" warning. Set this variable only after you read the warning and accept the risk. |
| `PAYLOD_DEBUG=1` | Print stack traces. |
| `NO_COLOR` | Disable colour. |

See `.env.example`. **paylod never commits a secret, never logs a secret, and never echoes a
secret.**

## Exit codes

A script can branch on these codes.

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Generic failure |
| `2` | Incorrect usage or an invalid argument |
| `3` | The payment **failed**. This result is a valid outcome, not an error. |
| `4` | You are not authenticated |
| `5` | The payment was still pending when the CLI stopped the wait |
| `130` | The CLI was interrupted |

```bash
paylod collect -p 254712345678 -a 100 --json > result.json \
  && echo "paid: $(jq -r .mpesaReceipt result.json)" \
  || echo "not paid (exit $?)"
```

## Development

First, install the dependencies. Then build the CLI and run it once:

```bash
npm install
npm run build      # tsc → dist/
npm run typecheck
node dist/index.js errors 1032
```

Use these commands during development:

```bash
npm run build          # compile to dist/ (what ships — tests excluded)
npm test               # compile tests to build/test/ and run them
npm run typecheck      # type-check everything, including tests
npm run catalog:check  # fail if the vendored Daraja catalog has drifted
```

### The Daraja error catalog is GENERATED — do not hand-edit it

The script `scripts/vendor-daraja-catalog.mjs` vendors `src/lib/daraja-catalog.ts` and
`src/lib/daraja-error-codes.ts` from the single source of truth in the paylod monorepo. Both
files carry a DO-NOT-EDIT banner.

This rule is important. `retryable` in that table means **SAFE TO CHARGE AGAIN**. It does not
mean that the customer may press a button. A hand-maintained copy of the table drifts from the
payment engine. Such a drift caused a customer-facing **double charge two times**. Through
0.1.0 the CLI carried a fifth, hand-written fork of the table, and that fork had already
drifted. An unknown result code decoded as `retryable: true`, which invites a second charge of
a payment with an unproved outcome. Result code `1037` also claimed that the handset of the
customer was unreachable. In most cases the customer only ignored the STK push.

```bash
node scripts/vendor-daraja-catalog.mjs            # regenerate from the monorepo
node scripts/vendor-daraja-catalog.mjs --check    # CI drift guard (exit 1 on drift)
```

The script finds the monorepo at `../mpesa`, or at the path in `PAYLOD_MONOREPO`. Without the
monorepo, `--check` skips the comparison. The generated files are committed, so a build of the
CLI never needs the monorepo.

## Licence

MIT.
