/**
 * Terminal presentation layer.
 *
 * Single place that knows about colour, spinners, and the `--json` switch. Commands
 * never call console.log directly — they call `ok()` / `fail()` / `emit()` so that
 * `--json` output stays machine-clean (JSON on stdout, nothing else) and human
 * output stays pretty.
 *
 * Colour is disabled automatically when stdout is not a TTY, when NO_COLOR is set
 * (no-color.org), or under `--json`.
 */

import pc from "picocolors";
import { createSpinner } from "nanospinner";

/** Set once by the root command from the global --json flag. */
let jsonMode = false;

export function setJsonMode(on: boolean): void {
  jsonMode = on;
}

export function isJson(): boolean {
  return jsonMode;
}

const colorEnabled = (): boolean =>
  !jsonMode && process.stdout.isTTY === true && !process.env.NO_COLOR;

/** Colour helpers that become identity functions when colour is off. */
const c = {
  bold: (s: string) => (colorEnabled() ? pc.bold(s) : s),
  dim: (s: string) => (colorEnabled() ? pc.dim(s) : s),
  green: (s: string) => (colorEnabled() ? pc.green(s) : s),
  red: (s: string) => (colorEnabled() ? pc.red(s) : s),
  yellow: (s: string) => (colorEnabled() ? pc.yellow(s) : s),
  cyan: (s: string) => (colorEnabled() ? pc.cyan(s) : s),
  magenta: (s: string) => (colorEnabled() ? pc.magenta(s) : s),
  gray: (s: string) => (colorEnabled() ? pc.gray(s) : s),
  greenBold: (s: string) => (colorEnabled() ? pc.bold(pc.green(s)) : s),
  redBold: (s: string) => (colorEnabled() ? pc.bold(pc.red(s)) : s),
};

export { c as color };

/** The single JSON emitter. In --json mode this is the ONLY thing on stdout. */
export function emit(data: unknown): void {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  }
}

/** Human-only line. Suppressed entirely under --json. */
export function line(text = ""): void {
  if (!jsonMode) process.stdout.write(`${text}\n`);
}

export function ok(text: string): void {
  line(`${c.green("✔")} ${text}`);
}

export function info(text: string): void {
  line(`${c.cyan("›")} ${text}`);
}

export function warn(text: string): void {
  line(`${c.yellow("!")} ${text}`);
}

/** Errors ALWAYS go to stderr, in both modes, so `--json | jq` never chokes. */
export function fail(text: string): void {
  process.stderr.write(`${c.red("✖")} ${text}\n`);
}

/** A dim hint under an error — "here's what to do next". */
export function hint(text: string): void {
  process.stderr.write(`  ${c.dim(text)}\n`);
}

export interface Spin {
  update(text: string): void;
  succeed(text?: string): void;
  error(text?: string): void;
  stop(): void;
}

/**
 * A spinner that degrades to nothing under --json and to plain lines on a
 * non-TTY (so CI logs stay readable instead of filling with escape codes).
 */
export function spinner(text: string): Spin {
  if (jsonMode) {
    return { update: () => {}, succeed: () => {}, error: () => {}, stop: () => {} };
  }
  if (!process.stdout.isTTY) {
    return {
      update: (t: string) => line(`  ${t}`),
      succeed: (t?: string) => t && ok(t),
      error: (t?: string) => t && fail(t),
      stop: () => {},
    };
  }
  const s = createSpinner(text, { color: "cyan" }).start();
  return {
    update: (t: string) => s.update({ text: t }),
    succeed: (t?: string) => s.success({ text: t ?? text }),
    error: (t?: string) => s.error({ text: t ?? text }),
    stop: () => s.stop({ mark: "", text: "" }),
  };
}

/** Two-column key/value block, right-aligned keys. The workhorse of our output. */
export function kv(pairs: readonly (readonly [string, string])[]): void {
  if (jsonMode || pairs.length === 0) return;
  const width = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) {
    line(`  ${c.dim(k.padStart(width))}  ${v}`);
  }
}

/** A rule with an optional inline title — used to frame the settle moment. */
export function rule(title?: string): void {
  if (jsonMode) return;
  const width = Math.min(process.stdout.columns || 60, 60);
  if (!title) {
    line(c.dim("─".repeat(width)));
    return;
  }
  const left = `── ${title} `;
  line(c.dim(left + "─".repeat(Math.max(0, width - left.length))));
}

/** Format KES amounts the way a Kenyan merchant expects: KES 1,500 */
export function kes(amount: number): string {
  return `KES ${amount.toLocaleString("en-KE")}`;
}
