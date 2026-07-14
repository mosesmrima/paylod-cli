/**
 * The CLI's single error type.
 *
 * Commands throw PaylodError; the root handler in index.ts renders it (message +
 * actionable hint on stderr, structured JSON under --json) and picks the exit code.
 * Nothing else in the CLI is allowed to call process.exit, which keeps exit-code
 * policy in exactly one place.
 */

export interface PaylodErrorOptions {
  /** HTTP status, when the error came from the API. */
  readonly status?: number;
  /** Parsed response body, surfaced under --json. */
  readonly body?: unknown;
  /** One line of "here is what to do about it". */
  readonly hint?: string;
  /** Process exit code. Defaults to 1. */
  readonly exitCode?: number;
}

export class PaylodError extends Error {
  readonly status?: number;
  readonly body?: unknown;
  readonly hint?: string;
  readonly exitCode: number;

  constructor(message: string, opts: PaylodErrorOptions = {}) {
    super(message);
    this.name = "PaylodError";
    this.status = opts.status;
    this.body = opts.body;
    this.hint = opts.hint;
    this.exitCode = opts.exitCode ?? 1;
  }

  toJSON(): Record<string, unknown> {
    return {
      ok: false,
      error: this.message,
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.body !== undefined ? { details: this.body } : {}),
    };
  }
}

/** Thrown when a command needs `paylod login` but no valid token is present. */
export class NotAuthenticatedError extends PaylodError {
  constructor(what = "This command") {
    super(`${what} requires you to be logged in.`, {
      hint: "Run `paylod login` to authenticate with your paylod account.",
      exitCode: 4,
    });
    this.name = "NotAuthenticatedError";
  }
}

/** Thrown when a data-plane command has no merchant API key to use. */
export class NoApiKeyError extends PaylodError {
  constructor() {
    super("No paylod API key found.", {
      hint:
        "Set one with `paylod keys mint` / `paylod keys use <key>`, pass --api-key, " +
        "or export PAYLOD_API_KEY=mp_test_…",
      exitCode: 4,
    });
    this.name = "NoApiKeyError";
  }
}
