/**
 * `paylod listen` — the forwarding security property.
 *
 * THE invariant under test: an event whose HMAC does not verify is NEVER forwarded to the
 * developer's server. `listen` binds an open port on 127.0.0.1, so any process on the machine
 * can POST to it. If it forwarded whatever arrived, it would be a confused deputy: it would
 * launder spoofed `payment.success` events into an application whose author reasonably assumes
 * the CLI checked them. "Order paid, ship the goods" is a decision people make on these events.
 *
 * So we assert the NEGATIVE — that the downstream server received nothing at all — rather than
 * merely that a warning was printed. A test that only checks the log would still pass if the
 * forward happened.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { handleEvent, type Ctx } from "./listen.js";
import { setJsonMode } from "../lib/ui.js";
import { stubServer, signWebhook, webhookBody, type StubServer } from "../test/helpers.js";

const SECRET = "whsec_test_0123456789abcdef";

/** A downstream "developer's server" — the thing that must not be fed forged events. */
let downstream: StubServer;

function ctx(over: Partial<Ctx> = {}): Ctx {
  return {
    forward: downstream.url + "/webhook",
    secret: SECRET,
    skipVerify: false,
    tolerance: 300,
    printJson: false,
    seen: 0,
    queue: Promise.resolve(),
    ...over,
  };
}

before(async () => {
  // Silence the pretty printer; we assert on the network, not on stdout.
  setJsonMode(true);
  downstream = await stubServer(() => ({ status: 200, body: { received: true } }));
});

after(async () => {
  await downstream.close();
  setJsonMode(false);
});

beforeEach(() => {
  downstream.requests.length = 0;
});

describe("listen: signature verification gates forwarding", () => {
  test("a correctly signed event IS forwarded, byte-for-byte", async () => {
    const raw = webhookBody();
    const sig = signWebhook(SECRET, raw);

    await handleEvent(ctx(), raw, { "x-webhook-signature": sig });

    assert.equal(downstream.requests.length, 1, "the signed event should have been forwarded");
    const got = downstream.requests[0]!;
    assert.equal(got.method, "POST");
    assert.equal(got.path, "/webhook");
    // The raw bytes must survive untouched — re-serializing would break the developer's own
    // HMAC check, which is the whole point of forwarding the signature through.
    assert.equal(got.body, raw);
    assert.equal(got.headers["x-webhook-signature"], sig);
  });

  test("a FORGED signature is never forwarded", async () => {
    const raw = webhookBody();
    // Attacker signs with a secret they guessed. Same shape, valid timestamp, wrong key.
    const forged = signWebhook("whsec_attacker_guess", raw);

    await handleEvent(ctx(), raw, { "x-webhook-signature": forged });

    assert.equal(
      downstream.requests.length,
      0,
      "SECURITY: an event with a forged HMAC was forwarded to the developer's server",
    );
  });

  test("a TAMPERED body is never forwarded, even with an otherwise-valid signature", async () => {
    // Sign the real body, then swap the amount. This is the attack that matters: the signature
    // is genuine, but it is not a signature over THESE bytes.
    const original = webhookBody({ amount: 1 });
    const sig = signWebhook(SECRET, original);
    const tampered = original.replace('"amount":1', '"amount":100000');
    assert.notEqual(tampered, original, "test setup: the body must actually differ");

    await handleEvent(ctx(), tampered, { "x-webhook-signature": sig });

    assert.equal(downstream.requests.length, 0, "SECURITY: a tampered body was forwarded");
  });

  test("a MISSING signature header is never forwarded", async () => {
    await handleEvent(ctx(), webhookBody(), {});
    assert.equal(downstream.requests.length, 0, "SECURITY: an unsigned event was forwarded");
  });

  test("a STALE signature (replay) is never forwarded", async () => {
    const raw = webhookBody();
    // Genuinely signed by paylod — an hour ago. Replayed now.
    const old = Math.floor(Date.now() / 1000) - 3600;
    const sig = signWebhook(SECRET, raw, old);

    await handleEvent(ctx({ tolerance: 300 }), raw, { "x-webhook-signature": sig });

    assert.equal(downstream.requests.length, 0, "SECURITY: a replayed event was forwarded");
  });

  test("with NO secret available, nothing is forwarded — we fail closed", async () => {
    const raw = webhookBody();
    const sig = signWebhook(SECRET, raw);

    // The dangerous failure mode: no secret configured, so we cannot check anything. The CLI
    // must NOT decide that "cannot verify" means "verified".
    await handleEvent(ctx({ secret: undefined }), raw, { "x-webhook-signature": sig });

    assert.equal(
      downstream.requests.length,
      0,
      "SECURITY: with no signing secret, listen forwarded an unverifiable event",
    );
  });

  test("--skip-verify is the ONLY way an unverified event reaches the developer", async () => {
    const raw = webhookBody();
    const forged = signWebhook("whsec_attacker_guess", raw);

    await handleEvent(ctx({ skipVerify: true }), raw, { "x-webhook-signature": forged });

    // This is opt-in, explicit, and printed in the banner. It is a choice, not a default.
    assert.equal(downstream.requests.length, 1, "--skip-verify should forward regardless");
  });

  test("tolerance=0 disables the freshness check but NOT the HMAC check", async () => {
    const raw = webhookBody();
    const ancient = Math.floor(Date.now() / 1000) - 86_400;

    // Correctly signed, very old, tolerance disabled → forwarded.
    await handleEvent(ctx({ tolerance: 0 }), raw, {
      "x-webhook-signature": signWebhook(SECRET, raw, ancient),
    });
    assert.equal(downstream.requests.length, 1, "tolerance=0 should accept an old but valid sig");

    downstream.requests.length = 0;

    // Forged, very old, tolerance disabled → still rejected. Turning off replay protection
    // must not turn off authentication.
    await handleEvent(ctx({ tolerance: 0 }), raw, {
      "x-webhook-signature": signWebhook("whsec_wrong", raw, ancient),
    });
    assert.equal(
      downstream.requests.length,
      0,
      "SECURITY: tolerance=0 must not disable HMAC verification",
    );
  });

  test("an event filtered out by --events is not forwarded", async () => {
    const raw = webhookBody({ status: "success" });
    const sig = signWebhook(SECRET, raw);

    await handleEvent(ctx({ events: ["payment.failed"] }), raw, { "x-webhook-signature": sig });

    assert.equal(downstream.requests.length, 0, "a filtered event should not be forwarded");
  });

  test("an unparseable body with a valid signature is still forwarded verbatim", async () => {
    // Signature is over bytes, not over JSON. If paylod signed it, we replay it — the
    // developer's server is entitled to see exactly what paylod sent, even if we cannot
    // parse it. (We must not "helpfully" drop it: that would hide a real delivery.)
    const raw = "not json at all";
    const sig = signWebhook(SECRET, raw);

    await handleEvent(ctx(), raw, { "x-webhook-signature": sig });

    assert.equal(downstream.requests.length, 1);
    assert.equal(downstream.requests[0]!.body, raw);
  });
});

describe("listen: forwarding is resilient", () => {
  test("a downstream 500 does not throw — the stream must survive a broken handler", async () => {
    const failing = await stubServer(() => ({ status: 500, body: { error: "boom" } }));
    try {
      const raw = webhookBody();
      await handleEvent(
        ctx({ forward: failing.url + "/webhook" }),
        raw,
        { "x-webhook-signature": signWebhook(SECRET, raw) },
      );
      assert.equal(failing.requests.length, 1);
    } finally {
      await failing.close();
    }
  });

  test("an unreachable downstream does not throw", async () => {
    const raw = webhookBody();
    // Port 1 on loopback: nothing is listening.
    await handleEvent(
      ctx({ forward: "http://127.0.0.1:1/webhook" }),
      raw,
      { "x-webhook-signature": signWebhook(SECRET, raw) },
    );
    // Reaching here without an exception IS the assertion.
    assert.ok(true);
  });
});
