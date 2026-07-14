/**
 * Every command, driven as a REAL subprocess.
 *
 * These are the tests that would have caught "the CLI has never been run". Each case spawns
 * the actual built binary with real argv, against a stub paylod API on loopback, and asserts:
 *
 *   • argument parsing — required flags are required, bad values are rejected with exit 2;
 *   • that the command hits the endpoint IT CLAIMS TO, with the right method and body. A
 *     command that quietly calls the wrong path returns a stub 404 and fails here;
 *   • the exit-code contract that scripts branch on (0/2/3/4/5).
 *
 * Nothing here touches production: PAYLOD_API_BASE points at the stub, PAYLOD_CONFIG_DIR at a
 * scratch dir, and the keychain is off. No STK push is ever sent to a real handset.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { stubServer, type RecordedRequest, type StubServer } from "../test/helpers.js";

const run = promisify(execFile);

/** The built CLI entrypoint (build/test/index.js — same code as dist/index.js). */
const BIN = resolve(import.meta.dirname, "../index.js");

let api: StubServer;
let dir: string;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  json: unknown;
}

/** Spawn the CLI exactly as a user would, and never let it reach the real backend. */
async function paylod(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        PAYLOD_CONFIG_DIR: dir,
        PAYLOD_API_BASE: api.url,
        PAYLOD_AS_ISSUER: `${api.url}/oauth`,
        PAYLOD_NO_KEYCHAIN: "1",
        NO_COLOR: "1",
        ...env,
      },
      timeout: 20_000,
    });
    return { code: 0, stdout, stderr, json: safeJson(stdout) };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return {
      code: err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      json: safeJson(err.stdout ?? ""),
    };
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** A logged-in config with a long-lived token, so no command needs to refresh. */
function writeLoggedInConfig(extra: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      apiBase: api.url,
      currentProfile: "default",
      profiles: {
        default: {
          oauth: {
            accessToken: "at_test",
            refreshToken: "rt_test",
            expiresAt: Date.now() + 3_600_000,
            scope: "paylod:team.read paylod:apps.write paylod:keys.mint paylod:payments.collect",
            clientId: "client_test",
          },
          applicationId: "app_1",
          apiKey: "mp_test_abcdefghijklmnop",
          ...extra,
        },
      },
    }),
  );
  // The real CLI writes this 0600. Hand-writing it at the default umask would make
  // `whoami` correctly report an UNPROTECTED credential file — see the dedicated test below.
  chmodSync(join(dir, "config.json"), 0o600);
}

/** Find the request the command under test actually made. */
function called(method: string, path: string): RecordedRequest | undefined {
  return api.requests.find((r) => r.method === method && r.path === path);
}

before(async () => {
  api = await stubServer((req) => {
    const { method, path } = req;

    // ── management plane (OAuth) ──
    if (method === "GET" && path === "/apps") {
      return {
        body: {
          applications: [
            { applicationId: "app_1", name: "Test App", provider: "mpesa", organizationId: "org_1" },
          ],
        },
      };
    }
    if (method === "GET" && path === "/organizations") {
      return { body: { organizations: [{ organizationId: "org_1", name: "Org", role: "owner" }] } };
    }
    if (method === "POST" && path === "/organizations") {
      return { body: { organizationId: "org_2", name: "New Org", role: "owner" } };
    }
    if (method === "PATCH" && path === "/organizations/org_1") {
      return { body: { organizationId: "org_1", name: "Renamed" } };
    }
    if (method === "POST" && path === "/applications") {
      return { body: { applicationId: "app_2", name: "Created" } };
    }
    if (method === "POST" && path === "/provision") {
      return { body: { applicationId: "app_2", name: "Created", organizationId: "org_1" } };
    }
    if (method === "PATCH" && path === "/applications/app_1") {
      return { body: { applicationId: "app_1", name: "Renamed" } };
    }
    if (method === "DELETE" && path === "/applications/app_1") {
      return { body: { deleted: true, applicationId: "app_1" } };
    }
    if (method === "POST" && path === "/mint-key") {
      return { body: { apiKey: "mp_test_MINTED_abcdefgh", id: "key_1", prefix: "mp_test_" } };
    }
    if (method === "GET" && path === "/api-keys") {
      return {
        body: {
          apiKeys: [
            { id: "key_1", prefix: "mp_test_abc", env: "sandbox", createdAt: "2026-01-01T00:00:00Z" },
          ],
        },
      };
    }
    if (method === "POST" && path === "/api-keys/key_1/revoke") {
      return { body: { revoked: true, id: "key_1" } };
    }
    if (method === "POST" && path === "/save-credentials") {
      return { body: { saved: true, applicationId: "app_1" } };
    }
    if (method === "GET" && path === "/webhook-endpoints") {
      return {
        body: { endpoints: [{ id: "we_1", url: "https://x.example/hook", active: true }] },
      };
    }
    if (method === "POST" && path === "/webhook-endpoints") {
      return { body: { webhookEndpointId: "we_2", url: "https://x.example/hook", active: true } };
    }
    if (method === "PATCH" && path === "/webhook-endpoints/we_1") {
      return { body: { webhookEndpointId: "we_1", url: "https://x.example/hook", active: false } };
    }
    if (method === "DELETE" && path === "/webhook-endpoints/we_1") {
      return { body: { deleted: true } };
    }
    if (method === "POST" && path === "/webhook-secret") {
      return { body: { signingSecret: "whsec_from_backend" } };
    }
    if (method === "GET" && path === "/payments") {
      return {
        body: {
          payments: [
            {
              id: "pay_1",
              applicationId: "app_1",
              env: "sandbox",
              status: "success",
              amount: 100,
              phone: "254708374149",
              accountRef: null,
              mpesaReceipt: "ABC123",
              resultCode: 0,
              resultDesc: "ok",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        },
      };
    }
    if (method === "GET" && path === "/payments/pay_1") {
      return {
        body: {
          payment: {
            id: "pay_1",
            applicationId: "app_1",
            env: "sandbox",
            status: "success",
            amount: 100,
            phone: "254708374149",
            accountRef: null,
            mpesaReceipt: "ABC123",
            resultCode: 0,
            resultDesc: "ok",
            createdAt: "2026-01-01T00:00:00Z",
          },
        },
      };
    }
    if (method === "POST" && path === "/simulate/collect") {
      return {
        body: {
          paymentId: "pay_sim_1",
          checkoutRequestId: "ws_CO_sim",
          status: "pending",
          outcomes: [{ id: "approve", label: "Customer approves", status: "success" }],
        },
      };
    }
    if (method === "POST" && path === "/simulate/outcome") {
      return {
        body: {
          paymentId: "pay_sim_1",
          status: "success",
          resultCode: 0,
          resultDesc: "ok",
          mpesaReceipt: "SIM123",
          webhookQueued: true,
        },
      };
    }

    // ── data plane (API key) ──
    if (method === "POST" && path === "/collect") {
      return { body: { paymentId: "pay_1", status: "pending", checkoutRequestId: "ws_CO_1" } };
    }
    if (method === "GET" && path === "/status/pay_1") {
      return {
        body: {
          id: "pay_1",
          status: "success",
          mpesaReceipt: "ABC123",
          resultCode: 0,
          resultDesc: "ok",
        },
      };
    }
    if (method === "GET" && path === "/status/pay_failed") {
      return {
        body: {
          id: "pay_failed",
          status: "failed",
          mpesaReceipt: null,
          resultCode: 1032,
          resultDesc: "Request cancelled by user",
        },
      };
    }
    if (method === "POST" && path === "/oauth/revoke") return { body: {} };

    return undefined; // → 404, so a wrong endpoint fails loudly
  });
});

after(async () => await api.close());

beforeEach(() => {
  api.requests.length = 0;
  rmSync(dir ?? "", { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), "paylod-cli-test-"));
});

/* ────────────────────────────────────────────────────────────────────────────── */

describe("the program itself", () => {
  test("--version prints the version and exits 0", async () => {
    const r = await paylod(["--version"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  test("the reported version matches package.json", async () => {
    // A CLI that lies about its own version makes every bug report useless.
    const pkg = await import("../../package.json", { with: { type: "json" } }).catch(() => null);
    const r = await paylod(["--version"]);
    if (pkg) assert.equal(r.stdout.trim(), (pkg.default as { version: string }).version);
  });

  test("--help lists every command", async () => {
    const r = await paylod(["--help"]);
    assert.equal(r.code, 0);
    for (const cmd of [
      "init", "login", "logout", "whoami", "collect", "status",
      "listen", "simulate", "payments", "orgs", "apps", "creds",
      "keys", "webhooks", "errors",
    ]) {
      assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`), `\`${cmd}\` is missing from --help`);
    }
  });

  test("an unknown command exits 2, not 1", async () => {
    const r = await paylod(["definitely-not-a-command"]);
    assert.equal(r.code, 2, "usage errors must be exit 2 so scripts can branch on them");
  });

  test("an unknown option exits 2", async () => {
    const r = await paylod(["errors", "1032", "--nonsense"]);
    assert.equal(r.code, 2);
  });

  test("every command has its own --help", async () => {
    for (const cmd of [
      ["init"], ["login"], ["logout"], ["whoami"], ["collect"], ["status"],
      ["listen"], ["simulate"], ["payments"], ["orgs"], ["apps"], ["creds"],
      ["keys"], ["webhooks"], ["errors"],
    ]) {
      const r = await paylod([...cmd, "--help"]);
      assert.equal(r.code, 0, `\`paylod ${cmd.join(" ")} --help\` exited ${r.code}`);
      assert.ok(r.stdout.length > 0, `\`paylod ${cmd.join(" ")} --help\` printed nothing`);
    }
  });
});

describe("errors — offline, no auth, no network", () => {
  test("decodes 4999 as pending and NOT retryable", async () => {
    const r = await paylod(["errors", "4999", "--json"]);
    assert.equal(r.code, 0);
    const d = r.json as { category: string; retryable: boolean };
    assert.equal(d.category, "pending");
    assert.equal(d.retryable, false, "retrying 4999 fires a second STK prompt — double charge");
  });

  test("decodes 1037 as an unanswered prompt, not a signal problem", async () => {
    const r = await paylod(["errors", "1037", "--json"]);
    const d = r.json as { category: string; title: string };
    assert.equal(d.category, "customer");
    assert.doesNotMatch(d.title, /could not be reached/i);
  });

  test("makes NO network call at all — it must work before you have an account", async () => {
    await paylod(["errors", "1032", "--json"], { PAYLOD_API_BASE: "http://127.0.0.1:1" });
    assert.equal(api.requests.length, 0, "`errors` must be fully offline");
  });

  test("works with an empty config dir and no credentials", async () => {
    const r = await paylod(["errors", "1032", "--json"]);
    assert.equal(r.code, 0);
  });

  test("--list prints the whole catalog", async () => {
    const r = await paylod(["errors", "--list", "--json"]);
    assert.equal(r.code, 0);
    const out = r.json as { count: number };
    assert.ok(out.count > 10, `expected a real catalog, got ${out.count} codes`);
  });

  test("no code and no --list is a usage error (exit 2)", async () => {
    const r = await paylod(["errors"]);
    assert.equal(r.code, 2);
  });

  test("an unknown code decodes to the non-retryable fallback rather than erroring", async () => {
    const r = await paylod(["errors", "31337", "--json"]);
    assert.equal(r.code, 0);
    assert.equal((r.json as { retryable: boolean }).retryable, false);
    assert.equal((r.json as { known: boolean }).known, false);
  });
});

describe("commands require auth and say so with exit 4", () => {
  // Exit 4 = "not authenticated" is a contract. Scripts and CI branch on it.
  for (const args of [
    ["whoami"],
    ["apps", "list"],
    ["orgs", "list"],
    ["keys", "list"],
    ["payments", "list"],
    ["webhooks", "list"],
    ["simulate", "--outcome", "approve"],
  ]) {
    test(`paylod ${args.join(" ")} with no login → exit 4`, async () => {
      const r = await paylod([...args, "--json"]);
      assert.equal(r.code, 4, `expected exit 4, got ${r.code}: ${r.stderr || r.stdout}`);
    });
  }

  test("collect with no API key and no login → exit 4", async () => {
    const r = await paylod(["collect", "-p", "254708374149", "-a", "1", "--json"]);
    assert.equal(r.code, 4);
  });
});

describe("apps", () => {
  beforeEach(() => writeLoggedInConfig());

  test("apps list → GET /apps", async () => {
    const r = await paylod(["apps", "list", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(called("GET", "/apps"), "apps list must call GET /apps");
  });

  test("apps create --name → POST (provisions an application)", async () => {
    const r = await paylod(["apps", "create", "--name", "My App", "--org", "org_1", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const req = called("POST", "/applications") ?? called("POST", "/provision");
    assert.ok(req, "apps create must POST to /applications or /provision");
    assert.match(JSON.stringify(req!.json), /My App/, "the name must be in the body");
  });

  test("apps create WITHOUT --name is a usage error (exit 2)", async () => {
    const r = await paylod(["apps", "create", "--json"]);
    assert.equal(r.code, 2);
    assert.equal(api.requests.length, 0, "a usage error must not hit the network");
  });

  test("apps rename → PATCH /applications/:id", async () => {
    const r = await paylod(["apps", "rename", "app_1", "--name", "Renamed", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const req = called("PATCH", "/applications/app_1");
    assert.ok(req, "apps rename must PATCH /applications/:id");
    assert.deepEqual(req!.json, { name: "Renamed" });
  });

  test("apps rename without --name is a usage error", async () => {
    assert.equal((await paylod(["apps", "rename", "app_1", "--json"])).code, 2);
  });

  test("apps delete --yes → DELETE /applications/:id", async () => {
    const r = await paylod(["apps", "delete", "app_1", "--yes", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(called("DELETE", "/applications/app_1"));
  });

  test("apps delete WITHOUT --yes refuses in a non-interactive shell — no accidental deletes", async () => {
    const r = await paylod(["apps", "delete", "app_1", "--json"]);
    assert.notEqual(r.code, 0, "a destructive command must not succeed unconfirmed");
    assert.ok(!called("DELETE", "/applications/app_1"), "nothing may be deleted without consent");
  });

  test("apps use writes the default app locally and calls nothing", async () => {
    const r = await paylod(["apps", "use", "app_9", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(api.requests.length, 0, "`apps use` is a local operation");
  });
});

describe("orgs", () => {
  beforeEach(() => writeLoggedInConfig());

  test("orgs list → GET /organizations", async () => {
    const r = await paylod(["orgs", "list", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(called("GET", "/organizations"));
  });

  test("orgs create --name → POST /organizations", async () => {
    const r = await paylod(["orgs", "create", "--name", "New Org", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const req = called("POST", "/organizations");
    assert.ok(req);
    assert.match(JSON.stringify(req!.json), /New Org/);
  });

  test("orgs create without --name is a usage error", async () => {
    assert.equal((await paylod(["orgs", "create", "--json"])).code, 2);
  });

  test("orgs rename → PATCH /organizations/:id", async () => {
    const r = await paylod(["orgs", "rename", "org_1", "--name", "Renamed", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(called("PATCH", "/organizations/org_1")!.json, { name: "Renamed" });
  });
});

describe("keys", () => {
  beforeEach(() => writeLoggedInConfig());

  test("keys mint → POST /mint-key", async () => {
    const r = await paylod(["keys", "mint", "--app", "app_1", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(called("POST", "/mint-key"), "keys mint must POST /mint-key");
  });

  test("keys list → GET /api-keys", async () => {
    const r = await paylod(["keys", "list", "--app", "app_1", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(called("GET", "/api-keys"));
  });

  test("keys revoke → POST /api-keys/:id/revoke", async () => {
    const r = await paylod(["keys", "revoke", "key_1", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(called("POST", "/api-keys/key_1/revoke"), "revoke must hit the revoke endpoint");
  });

  test("keys revoke without an id is a usage error", async () => {
    assert.equal((await paylod(["keys", "revoke", "--json"])).code, 2);
  });

  test("keys use saves the key locally and calls nothing", async () => {
    const r = await paylod(["keys", "use", "mp_test_zzz", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(api.requests.length, 0);
  });
});

describe("creds", () => {
  beforeEach(() => writeLoggedInConfig());

  test("creds set → POST /save-credentials", async () => {
    const r = await paylod([
      "creds", "set",
      "--app", "app_1",
      "--consumer-key", "ck_x",
      "--consumer-secret", "cs_x",
      "--passkey", "pk_x",
      "--shortcode", "174379",
      "--json",
    ]);
    assert.equal(r.code, 0, r.stderr || r.stdout);
    const req = called("POST", "/save-credentials");
    assert.ok(req, "creds set must POST /save-credentials");
    assert.match(JSON.stringify(req!.json), /174379/);
  });

  test("the Daraja secrets are NOT echoed back to the terminal", async () => {
    const r = await paylod([
      "creds", "set", "--app", "app_1",
      "--consumer-key", "SUPERSECRETKEY",
      "--consumer-secret", "SUPERSECRETSECRET",
      "--passkey", "SUPERSECRETPASSKEY",
      "--shortcode", "174379",
    ]);
    const out = r.stdout + r.stderr;
    assert.doesNotMatch(out, /SUPERSECRETSECRET/, "the consumer secret must never be printed");
    assert.doesNotMatch(out, /SUPERSECRETPASSKEY/, "the passkey must never be printed");
  });
});

describe("webhooks", () => {
  beforeEach(() => writeLoggedInConfig());

  test("webhooks list → GET /webhook-endpoints", async () => {
    const r = await paylod(["webhooks", "list", "--app", "app_1", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(called("GET", "/webhook-endpoints"));
  });

  test("webhooks add <url> → POST /webhook-endpoints", async () => {
    const r = await paylod(["webhooks", "add", "https://x.example/hook", "--app", "app_1", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const req = called("POST", "/webhook-endpoints");
    assert.ok(req);
    assert.match(JSON.stringify(req!.json), /x\.example/);
  });

  test("webhooks add without a url is a usage error", async () => {
    assert.equal((await paylod(["webhooks", "add", "--json"])).code, 2);
  });

  test("webhooks toggle --off → PATCH /webhook-endpoints/:id with active:false", async () => {
    const r = await paylod(["webhooks", "toggle", "we_1", "--off", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(called("PATCH", "/webhook-endpoints/we_1")!.json, { active: false });
  });

  test("webhooks delete --yes → DELETE /webhook-endpoints/:id", async () => {
    const r = await paylod(["webhooks", "delete", "we_1", "--yes", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(called("DELETE", "/webhook-endpoints/we_1"));
  });

  test("webhooks secret → POST /webhook-secret", async () => {
    const r = await paylod(["webhooks", "secret", "--app", "app_1", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(called("POST", "/webhook-secret"));
  });

  test("`webhooks secret` shows the secret ONCE — it is the point of the command", async () => {
    // Deliberate, and the same thing `stripe listen` does: you asked for the secret, you get
    // the secret, with a "shown once" warning. What must NOT happen is another command
    // leaking it — see the next test.
    const r = await paylod(["webhooks", "secret", "--app", "app_1"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /whsec_from_backend/);
    assert.match(r.stdout, /ONCE/i, "the user must be told the secret is shown only once");
  });

  test("no OTHER command leaks the cached signing secret to the terminal", async () => {
    // `webhooks secret` caches it in the profile. From then on it is a stored credential, and
    // a stored credential must not turn up in unrelated output (scrollback, screen shares, CI
    // logs). whoami is the obvious risk: it prints "everything about your session".
    await paylod(["webhooks", "secret", "--app", "app_1"]);
    const who = await paylod(["whoami"]);
    assert.doesNotMatch(who.stdout, /whsec_from_backend/, "whoami leaked the webhook secret");

    const list = await paylod(["webhooks", "list", "--app", "app_1"]);
    assert.doesNotMatch(list.stdout, /whsec_from_backend/, "webhooks list leaked the secret");
  });
});

describe("payments", () => {
  beforeEach(() => writeLoggedInConfig());

  test("payments list → GET /payments", async () => {
    const r = await paylod(["payments", "list", "--app", "app_1", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(called("GET", "/payments"));
  });

  test("payments list passes --limit through as a query param", async () => {
    await paylod(["payments", "list", "--app", "app_1", "-n", "5", "--json"]);
    assert.equal(called("GET", "/payments")!.query.limit, "5");
  });

  test("payments get <id> → GET /payments/:id", async () => {
    const r = await paylod(["payments", "get", "pay_1", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(called("GET", "/payments/pay_1"));
  });

  test("payments get without an id is a usage error", async () => {
    assert.equal((await paylod(["payments", "get", "--json"])).code, 2);
  });
});

describe("collect — argument validation happens BEFORE any money moves", () => {
  beforeEach(() => writeLoggedInConfig());

  // Every one of these must be rejected locally. A bad amount or a mistyped number that
  // reaches Daraja is, at best, a failed charge to a stranger.
  const BAD_PHONES = ["123", "07123", "+1555123456", "abcdefghij", "254812345678"];
  for (const phone of BAD_PHONES) {
    test(`rejects the phone number "${phone}" with exit 2, without calling the API`, async () => {
      const r = await paylod(["collect", "-p", phone, "-a", "10", "--json"]);
      assert.equal(r.code, 2, `"${phone}" should be rejected as a bad number`);
      assert.ok(!called("POST", "/collect"), "a bad number must never reach the API");
    });
  }

  const GOOD_PHONES = ["254708374149", "0712345678", "+254712345678", "0112345678"];
  for (const phone of GOOD_PHONES) {
    test(`accepts the phone number "${phone}"`, async () => {
      const r = await paylod(["collect", "-p", phone, "-a", "1", "--no-wait", "--json"]);
      assert.equal(r.code, 0, `"${phone}" should be accepted: ${r.stderr}`);
    });
  }

  const BAD_AMOUNTS = ["0", "-5", "abc", "1.5", "150001", ""];
  for (const amount of BAD_AMOUNTS) {
    test(`rejects the amount "${amount}" with exit 2, without calling the API`, async () => {
      const r = await paylod(["collect", "-p", "254708374149", "-a", amount, "--json"]);
      assert.equal(r.code, 2, `"${amount}" should be rejected`);
      assert.ok(!called("POST", "/collect"), "a bad amount must never reach the API");
    });
  }

  test("--phone is required", async () => {
    assert.equal((await paylod(["collect", "-a", "10", "--json"])).code, 2);
  });

  test("--amount is required", async () => {
    assert.equal((await paylod(["collect", "-p", "254708374149", "--json"])).code, 2);
  });
});

describe("collect — the endpoint and the exit-code contract", () => {
  beforeEach(() => writeLoggedInConfig());

  test("with an mp_test_ key → POST /collect on the DATA plane, with the API key as bearer", async () => {
    const r = await paylod([
      "collect", "-p", "254708374149", "-a", "100", "-r", "ORDER-1", "--no-wait", "--json",
    ]);
    assert.equal(r.code, 0, r.stderr);

    const req = called("POST", "/collect");
    assert.ok(req, "collect must POST /collect");
    assert.equal(req!.headers.authorization, "Bearer mp_test_abcdefghijklmnop");
    const body = req!.json as Record<string, unknown>;
    assert.equal(body.amount, 100);
    assert.equal(body.phone, "254708374149");
    assert.ok(req!.headers["idempotency-key"], "collect must send an Idempotency-Key by default");
  });

  test("--idempotency-key is passed through verbatim, so a retry cannot double-charge", async () => {
    await paylod([
      "collect", "-p", "254708374149", "-a", "10",
      "--idempotency-key", "my-order-42", "--no-wait", "--json",
    ]);
    assert.equal(called("POST", "/collect")!.headers["idempotency-key"], "my-order-42");
  });

  test("--no-wait returns immediately with the pending payment and exit 0", async () => {
    const r = await paylod(["collect", "-p", "254708374149", "-a", "10", "--no-wait", "--json"]);
    assert.equal(r.code, 0);
    assert.equal((r.json as { paymentId: string }).paymentId, "pay_1");
    assert.ok(!called("GET", "/status/pay_1"), "--no-wait must not poll");
  });

  test("waiting for a SUCCESSFUL payment polls /status and exits 0", async () => {
    const r = await paylod(["collect", "-p", "254708374149", "-a", "10", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(called("GET", "/status/pay_1"), "collect must poll GET /status/:id");
    assert.equal((r.json as { status: string }).status, "success");
  });
});

describe("status", () => {
  beforeEach(() => writeLoggedInConfig());

  test("status <id> → GET /status/:id", async () => {
    const r = await paylod(["status", "pay_1", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(called("GET", "/status/pay_1"));
  });

  test("a FAILED payment exits 3 — a valid answer, not an error", async () => {
    // Scripts branch on this: `paylod collect … && ship-the-order`.
    const r = await paylod(["status", "pay_failed", "--json"]);
    assert.equal(r.code, 3, "a failed payment must exit 3");
    assert.equal((r.json as { status: string }).status, "failed");
  });

  test("status without an id is a usage error", async () => {
    assert.equal((await paylod(["status", "--json"])).code, 2);
  });

  test("the payment id is URL-encoded, not concatenated raw", async () => {
    await paylod(["status", "pay/../../etc/passwd", "--json"]);
    const paths = api.requests.map((r) => r.path);
    assert.ok(
      !paths.some((p) => p.includes("etc/passwd") && !p.includes("%")),
      `a path-traversing id must be encoded, saw: ${paths.join(", ")}`,
    );
  });
});

describe("simulate — the safe way to exercise a payment", () => {
  beforeEach(() => writeLoggedInConfig());

  test("simulate --outcome approve → POST /simulate/collect then POST /simulate/outcome", async () => {
    const r = await paylod(["simulate", "--outcome", "approve", "--app", "app_1", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(called("POST", "/simulate/collect"), "simulate must create a simulated payment");
    assert.ok(called("POST", "/simulate/outcome"), "simulate must drive the outcome");
  });

  test("simulate defaults to Safaricom's sandbox test number, never a real one", async () => {
    await paylod(["simulate", "--outcome", "approve", "--app", "app_1", "--json"]);
    const body = called("POST", "/simulate/collect")!.json as { phone?: string };
    assert.equal(body.phone, "254708374149", "the default must be the Daraja sandbox test MSISDN");
  });

  test("simulate NEVER touches the real /collect endpoint", async () => {
    await paylod(["simulate", "--outcome", "approve", "--app", "app_1", "--json"]);
    assert.ok(!called("POST", "/collect"), "simulate must not fire a real STK push");
  });
});

describe("whoami / logout", () => {
  test("whoami → GET /apps and reports where the token lives", async () => {
    writeLoggedInConfig();
    const r = await paylod(["whoami", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(called("GET", "/apps"));

    const out = r.json as Record<string, unknown>;
    assert.equal(out.storage, "file", "with the keychain off, the token is in a file");
    assert.ok(out.storageFallbackReason, "whoami must say WHY the keychain is not in use");
    assert.equal(out.credentialFileProtected, true, "on Linux the 0600 file is protected");
  });

  test("whoami REPORTS an unprotected credential file rather than glossing over it", async () => {
    writeLoggedInConfig();
    chmodSync(join(dir, "config.json"), 0o644); // world-readable, as a Windows file effectively is

    const r = await paylod(["whoami", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      (r.json as { credentialFileProtected: boolean }).credentialFileProtected,
      false,
      "whoami must not claim a world-readable credential file is protected",
    );
  });

  test("whoami masks the API key — never prints it in full", async () => {
    writeLoggedInConfig();
    const r = await paylod(["whoami"]);
    assert.doesNotMatch(r.stdout, /mp_test_abcdefghijklmnop/, "whoami must not print the whole key");
  });

  test("logout clears the local oauth block", async () => {
    writeLoggedInConfig();
    const r = await paylod(["logout", "--json"]);
    assert.equal(r.code, 0, r.stderr);

    // …and a subsequent authed command must now fail with exit 4.
    assert.equal((await paylod(["apps", "list", "--json"])).code, 4);
  });

  test("logout --all also clears the API key", async () => {
    writeLoggedInConfig();
    await paylod(["logout", "--all", "--json"]);
    const r = await paylod(["collect", "-p", "254708374149", "-a", "1", "--json"]);
    assert.equal(r.code, 4, "after `logout --all` there should be no API key left");
  });

  test("logout works offline — it must never leave credentials behind", async () => {
    writeLoggedInConfig();
    const r = await paylod(["logout", "--json"], { PAYLOD_AS_ISSUER: "http://127.0.0.1:1/oauth" });
    assert.equal(r.code, 0, "a failed server-side revoke must not block local cleanup");
    assert.equal((await paylod(["apps", "list", "--json"])).code, 4);
  });
});

describe("--json is machine-readable on the failure path too", () => {
  test("an auth failure emits parseable JSON on stdout", async () => {
    const r = await paylod(["apps", "list", "--json"]);
    assert.equal(r.code, 4);
    const out = r.json as { ok: boolean; error: string };
    assert.equal(out.ok, false, "--json errors must carry ok:false");
    assert.ok(typeof out.error === "string" && out.error.length > 0);
  });

  test("an API failure emits parseable JSON with the status", async () => {
    writeLoggedInConfig();
    // /api-keys/nope/revoke is not routed by the stub → 404.
    const r = await paylod(["keys", "revoke", "nope", "--json"]);
    assert.notEqual(r.code, 0);
    const out = r.json as { ok: boolean; status?: number };
    assert.equal(out.ok, false);
    assert.equal(out.status, 404);
  });
});
