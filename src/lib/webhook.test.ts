/**
 * Webhook signature verification — the inverse of the backend's signer.
 *
 * If this is wrong in the permissive direction, `paylod listen` forwards forged events. If it
 * is wrong in the strict direction, real events are silently dropped. Both are bad; the first
 * is a security bug. These tests pin both edges.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  DEFAULT_TOLERANCE_SECS,
  parseSignatureHeader,
  SIGNATURE_HEADER,
  verifySignature,
  asWebhookEvent,
} from "./webhook.js";
import { signWebhook, webhookBody } from "../test/helpers.js";

const SECRET = "whsec_abc";
const BODY = '{"type":"payment.success","data":{"amount":100}}';

describe("parseSignatureHeader", () => {
  test("parses t and v1", () => {
    assert.deepEqual(parseSignatureHeader("t=1700000000,v1=deadbeef"), {
      t: 1_700_000_000,
      v1: "deadbeef",
    });
  });

  test("tolerates whitespace and unknown segments", () => {
    // Forward-compatibility: a future v2= must not break v1 verification.
    assert.deepEqual(parseSignatureHeader(" t=123 , v1=abc , v2=xyz "), { t: 123, v1: "abc" });
  });

  test("a garbage header yields nothing rather than throwing", () => {
    assert.deepEqual(parseSignatureHeader("garbage"), {});
    assert.deepEqual(parseSignatureHeader(""), {});
    assert.deepEqual(parseSignatureHeader("t=notanumber,v1=abc"), { v1: "abc" });
  });
});

describe("verifySignature: accepts what paylod actually sends", () => {
  test("a correctly signed body verifies", () => {
    const t = Math.floor(Date.now() / 1000);
    const r = verifySignature(BODY, signWebhook(SECRET, BODY, t), SECRET);
    assert.equal(r.valid, true);
    assert.equal(r.valid && r.timestamp, t);
  });

  test("the HMAC is over `${t}.${rawBody}` — the backend's exact construction", () => {
    // Pinning the construction, not just "our signer agrees with our verifier". If both sides
    // were wrong in the same way, a round-trip test would pass and production would fail.
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", SECRET).update(`${t}.${BODY}`, "utf8").digest("hex");
    const r = verifySignature(BODY, `t=${t},v1=${v1}`, SECRET);
    assert.equal(r.valid, true);
  });

  test("the header name is the one the worker sends", () => {
    assert.equal(SIGNATURE_HEADER, "x-webhook-signature");
  });
});

describe("verifySignature: rejects everything else", () => {
  test("a wrong secret fails, and says so", () => {
    const r = verifySignature(BODY, signWebhook(SECRET, BODY), "whsec_wrong");
    assert.equal(r.valid, false);
    assert.match(r.valid === false ? r.reason : "", /HMAC mismatch/i);
  });

  test("a tampered body fails even with a genuine signature", () => {
    const sig = signWebhook(SECRET, BODY);
    const tampered = BODY.replace("100", "100000");
    const r = verifySignature(tampered, sig, SECRET);
    assert.equal(r.valid, false);
  });

  test("RE-SERIALIZED json fails — proving we verify raw bytes, not a parsed object", () => {
    // This is the classic webhook-verification bug: parse, re-stringify, then HMAC. Key order
    // and whitespace change and every signature breaks. The CLI must be immune, and the only
    // way to know is to assert that re-serializing DOES break it.
    const raw = webhookBody();
    const sig = signWebhook(SECRET, raw);
    const reserialized = JSON.stringify(JSON.parse(raw), null, 2);

    assert.notEqual(reserialized, raw, "test setup: re-serializing must actually change the bytes");
    assert.equal(verifySignature(raw, sig, SECRET).valid, true);
    assert.equal(
      verifySignature(reserialized, sig, SECRET).valid,
      false,
      "verification must be over the RAW bytes",
    );
  });

  test("a missing header fails", () => {
    const r = verifySignature(BODY, undefined, SECRET);
    assert.equal(r.valid, false);
    assert.match(r.valid === false ? r.reason : "", /missing/i);
  });

  test("a header with no v1 fails", () => {
    const r = verifySignature(BODY, "t=1700000000", SECRET);
    assert.equal(r.valid, false);
    assert.match(r.valid === false ? r.reason : "", /v1/);
  });

  test("a header with no t fails", () => {
    const r = verifySignature(BODY, "v1=abc", SECRET);
    assert.equal(r.valid, false);
    assert.match(r.valid === false ? r.reason : "", /timestamp/i);
  });

  test("an empty v1 fails (and does not crash timingSafeEqual on a length mismatch)", () => {
    const r = verifySignature(BODY, "t=1700000000,v1=", SECRET);
    assert.equal(r.valid, false);
  });

  test("a truncated v1 fails rather than throwing", () => {
    const t = Math.floor(Date.now() / 1000);
    const full = signWebhook(SECRET, BODY, t).split("v1=")[1]!;
    const r = verifySignature(BODY, `t=${t},v1=${full.slice(0, 10)}`, SECRET);
    assert.equal(r.valid, false);
  });
});

describe("replay protection", () => {
  test("a stale timestamp is rejected", () => {
    const old = Math.floor(Date.now() / 1000) - DEFAULT_TOLERANCE_SECS - 60;
    const r = verifySignature(BODY, signWebhook(SECRET, BODY, old), SECRET);
    assert.equal(r.valid, false);
    assert.match(r.valid === false ? r.reason : "", /tolerance/i);
  });

  test("a FUTURE timestamp beyond tolerance is rejected too (clock skew cuts both ways)", () => {
    const future = Math.floor(Date.now() / 1000) + DEFAULT_TOLERANCE_SECS + 60;
    const r = verifySignature(BODY, signWebhook(SECRET, BODY, future), SECRET);
    assert.equal(r.valid, false);
  });

  test("within tolerance is accepted", () => {
    const recent = Math.floor(Date.now() / 1000) - (DEFAULT_TOLERANCE_SECS - 10);
    assert.equal(verifySignature(BODY, signWebhook(SECRET, BODY, recent), SECRET).valid, true);
  });

  test("tolerance=0 disables the freshness check", () => {
    // Deliberate escape hatch: the worker signs over the EVENT's `created`, so a retried
    // delivery legitimately carries an old t.
    const ancient = Math.floor(Date.now() / 1000) - 86_400;
    assert.equal(verifySignature(BODY, signWebhook(SECRET, BODY, ancient), SECRET, 0).valid, true);
  });

  test("tolerance=0 does NOT disable the HMAC check", () => {
    const ancient = Math.floor(Date.now() / 1000) - 86_400;
    const r = verifySignature(BODY, signWebhook("whsec_wrong", BODY, ancient), SECRET, 0);
    assert.equal(r.valid, false, "turning off replay protection must not turn off authentication");
  });

  test("the HMAC is checked BEFORE freshness", () => {
    // Order matters: reporting "stale" for a forged old signature would leak that the HMAC
    // was fine, and it would tell the developer the wrong thing to go fix.
    const old = Math.floor(Date.now() / 1000) - 86_400;
    const r = verifySignature(BODY, signWebhook("whsec_wrong", BODY, old), SECRET);
    assert.equal(r.valid, false);
    assert.match(
      r.valid === false ? r.reason : "",
      /HMAC/i,
      "a forged stale signature must be reported as a bad HMAC, not as stale",
    );
  });
});

describe("asWebhookEvent", () => {
  test("accepts a real event", () => {
    assert.ok(asWebhookEvent(JSON.parse(webhookBody())));
  });

  test("rejects anything that is not shaped like an event", () => {
    for (const bad of [null, undefined, 42, "str", [], {}, { type: "x" }, { data: {} }]) {
      assert.equal(asWebhookEvent(bad), undefined, `${JSON.stringify(bad)} should not narrow`);
    }
  });
});
