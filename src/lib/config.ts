/**
 * Config + credential persistence.
 *
 * Layout (conventional per platform — see platform.ts):
 *   $PAYLOD_CONFIG_DIR                      (explicit override, always wins)
 *   ~/.config/paylod                        (the 0.1.0 path — still read if it exists)
 *   %APPDATA%\paylod                        (Windows)
 *   ~/Library/Application Support/paylod    (macOS)
 *   $XDG_CONFIG_HOME/paylod || ~/.config/paylod   (Linux)
 *     └── config.json      (profiles, tokens, API keys)
 *
 * The file is restricted to the current user by `secureWriteFile`, which uses the
 * mechanism that actually works on the host — 0600 on POSIX, an explicit ACL on
 * Windows — and VERIFIES it. When it cannot, the user is told, loudly. It does not
 * pretend. (0.1.0 called chmod(0600) on Windows, where it is a no-op, and called that
 * a guarantee.)
 *
 * On platforms with an OS keychain we store the OAuth refresh token there instead (see
 * keychain.ts) and leave only non-secret metadata in config.json.
 *
 * Everything here is immutable-in / immutable-out: mutators return a NEW config.
 */

import { readFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  legacyConfigDir,
  platformConfigDir,
  protectPath,
  secureMkdir,
  secureWriteFile,
  warnIfUnprotected,
  type Protection,
} from "./platform.js";

/** The one canonical resource the paylod AS will mint tokens for (RFC 8707 audience). */
export const RESOURCE_URI = "https://mcp.paylod.dev/mcp";
/** OAuth 2.1 authorization server issuer. */
export const AS_ISSUER = "https://paylod.dev/oauth";
/** Backend edge-function base. NOTE: api.paylod.dev/v1 is advertised but does not route today. */
export const DEFAULT_API_BASE = "https://paylod.dev/functions/v1";

/** Every scope the AS advertises. `paylod login` requests the full set by default. */
export const ALL_SCOPES = [
  "paylod:team.read",
  "paylod:apps.write",
  "paylod:credentials.write",
  "paylod:keys.mint",
  "paylod:webhooks.write",
  "paylod:payments.collect",
  "paylod:payments.read",
  "paylod:payments.payout",
  "paylod:payments.simulate",
] as const;

export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Absolute epoch-ms expiry of the access token. */
  readonly expiresAt: number;
  readonly scope: string;
  /** The DCR client_id this token was minted for (needed to refresh). */
  readonly clientId: string;
}

export interface Profile {
  /** OAuth tokens for management ops. Absent until `paylod login`. */
  readonly oauth?: OAuthTokens;
  /** Merchant API key (mp_live_ / mp_test_) for runtime ops (collect/status). */
  readonly apiKey?: string;
  /** Default application to target when --app is omitted. */
  readonly applicationId?: string;
  /** Default M-Pesa environment. */
  readonly env?: "sandbox" | "production";
  /** Webhook signing secret, used by `paylod listen` to verify signatures locally. */
  readonly webhookSecret?: string;
}

export interface Config {
  readonly apiBase: string;
  readonly currentProfile: string;
  readonly profiles: Readonly<Record<string, Profile>>;
}

export const EMPTY_CONFIG: Config = Object.freeze({
  apiBase: DEFAULT_API_BASE,
  currentProfile: "default",
  profiles: Object.freeze({}),
});

/**
 * Resolve the config directory.
 *
 * Order is load-bearing:
 *   1. PAYLOD_CONFIG_DIR — an explicit override always wins (CI, tests, sandboxing).
 *   2. The LEGACY 0.1.0 path, but ONLY if it already exists. Every 0.1.0 user on macOS
 *      and Windows has their tokens in ~/.config/paylod; silently moving to the new
 *      conventional path would log them out and strand a credential file behind. So we
 *      keep using the old one when it is there, and only new installs get the new path.
 *   3. The conventional per-platform location.
 */
export function configDir(): string {
  const explicit = process.env.PAYLOD_CONFIG_DIR;
  if (explicit) return explicit;

  const legacy = legacyConfigDir();
  const modern = platformConfigDir();
  if (legacy !== modern && existsSync(join(legacy, "config.json"))) return legacy;

  return modern;
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

/**
 * Read config from disk. A missing, corrupt, truncated or wrong-shaped file yields the
 * empty config and NEVER throws — a half-written credential file must degrade to "you
 * are logged out", not to a stack trace on every command.
 *
 * Each field is validated independently, so a config whose `profiles` key is garbage
 * still yields a usable apiBase rather than throwing the whole file away.
 */
export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) return EMPTY_CONFIG;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return EMPTY_CONFIG;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return EMPTY_CONFIG;

  const p = parsed as Record<string, unknown>;
  const profiles =
    typeof p.profiles === "object" && p.profiles !== null && !Array.isArray(p.profiles)
      ? (p.profiles as Record<string, Profile>)
      : {};

  return {
    apiBase: typeof p.apiBase === "string" && p.apiBase ? p.apiBase : DEFAULT_API_BASE,
    currentProfile:
      typeof p.currentProfile === "string" && p.currentProfile ? p.currentProfile : "default",
    profiles,
  };
}

/**
 * Atomically write config, restricted to the current user.
 *
 * Write-to-temp + rename means a crash mid-write can never leave a truncated credential
 * file behind. The temp file is created 0600 and locked down BEFORE the rename, so the
 * bytes are never readable by anyone else, even for an instant, at either path.
 *
 * Returns the protection actually achieved. `saveConfig` warns the user when that is
 * "none" — the whole point of this module. Callers who need to react to it (tests,
 * `whoami`) can read the return value.
 */
export function saveConfig(config: Config): Protection {
  const dir = configDir();
  const dirProtection = secureMkdir(dir);

  const target = configPath();
  const tmp = join(dir, `.config.${process.pid}.tmp`);

  let fileProtection: Protection;
  try {
    fileProtection = secureWriteFile(tmp, `${JSON.stringify(config, null, 2)}\n`);
    renameSync(tmp, target);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw e;
  }

  // rename(2) preserves the mode/ACL, but re-assert on the final path rather than
  // assume it: on Windows the destination directory's inheritable ACEs are what we are
  // defending against, and a replaced file can pick them up.
  const finalProtection = protectPath(target, false);

  const worst = [dirProtection, fileProtection, finalProtection].find((p) => !p.protected);
  const result = worst ?? finalProtection;
  warnIfUnprotected(target, result);
  return result;
}

export function currentProfile(config: Config): Profile {
  return config.profiles[config.currentProfile] ?? {};
}

/** Immutably merge a patch into the named (default: current) profile. */
export function withProfile(
  config: Config,
  patch: Partial<Profile>,
  name = config.currentProfile,
): Config {
  const existing = config.profiles[name] ?? {};
  return {
    ...config,
    profiles: {
      ...config.profiles,
      [name]: { ...existing, ...patch },
    },
  };
}

/** Immutably remove keys from the named profile (used by `logout`). */
export function withoutProfileKeys(
  config: Config,
  keys: readonly (keyof Profile)[],
  name = config.currentProfile,
): Config {
  const existing = { ...(config.profiles[name] ?? {}) } as Record<string, unknown>;
  for (const k of keys) delete existing[k];
  return {
    ...config,
    profiles: { ...config.profiles, [name]: existing as Profile },
  };
}

/**
 * Resolve the API base. Env var wins so CI can point at a staging stack without
 * mutating the user's config file.
 */
export function resolveApiBase(config: Config): string {
  return (process.env.PAYLOD_API_BASE ?? config.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
}

/**
 * Resolve the merchant API key: --api-key flag > PAYLOD_API_KEY env > profile.
 * Env-first ordering is what lets `collect` run in CI with no config file at all.
 */
export function resolveApiKey(config: Config, flag?: string): string | undefined {
  return flag ?? process.env.PAYLOD_API_KEY ?? currentProfile(config).apiKey;
}

/** Scratch path for the temp file, exported for tests. */
export function tempRoot(): string {
  return tmpdir();
}
