/**
 * Config + credential persistence.
 *
 * Layout (XDG-ish, works on Linux/macOS/Windows):
 *   $PAYLOD_CONFIG_DIR  ||  $XDG_CONFIG_HOME/paylod  ||  ~/.config/paylod
 *     └── config.json      (0600 — profiles, tokens, API keys)
 *
 * Secrets are written 0600 and the containing directory 0700. On platforms with
 * an OS keychain we store the OAuth refresh token there instead (see keychain.ts)
 * and leave only non-secret metadata in config.json.
 *
 * Everything here is immutable-in / immutable-out: mutators return a NEW config.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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

export function configDir(): string {
  const explicit = process.env.PAYLOD_CONFIG_DIR;
  if (explicit) return explicit;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "paylod");
  return join(homedir(), ".config", "paylod");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

/** Read config from disk. A missing/corrupt file yields the empty config (never throws). */
export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) return EMPTY_CONFIG;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
    return {
      apiBase: parsed.apiBase ?? DEFAULT_API_BASE,
      currentProfile: parsed.currentProfile ?? "default",
      profiles: parsed.profiles ?? {},
    };
  } catch {
    return EMPTY_CONFIG;
  }
}

/**
 * Atomically write config with 0600 perms (0700 dir).
 *
 * Write-to-temp + rename means a crash mid-write can never leave a truncated
 * credential file behind. chmod BEFORE the rename so the file is never briefly
 * world-readable at its final path.
 */
export function saveConfig(config: Config): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* Windows / non-POSIX: no-op. ACLs on %APPDATA% are already user-scoped. */
  }

  const target = configPath();
  const tmp = join(dir, `.config.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* no-op on Windows */
  }
  renameSync(tmp, target);
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
