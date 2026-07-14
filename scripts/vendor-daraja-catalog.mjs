#!/usr/bin/env node
/**
 * Vendor THE Daraja code table + decoder from the paylod monorepo into this CLI.
 *
 * ── Why this script exists ──────────────────────────────────────────────────────────────
 * This CLI shipped 0.1.0 with a HAND-MAINTAINED fork of the Daraja error catalog in
 * `src/lib/error-catalog.ts`. Its header claimed it was "VENDORED VERBATIM" from the
 * backend. It was not: it was a copy of the PRE-FIX table, and it had already drifted:
 *
 *   • unknown codes decoded as `retryable: true` — the exact fallback that invites a blind
 *     re-charge of a payment whose outcome we cannot prove. The canonical fallback is
 *     `retryable: false`.
 *   • 1037 was "Timeout — the customer could not be reached" / category `network`, telling
 *     users to check the phone's signal. Canonically it is "The M-Pesa prompt went
 *     unanswered" / category `customer` — usually the customer simply ignored the prompt.
 *   • It had no `classifyStkResult`, so nothing stopped a bad table entry from resurrecting
 *     the 4999 false-failure bug.
 *
 * Hand-maintained copies of this table have caused a production double-charge TWICE. This
 * makes the CLI's copy the same kind of artifact the dashboard and the MCP server already
 * use: GENERATED, and drift-checked in CI.
 *
 *   node scripts/vendor-daraja-catalog.mjs           # write the vendored copies
 *   node scripts/vendor-daraja-catalog.mjs --check   # exit 1 if they have drifted
 *
 * The monorepo is located via PAYLOD_MONOREPO, else ../mpesa. When it is absent (a fresh
 * clone of just this repo, or CI without the private monorepo) --check SKIPS rather than
 * fails: the vendored files are committed, so the build never depends on the monorepo being
 * present. The drift guard is for the machines that DO have it.
 *
 * ── The one transform ───────────────────────────────────────────────────────────────────
 * The canonical `daraja-catalog.ts` does `import catalogData from "./daraja-error-codes.json"
 * with { type: "json" }`. Import attributes only became stable in Node 20.10 / 22, and this
 * CLI supports Node >= 20. So we emit the table as a TS module instead of a JSON file, and
 * rewrite that single import line. The DATA is byte-identical; only the module wrapper differs.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MONOREPO = process.env.PAYLOD_MONOREPO ?? resolve(CLI, "..", "mpesa");
const SRC = join(MONOREPO, "supabase/functions/_shared/daraja");

const CANONICAL_JSON = join(SRC, "daraja-error-codes.json");
const CANONICAL_TS = join(SRC, "daraja-catalog.ts");

const OUT_DATA = join(CLI, "src/lib/daraja-error-codes.ts");
const OUT_CATALOG = join(CLI, "src/lib/daraja-catalog.ts");

const BANNER = (from) =>
  `// GENERATED FILE — DO NOT EDIT.\n` +
  `// Source of truth: mpesa/supabase/functions/_shared/daraja/${from}\n` +
  `// Regenerate:      node scripts/vendor-daraja-catalog.mjs\n` +
  `// Check for drift: node scripts/vendor-daraja-catalog.mjs --check\n`;

/** The table, as a TS module (see "the one transform" above). */
function renderData(rawJson) {
  const parsed = JSON.parse(rawJson);
  // Exported as `unknown` so daraja-catalog.ts's own `as { codes: CatalogEntry[] }` cast —
  // which is canonical code we must not modify — still compiles. Typing it any more
  // precisely here would mean duplicating CatalogEntry, i.e. a second source of truth.
  return (
    BANNER("daraja-error-codes.json") +
    `\n/** The canonical Daraja code table, verbatim. */\n` +
    `const catalogData = ${JSON.stringify(parsed, null, 2)};\n\n` +
    `export default catalogData as unknown;\n`
  );
}

/** The decoder, verbatim, with the JSON import rewritten to the TS module. */
function renderCatalog(rawTs) {
  const rewritten = rawTs.replace(
    /import\s+catalogData\s+from\s+["']\.\/daraja-error-codes\.json["']\s+with\s+\{\s*type:\s*["']json["']\s*\};?/,
    `import catalogData from "./daraja-error-codes.js";`,
  );
  if (rewritten === rawTs) {
    throw new Error(
      "The canonical daraja-catalog.ts no longer has the JSON import we rewrite. " +
        "Check the transform in scripts/vendor-daraja-catalog.mjs.",
    );
  }
  return BANNER("daraja-catalog.ts") + "\n" + rewritten;
}

function sha(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

const check = process.argv.includes("--check");

if (!existsSync(CANONICAL_JSON) || !existsSync(CANONICAL_TS)) {
  const msg = `paylod monorepo not found at ${MONOREPO} (set PAYLOD_MONOREPO to override).`;
  if (check) {
    console.log(`⏭  skip: ${msg}`);
    console.log("   The vendored catalog is committed; the drift guard needs the monorepo.");
    process.exit(0);
  }
  console.error(`✖ ${msg}`);
  process.exit(1);
}

const wanted = [
  [OUT_DATA, renderData(readFileSync(CANONICAL_JSON, "utf8"))],
  [OUT_CATALOG, renderCatalog(readFileSync(CANONICAL_TS, "utf8"))],
];

let drifted = 0;
for (const [path, content] of wanted) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const same = current === content;

  if (check) {
    if (!same) {
      drifted += 1;
      console.error(`✖ DRIFT  ${path}`);
      console.error(`         vendored ${sha(current) || "(missing)"} != canonical ${sha(content)}`);
    } else {
      console.log(`✓ in sync  ${path}`);
    }
    continue;
  }

  if (same) {
    console.log(`= unchanged  ${path}`);
  } else {
    writeFileSync(path, content);
    console.log(`✓ wrote      ${path}`);
  }
}

if (check && drifted > 0) {
  console.error(
    `\n${drifted} vendored catalog file(s) have drifted from the monorepo.\n` +
      `Run: node scripts/vendor-daraja-catalog.mjs\n` +
      `NEVER hand-edit src/lib/daraja-catalog.ts or src/lib/daraja-error-codes.ts.`,
  );
  process.exit(1);
}
