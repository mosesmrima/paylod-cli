/**
 * The HTTP client: auth planes, error mapping, and the hints that make errors actionable.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { apiKeyRequest, oauthRequest, endpointId } from "./client.js";
import { PaylodError } from "./errors.js";
import { stubServer, type StubServer } from "../test/helpers.js";

let api: StubServer;

beforeEach(async () => {
  api = await stubServer((req) => {
    if (req.path === "/slow") return undefined; // never routed; see the timeout test
    if (req.path === "/boom") return { status: 500, body: { error: "kaboom" } };
    if (req.path === "/scope") {
      return { status: 403, body: { error: "insufficient scope: paylod:keys.mint" } };
    }
    if (req.path === "/plain-403") return { status: 403, body: { error: "forbidden" } };
    if (req.path === "/409") return { status: 409, body: { error: "idempotency conflict" } };
    if (req.path === "/nonjson") return { status: 500, raw: "<html>gateway error</html>" };
    if (req.path === "/empty") return { status: 200, raw: "" };
    return { status: 200, body: { ok: true, saw: req.method } };
  });
});
afterEach(async () => await api.close());

describe("the two auth planes", () => {
  test("apiKeyRequest sends the merchant key as a bearer", async () => {
    await apiKeyRequest(api.url, "mp_test_abc", "POST", "/collect", { body: { amount: 1 } });
    const r = api.last()!;
    assert.equal(r.headers.authorization, "Bearer mp_test_abc");
    assert.equal(r.headers["content-type"], "application/json");
    assert.equal(r.headers["user-agent"], "paylod-cli");
    assert.deepEqual(r.json, { amount: 1 });
  });

  test("oauthRequest sends the access token as a bearer", async () => {
    await oauthRequest(api.url, "at_xyz", "GET", "/apps");
    assert.equal(api.last()!.headers.authorization, "Bearer at_xyz");
  });

  test("a GET sends no Content-Type and no body", async () => {
    await oauthRequest(api.url, "at", "GET", "/apps");
    const r = api.last()!;
    assert.equal(r.headers["content-type"], undefined);
    assert.equal(r.body, "");
  });
});

describe("URL and header construction", () => {
  test("query params are appended, and undefined ones are dropped", async () => {
    await oauthRequest(api.url, "at", "GET", "/payments", {
      query: { applicationId: "app_1", limit: 20, status: undefined },
    });
    const r = api.last()!;
    assert.deepEqual(r.query, { applicationId: "app_1", limit: "20" });
    assert.ok(!("status" in r.query), "an undefined query param must not be sent as 'undefined'");
  });

  test("a base with a trailing slash does not produce a double slash", async () => {
    await oauthRequest(`${api.url}/`, "at", "GET", "/apps");
    assert.equal(api.last()!.path, "/apps");
  });

  test("a path without a leading slash still works", async () => {
    await oauthRequest(api.url, "at", "GET", "apps");
    assert.equal(api.last()!.path, "/apps");
  });

  test("the Idempotency-Key header is sent when asked for", async () => {
    // This is what stops a retried `collect` from double-charging.
    await apiKeyRequest(api.url, "mp_test_x", "POST", "/collect", {
      body: {},
      idempotencyKey: "idem-123",
    });
    assert.equal(api.last()!.headers["idempotency-key"], "idem-123");
  });
});

describe("errors become actionable PaylodErrors", () => {
  test("a non-2xx becomes a PaylodError carrying the status and body", async () => {
    await assert.rejects(
      () => oauthRequest(api.url, "at", "GET", "/boom"),
      (e: unknown) => {
        assert.ok(e instanceof PaylodError);
        assert.equal((e as PaylodError).status, 500);
        assert.equal((e as Error).message, "kaboom");
        return true;
      },
    );
  });

  test("a 403 for a missing scope NAMES the scope and the fix", async () => {
    // The single most likely failure for a new user: the consent screen defaults the
    // high-risk scopes to OFF. A bare "forbidden" would send them hunting for hours.
    await assert.rejects(
      () => oauthRequest(api.url, "at", "POST", "/scope"),
      (e: unknown) => {
        const hint = (e as PaylodError).hint ?? "";
        assert.match(hint, /paylod:keys\.mint/, "the hint must name the missing scope");
        assert.match(hint, /paylod login/, "the hint must give the command that fixes it");
        assert.match(hint, /TICK|tick/, "the hint must say to tick the box on the consent screen");
        return true;
      },
    );
  });

  test("a 403 with no scope in the message still gets a useful hint", async () => {
    await assert.rejects(
      () => oauthRequest(api.url, "at", "POST", "/plain-403"),
      (e: unknown) => {
        assert.match((e as PaylodError).hint ?? "", /scope|role/i);
        return true;
      },
    );
  });

  test("a 409 explains the idempotency-key conflict", async () => {
    await assert.rejects(
      () => apiKeyRequest(api.url, "k", "POST", "/409", { body: {} }),
      (e: unknown) => {
        assert.match((e as PaylodError).hint ?? "", /Idempotency-Key/i);
        return true;
      },
    );
  });

  test("a non-JSON error body does not crash the parser", async () => {
    await assert.rejects(
      () => oauthRequest(api.url, "at", "GET", "/nonjson"),
      (e: unknown) => {
        assert.ok(e instanceof PaylodError);
        assert.match((e as Error).message, /HTTP 500/);
        return true;
      },
    );
  });

  test("an unreachable host becomes a friendly error, not ECONNREFUSED", async () => {
    await assert.rejects(
      () => oauthRequest("http://127.0.0.1:1", "at", "GET", "/apps"),
      (e: unknown) => {
        assert.ok(e instanceof PaylodError);
        assert.match((e as Error).message, /Could not reach paylod/i);
        assert.match((e as PaylodError).hint ?? "", /online|PAYLOD_API_BASE/i);
        return true;
      },
    );
  });

  test("a timeout is reported as a timeout", async () => {
    const slow = await stubServer(() => undefined);
    try {
      // Point at a black hole: 10.255.255.1 is non-routable, so the connect hangs.
      await assert.rejects(
        () => oauthRequest("http://10.255.255.1", "at", "GET", "/apps", { timeoutMs: 150 }),
        (e: unknown) => {
          assert.ok(e instanceof PaylodError);
          assert.match((e as Error).message, /timed out|Could not reach/i);
          return true;
        },
      );
    } finally {
      await slow.close();
    }
  });

  test("a 200 with an empty body does not throw", async () => {
    const r = await oauthRequest(api.url, "at", "DELETE", "/empty");
    assert.equal(r, undefined);
  });
});

describe("endpointId absorbs the backend's inconsistent shapes", () => {
  // POST /webhook-endpoints returns { webhookEndpointId }, GET returns { id }. Picking one
  // and being silently wrong on the other is exactly the kind of bug that only shows up in
  // the second command a user runs.
  test("reads the POST shape", () => {
    assert.equal(endpointId({ webhookEndpointId: "we_1", url: "https://x", active: true }), "we_1");
  });

  test("reads the GET shape", () => {
    assert.equal(endpointId({ id: "we_2", url: "https://x", active: true }), "we_2");
  });

  test("prefers webhookEndpointId when both are present", () => {
    assert.equal(
      endpointId({ webhookEndpointId: "we_1", id: "we_2", url: "https://x", active: true }),
      "we_1",
    );
  });

  test("throws a clear PaylodError when neither is present", () => {
    assert.throws(
      () => endpointId({ url: "https://x", active: true }),
      (e: unknown) => {
        assert.ok(e instanceof PaylodError);
        assert.match((e as Error).message, /no id/i);
        return true;
      },
    );
  });
});
