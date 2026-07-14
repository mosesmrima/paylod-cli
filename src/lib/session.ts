/**
 * Resolves the credentials a command needs, transparently refreshing OAuth tokens.
 *
 * Commands ask for what they need — `requireOAuth()` or `requireApiKey()` — and get
 * back a ready-to-use bearer, or a clean NotAuthenticatedError telling the user to
 * run `paylod login`. No command pokes at the config file or the keychain directly.
 */

import {
  loadConfig,
  saveConfig,
  currentProfile,
  withProfile,
  resolveApiBase,
  resolveApiKey,
  type Config,
} from "./config.js";
import { getSecret, setSecret } from "./keychain.js";
import { refreshToken } from "./oauth.js";
import { NoApiKeyError, NotAuthenticatedError } from "./errors.js";

/** Refresh once the access token is within this window of expiring. */
const REFRESH_SKEW_MS = 60_000;

/** Keychain account name for the current profile's refresh token. */
export function refreshAccount(profile: string): string {
  return `${profile}:refresh_token`;
}

export interface Session {
  readonly apiBase: string;
  readonly accessToken: string;
  readonly scopes: readonly string[];
}

/**
 * Get a valid OAuth access token, refreshing it if it is expired or about to be.
 * The refresh token is read from the OS keychain first, falling back to config.
 */
export async function requireOAuth(what = "This command"): Promise<Session> {
  let config = loadConfig();
  const profile = currentProfile(config);
  const apiBase = resolveApiBase(config);
  const oauth = profile.oauth;

  if (!oauth?.accessToken) throw new NotAuthenticatedError(what);

  const stillFresh = oauth.expiresAt - REFRESH_SKEW_MS > Date.now();
  if (stillFresh) {
    return { apiBase, accessToken: oauth.accessToken, scopes: oauth.scope.split(/\s+/).filter(Boolean) };
  }

  // Expired → refresh. Keychain is authoritative; config is the fallback store.
  const refresh =
    (await getSecret(refreshAccount(config.currentProfile))) ?? oauth.refreshToken;
  if (!refresh) throw new NotAuthenticatedError(what);

  const next = await refreshToken(refresh, oauth.clientId);
  if (!next) {
    throw new NotAuthenticatedError(
      `${what} — your session expired and could not be renewed.`,
    );
  }

  await persistTokens(config, next);
  config = loadConfig();

  return {
    apiBase,
    accessToken: next.accessToken,
    scopes: next.scope.split(/\s+/).filter(Boolean),
  };
}

/**
 * Persist a token set: refresh token to the keychain when available (and NOT to the
 * config file in that case), access token + metadata to the config file.
 */
export async function persistTokens(
  config: Config,
  tokens: {
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
    scope: string;
    clientId: string;
  },
): Promise<"keychain" | "file"> {
  let backend: "keychain" | "file" = "file";

  if (tokens.refreshToken) {
    backend = await setSecret(refreshAccount(config.currentProfile), tokens.refreshToken);
  }

  const next = withProfile(config, {
    oauth: {
      accessToken: tokens.accessToken,
      // Only write the refresh token to disk if the keychain did NOT take it.
      ...(tokens.refreshToken && backend === "file"
        ? { refreshToken: tokens.refreshToken }
        : {}),
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
      clientId: tokens.clientId,
    },
  });
  saveConfig(next);
  return backend;
}

export interface ApiKeySession {
  readonly apiBase: string;
  readonly apiKey: string;
  /** "test" | "live", inferred from the mp_test_/mp_live_ prefix. */
  readonly mode: "test" | "live" | "unknown";
}

/** Get a merchant API key for a data-plane call (collect / status). */
export function requireApiKey(flag?: string): ApiKeySession {
  const config = loadConfig();
  const apiKey = resolveApiKey(config, flag);
  if (!apiKey) throw new NoApiKeyError();
  return {
    apiBase: resolveApiBase(config),
    apiKey,
    mode: apiKey.startsWith("mp_live_")
      ? "live"
      : apiKey.startsWith("mp_test_")
        ? "test"
        : "unknown",
  };
}
