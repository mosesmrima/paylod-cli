/**
 * The CLI's Daraja error catalog — a RE-EXPORT, not a copy.
 *
 * ⚠️ This file used to BE the table: a hand-maintained fork of the backend's catalog whose
 * header claimed it was "VENDORED VERBATIM". It was not. It was the pre-fix table, and it had
 * drifted in ways that matter for money:
 *
 *   • its fallback for an UNKNOWN code said `retryable: true`. `retryable` means SAFE TO
 *     CHARGE AGAIN. An unknown code is an indeterminate outcome — we cannot prove no money
 *     moved — so advertising it as retryable invites a double charge. Canonically it is false.
 *   • its 1037 read "Timeout — the customer could not be reached", category `network`, and
 *     told the merchant to check the customer's signal. Canonically 1037 is "The M-Pesa prompt
 *     went unanswered", category `customer`: usually the customer simply ignored the prompt.
 *   • it had no classifier, so nothing structurally prevented a stale table entry from
 *     re-shipping the 4999 false-failure bug that has already double-charged customers twice.
 *
 * The real table now lives in `daraja-catalog.ts` + `daraja-error-codes.ts`, which are
 * GENERATED from the monorepo's single source of truth by `scripts/vendor-daraja-catalog.mjs`
 * and drift-checked by `npm run catalog:check`. This module stays only so the existing import
 * sites (`commands/errors.ts`, `lib/render.ts`) do not have to change.
 *
 * Do not put a table in here again.
 */

export {
  ALL_ENTRIES,
  classifyStkResult,
  decodeDarajaResult,
  ERROR_CATALOG,
  isPendingError,
  PENDING_RESULT_CODES,
  type CatalogEntry,
  type DarajaCategory,
  type DarajaFamily,
  type DecodedError,
  type StkOutcome,
} from "./daraja-catalog.js";
