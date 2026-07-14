/**
 * The Daraja error catalog — the money-safety properties.
 *
 * `retryable` in this catalog means SAFE TO CHARGE AGAIN. It does not mean "the customer
 * could try again". Getting that distinction wrong has already double-charged real customers
 * twice, both times because a hand-maintained copy of this table drifted from the engine.
 *
 * These tests encode the invariants that a drifted copy would violate, so a future re-fork
 * fails here rather than in production.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  ALL_ENTRIES,
  classifyStkResult,
  decodeDarajaResult,
  ERROR_CATALOG,
  PENDING_RESULT_CODES,
} from "./error-catalog.js";

describe("4999 — the double-charge code", () => {
  test("decodes as PENDING and is NOT retryable", () => {
    const d = decodeDarajaResult("4999");

    // If this ever flips, retrying fires a SECOND STK prompt at a customer who is at that
    // moment typing their PIN into the first one. That is the double charge, exactly.
    assert.equal(d.category, "pending", "4999 must be pending — the prompt is still live");
    assert.equal(d.retryable, false, "4999 must NOT be retryable — a retry can double-charge");
  });

  test("classifies as pending as a number as well as a string", () => {
    // Daraja sends ResultCode as a number on the callback and a string on the query. Both.
    assert.equal(classifyStkResult(4999), "pending");
    assert.equal(classifyStkResult("4999"), "pending");
  });

  test("never says the payment failed", () => {
    const d = decodeDarajaResult(4999);
    assert.doesNotMatch(d.title, /fail/i, "4999 must not be described as a failure");
    assert.match(d.fix, /do not retry|not retry/i, "the fix must tell the caller not to retry");
  });

  test("500.001.1001 is pending too — the OTHER code for the same situation", () => {
    // The original production bug was a literal `=== "500.001.1001"` that did not know about
    // 4999. The inverse omission is just as fatal, so pin both.
    assert.equal(classifyStkResult("500.001.1001", "The transaction is being processed"), "pending");
    assert.ok(PENDING_RESULT_CODES.has("4999"));
  });

  test("an overloaded 500.001.1001 that is really a config error is NOT pending", () => {
    // Same code, terminal meaning. Polling forever on this would hang the payment.
    assert.equal(
      classifyStkResult("500.001.1001", "Merchant does not exist"),
      "failed",
      "a terminal 500.* must not be mistaken for 'still processing'",
    );
  });
});

describe("1037 — the prompt went unanswered", () => {
  test("is about the prompt expiring, NOT about the customer's signal", () => {
    const d = decodeDarajaResult("1037");

    // The pre-fix CLI copy said "Timeout — the customer could not be reached", category
    // `network`, and told merchants to check the phone had Safaricom coverage. That sent
    // people debugging their customer's reception when in fact the customer had simply
    // ignored the prompt. Daraja does not tell us which, so we must not claim to know.
    assert.equal(d.category, "customer", "1037 is a customer-behaviour outcome, not a network one");
    assert.match(
      d.title,
      /unanswered|expired|no response/i,
      "1037's title should describe an unanswered prompt",
    );
    assert.doesNotMatch(
      d.title,
      /could not be reached/i,
      "1037 must not be titled as an unreachable handset — that is only one of two causes",
    );
  });

  test("is terminal, and safe to charge again (no money moved)", () => {
    const d = decodeDarajaResult("1037");
    assert.equal(classifyStkResult("1037"), "failed", "1037 is terminal — the prompt is dead");
    assert.equal(d.retryable, true, "no money moved on a 1037, so a fresh charge is safe");
  });
});

describe("the unknown-code fallback", () => {
  test("an unknown code is NOT retryable — indeterminate is not the same as failed", () => {
    const d = decodeDarajaResult("31337");

    // The 0.1.0 CLI's fallback said `retryable: true`. An unknown code means we cannot prove
    // no money moved. Advertising that as "safe to charge again" invites a blind re-charge.
    assert.equal(
      d.retryable,
      false,
      "an unknown code must not be advertised as safe to charge again",
    );
    assert.match(d.fix, /status|before charging again/i, "the fix must say: check the status first");
  });

  test("a null/absent code is treated as unknown, not as success", () => {
    for (const bad of [null, undefined, ""]) {
      const d = decodeDarajaResult(bad as null);
      assert.equal(d.retryable, false, `${String(bad)} must not be retryable`);
      assert.notEqual(d.category, "success", `${String(bad)} must never decode as success`);
    }
  });

  test("the raw ResultDesc is surfaced as the cause when the code is unknown", () => {
    const d = decodeDarajaResult("31337", "Something Safaricom invented this morning");
    assert.equal(d.cause, "Something Safaricom invented this morning");
  });
});

describe("catalog-wide invariants", () => {
  test("0 is the only success code", () => {
    assert.equal(decodeDarajaResult(0).category, "success");
    assert.equal(classifyStkResult(0), "success");

    // The table is keyed by (code, family): "0" appears once per Daraja surface, because a
    // success on STK and a success on B2C are different rows. What must hold is that no code
    // OTHER than 0 is ever a success.
    const successCodes = new Set(
      ALL_ENTRIES.filter((e) => e.category === "success").map((e) => e.code),
    );
    assert.deepEqual([...successCodes], ["0"]);
  });

  test("NO pending entry is ever retryable", () => {
    // The single most important structural rule in the table: a payment that is still in
    // flight can never be "safe to charge again", by definition.
    for (const e of ALL_ENTRIES) {
      if (e.category === "pending") {
        assert.equal(e.retryable, false, `pending code ${e.code} is marked retryable`);
      }
    }
  });

  test("every entry has a non-empty title, cause, fix and customerMessage", () => {
    for (const e of ALL_ENTRIES) {
      for (const field of ["title", "cause", "fix", "customerMessage"] as const) {
        assert.ok(
          typeof e[field] === "string" && e[field].trim().length > 0,
          `${e.code} has an empty ${field}`,
        );
      }
    }
  });

  test("the codes users actually hit are all present", () => {
    for (const code of ["0", "1", "1032", "1037", "2001", "4999", "1019", "1001"]) {
      assert.ok(code in ERROR_CATALOG, `catalog is missing ${code}`);
    }
  });

  test("decode is deterministic and does not mutate the table", () => {
    const before = JSON.stringify(ERROR_CATALOG["1032"]);
    const a = decodeDarajaResult("1032");
    const b = decodeDarajaResult("1032");
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(ERROR_CATALOG["1032"]), before, "decode mutated the catalog");
  });
});

describe("the vendored catalog has not drifted from the monorepo", () => {
  // This is the test that stops the CLI's table becoming the fifth hand-maintained fork.
  // It needs the (private) monorepo, so it SKIPS when that is absent — a public clone must
  // still be able to run the suite. The generated files are committed, so nothing else needs it.
  // This file compiles to build/test/lib/, so the repo root is three levels up — NOT two.
  // (Getting this wrong made the test silently "skip" instead of run, which is the exact
  // failure mode this whole exercise is about: a test that cannot fail is not a test.)
  const repoRoot = resolve(import.meta.dirname, "../../..");
  const monorepo = process.env.PAYLOD_MONOREPO ?? resolve(repoRoot, "..", "mpesa");
  const canonical = resolve(monorepo, "supabase/functions/_shared/daraja/daraja-error-codes.json");
  const script = resolve(repoRoot, "scripts/vendor-daraja-catalog.mjs");

  test(
    "src/lib/daraja-*.ts is byte-identical to what the generator would emit",
    { skip: existsSync(canonical) ? false : `monorepo not found at ${monorepo}` },
    () => {
      // Throws (non-zero exit) if any vendored file differs from the canonical source.
      execFileSync(process.execPath, [script, "--check"], {
        stdio: "pipe",
        env: { ...process.env, PAYLOD_MONOREPO: monorepo },
      });
    },
  );
});
