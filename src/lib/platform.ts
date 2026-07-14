/**
 * Platform-specific filesystem + credential-protection primitives.
 *
 * This module exists because of ONE bug: `chmodSync(file, 0o600)` is a silent no-op on
 * Windows. Node maps POSIX modes onto the single FAT/NTFS read-only bit; the write does
 * not throw, and it does not restrict anyone. The old config.ts wrote OAuth refresh
 * tokens and `mp_live_` API keys — credentials that move real money — chmod'd them 0600,
 * caught nothing, and documented that as the security guarantee. On Windows the file
 * landed with inherited ACLs, readable by every other user of the machine.
 *
 * Claiming a protection you do not provide is worse than providing none, because the
 * user stops thinking about it. So:
 *
 *   POSIX (Linux/macOS)  → 0600 file, 0700 dir, and we VERIFY with stat() afterwards.
 *   Windows              → a real restrictive ACL via `icacls /inheritance:r /grant:r`,
 *                          and we VERIFY by re-reading the ACL.
 *   Anything else, or a  → we say so, loudly, on stderr. Never silently.
 *   failure of the above
 *
 * Everything here is pure w.r.t. `process.platform`, which is read through `platform()`
 * so the tests can exercise all three branches on one machine.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Read the platform through a seam so tests can stub it. */
export function platform(): NodeJS.Platform {
  return (process.env.PAYLOD_FAKE_PLATFORM as NodeJS.Platform) || process.platform;
}

/* ── Where config lives ───────────────────────────────────────────────────────── */

/**
 * The conventional per-platform config directory.
 *
 *   Windows  %APPDATA%\paylod                       (roaming app data — where users look)
 *   macOS    ~/Library/Application Support/paylod   (Apple's documented location)
 *   Linux    $XDG_CONFIG_HOME/paylod || ~/.config/paylod
 */
export function platformConfigDir(): string {
  const home = process.env.PAYLOD_FAKE_HOME || homedir();
  switch (platform()) {
    case "win32": {
      const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
      return join(appData, "paylod");
    }
    case "darwin":
      return join(home, "Library", "Application Support", "paylod");
    default: {
      const xdg = process.env.XDG_CONFIG_HOME;
      return xdg ? join(xdg, "paylod") : join(home, ".config", "paylod");
    }
  }
}

/**
 * Where 0.1.0 always put the config, on every platform. We still READ this if it exists,
 * so upgrading does not orphan anyone's login.
 */
export function legacyConfigDir(): string {
  const home = process.env.PAYLOD_FAKE_HOME || homedir();
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "paylod") : join(home, ".config", "paylod");
}

/* ── Protecting the file ──────────────────────────────────────────────────────── */

export type ProtectionMechanism = "posix-mode" | "windows-acl" | "none";

export interface Protection {
  /** True only when we CONFIRMED the file is not readable by other users. */
  readonly protected: boolean;
  readonly mechanism: ProtectionMechanism;
  /** Human-readable detail — the reason when `protected` is false. */
  readonly detail: string;
}

/**
 * A Windows account name safe to interpolate into an icacls argument.
 *
 * We use execFileSync (no shell), so this is defence in depth rather than the only
 * barrier — but an account name is attacker-influencable in exotic domain setups and
 * icacls has its own argument grammar (`:`, `(`, `)` are meaningful), so we refuse
 * anything that is not a plain DOMAIN\user.
 */
function windowsPrincipal(): string | undefined {
  const user = process.env.USERNAME;
  if (!user) return undefined;
  const domain = process.env.USERDOMAIN;
  const name = domain ? `${domain}\\${user}` : user;
  return /^[A-Za-z0-9 ._-]+(\\[A-Za-z0-9 ._-]+)?$/.test(name) ? name : undefined;
}

/**
 * Lock a path down to the current user with an explicit ACL.
 *
 * `/inheritance:r` REMOVES inherited ACEs — without it, whatever %APPDATA% or the
 * profile root grants (often `Users:(RX)`) still applies and the file stays readable.
 * `/grant:r <user>:F` then re-grants full control to just us. `/T` is not used: we
 * apply this per-path, and the directory call carries the (OI)(CI) inheritance flags
 * so files created inside it later are covered too.
 */
function lockWindows(path: string, isDir: boolean): Protection {
  const principal = windowsPrincipal();
  if (!principal) {
    return {
      protected: false,
      mechanism: "none",
      detail: "could not determine the current Windows user (USERNAME is unset)",
    };
  }
  const grant = isDir ? `${principal}:(OI)(CI)F` : `${principal}:F`;
  try {
    execFileSync("icacls", [path, "/inheritance:r", "/grant:r", grant], {
      stdio: "pipe",
      windowsHide: true,
    });
  } catch (e) {
    return {
      protected: false,
      mechanism: "none",
      detail: `icacls failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
    };
  }

  // Trust nothing: read the ACL back and confirm nobody else is on it.
  try {
    const acl = execFileSync("icacls", [path], {
      stdio: "pipe",
      windowsHide: true,
      encoding: "utf8",
    });
    const others = aclPrincipalsOtherThan(acl, principal, path);
    if (others.length > 0) {
      return {
        protected: false,
        mechanism: "none",
        detail: `ACL still grants access to: ${others.join(", ")}`,
      };
    }
  } catch {
    return { protected: false, mechanism: "none", detail: "could not read back the ACL to verify it" };
  }

  return { protected: true, mechanism: "windows-acl", detail: `ACL restricted to ${principal}` };
}

/**
 * Parse `icacls <path>` output and return every principal on the ACL that is neither us nor a
 * benign built-in. Exported for tests — icacls cannot run on Linux, but its output format can
 * and must be parsed correctly, and that parse is what decides whether we call a file "safe".
 *
 * Format:  C:\path\file NT AUTHORITY\SYSTEM:(F)
 *                       BUILTIN\Administrators:(F)
 *                       DESKTOP-1\moses:(OI)(CI)(F)
 *          Successfully processed 1 files; Failed processing 0 files
 *
 * We are given `queriedPath` and strip it literally rather than trying to regex the path off
 * the first line. Both Windows paths AND Windows principals can contain spaces and
 * backslashes ("NT AUTHORITY\SYSTEM", "C:\Program Files\..."), so there is no reliable way to
 * tell where the path ends and the principal begins — except that we already know the path.
 */
export function aclPrincipalsOtherThan(
  aclOutput: string,
  principal: string,
  queriedPath = "",
): string[] {
  // SYSTEM and Administrators can read anything on the box regardless; excluding them is not
  // a weakening — a machine admin is already game over. What must NOT be on this ACL is
  // `BUILTIN\Users`, `Authenticated Users`, `Everyone`, or another human's account.
  const BENIGN = /^(NT AUTHORITY\\SYSTEM|BUILTIN\\Administrators)$/i;
  const out: string[] = [];

  for (const rawLine of aclOutput.split(/\r?\n/)) {
    let line = rawLine;
    if (queriedPath && line.startsWith(queriedPath)) line = line.slice(queriedPath.length);
    line = line.trim();

    if (!line) continue;
    if (/^(Successfully processed|Failed processing)/i.test(line)) continue;

    // The principal is everything before the first `:(` — permissions never precede it.
    const idx = line.indexOf(":(");
    if (idx <= 0) continue;

    const who = line.slice(0, idx).trim();
    if (!who) continue;
    if (who.toLowerCase() === principal.toLowerCase()) continue;
    if (BENIGN.test(who)) continue;
    out.push(who);
  }
  return out;
}

/** POSIX: chmod, then stat to CONFIRM group/other have no bits. */
function lockPosix(path: string, mode: number): Protection {
  try {
    chmodSync(path, mode);
  } catch (e) {
    return {
      protected: false,
      mechanism: "none",
      detail: `chmod failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  try {
    const actual = statSync(path).mode & 0o777;
    if ((actual & 0o077) !== 0) {
      return {
        protected: false,
        mechanism: "none",
        detail: `file mode is ${actual.toString(8)} — group/other still have access`,
      };
    }
    return { protected: true, mechanism: "posix-mode", detail: `mode ${actual.toString(8)}` };
  } catch (e) {
    return {
      protected: false,
      mechanism: "none",
      detail: `could not stat the file to verify its mode: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Restrict an existing path to the current user. Never throws. */
export function protectPath(path: string, isDir: boolean): Protection {
  switch (platform()) {
    case "win32":
      return lockWindows(path, isDir);
    case "darwin":
    case "linux":
    case "freebsd":
    case "openbsd":
    case "sunos":
    case "aix":
      return lockPosix(path, isDir ? 0o700 : 0o600);
    default:
      return {
        protected: false,
        mechanism: "none",
        detail: `unknown platform "${platform()}" — no file-permission model to apply`,
      };
  }
}

/**
 * Report a path's CURRENT protection without changing it.
 *
 * `whoami` uses this: a status command must never have the side effect of fixing the
 * thing it is reporting on, or the user can never see that it was broken.
 */
export function inspectPath(path: string): Protection {
  switch (platform()) {
    case "win32": {
      const principal = windowsPrincipal();
      if (!principal) {
        return { protected: false, mechanism: "none", detail: "USERNAME is unset" };
      }
      try {
        const acl = execFileSync("icacls", [path], {
          stdio: "pipe",
          windowsHide: true,
          encoding: "utf8",
        });
        const others = aclPrincipalsOtherThan(acl, principal, path);
        return others.length === 0
          ? { protected: true, mechanism: "windows-acl", detail: `ACL restricted to ${principal}` }
          : {
              protected: false,
              mechanism: "none",
              detail: `readable by: ${others.join(", ")}`,
            };
      } catch {
        return { protected: false, mechanism: "none", detail: "could not read the ACL" };
      }
    }
    case "darwin":
    case "linux":
    case "freebsd":
    case "openbsd":
    case "sunos":
    case "aix":
      try {
        const mode = statSync(path).mode & 0o777;
        return (mode & 0o077) === 0
          ? { protected: true, mechanism: "posix-mode", detail: `mode ${mode.toString(8)}` }
          : {
              protected: false,
              mechanism: "none",
              detail: `mode is ${mode.toString(8)} — group/other can read it`,
            };
      } catch (e) {
        return {
          protected: false,
          mechanism: "none",
          detail: `could not stat: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    default:
      return {
        protected: false,
        mechanism: "none",
        detail: `unknown platform "${platform()}" — no file-permission model to apply`,
      };
  }
}

/** Create a directory and restrict it to the current user. */
export function secureMkdir(dir: string): Protection {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return protectPath(dir, true);
}

/**
 * Write `content` to `path` such that only the current user can read it.
 *
 * The file is created with 0600 in the open(2) call (so it is never briefly readable,
 * even on POSIX), then the platform ACL/mode is applied and VERIFIED. The caller gets
 * the verdict and is responsible for telling the user when it is `protected: false` —
 * see `warnIfUnprotected`.
 */
export function secureWriteFile(path: string, content: string): Protection {
  writeFileSync(path, content, { mode: 0o600 });
  return protectPath(path, false);
}

/* ── Telling the user the truth ───────────────────────────────────────────────── */

/** Warn at most once per process per path — a loop of saves must not spam the terminal. */
const warned = new Set<string>();

/** Reset the once-per-process warning memo. Tests only. */
export function resetWarnings(): void {
  warned.clear();
}

/**
 * If we could not protect the credential file, SAY SO — on stderr, unmissably, every
 * new path, once. Silence here is the bug this whole module exists to fix.
 *
 * Suppressible with PAYLOD_SUPPRESS_PERMISSION_WARNING=1 for users who have made an
 * informed decision (e.g. an ephemeral CI box). Suppressing it is the user's call to
 * make — it was never ours.
 */
export function warnIfUnprotected(path: string, p: Protection): void {
  if (p.protected) return;
  if (process.env.PAYLOD_SUPPRESS_PERMISSION_WARNING === "1") return;
  if (warned.has(path)) return;
  warned.add(path);

  const lines = [
    "",
    "  ⚠  SECURITY: paylod could not restrict access to your credential file.",
    `     ${path}`,
    `     ${p.detail}`,
    "",
    "     This file holds OAuth tokens and API keys that can move real money, and",
    "     other users of this machine may be able to read it.",
    "",
    "     Fix it, or avoid the file entirely:",
    "       • Windows:  icacls \"<path>\" /inheritance:r /grant:r \"%USERNAME%\":F",
    "       • Or pass credentials per-invocation instead: PAYLOD_API_KEY=mp_test_…",
    "",
    "     Silence this (only if you understand the risk): PAYLOD_SUPPRESS_PERMISSION_WARNING=1",
    "",
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
}
