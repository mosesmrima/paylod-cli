/**
 * OS keychain storage for the OAuth refresh token, with an EXPLICIT file fallback.
 *
 * `@napi-rs/keyring` is a NATIVE module and is declared in `optionalDependencies` on
 * purpose: `npx @paylod/cli` must never fail to install because a prebuilt binary is
 * missing for someone's platform. So a fallback to the config file is unavoidable.
 *
 * What IS avoidable — and what 0.1.0 got wrong — is falling back SILENTLY. A refresh
 * token in the macOS Keychain and a refresh token in a file are not the same security
 * posture, and the user is the only one who can decide whether the difference matters.
 * Every function here therefore reports WHY it fell back, and the caller surfaces it.
 *
 * Only the REFRESH token goes to the keychain. The access token is short-lived and stays
 * in the config file — keychain round-trips on every command would be slow and, on Linux,
 * can pop a gnome-keyring unlock prompt mid-pipeline.
 */

const SERVICE = "paylod-cli";

export type SecretBackend = "keychain" | "file";

/** Why the keychain is not being used. `undefined` when it IS being used. */
export type FallbackReason =
  | "disabled by PAYLOD_NO_KEYCHAIN=1"
  | "the @napi-rs/keyring native module is not installed for this platform"
  | "no OS keyring is available (on Linux this means no unlocked D-Bus Secret Service)";

export interface KeychainStatus {
  readonly available: boolean;
  readonly reason?: FallbackReason;
}

export interface StoreResult {
  readonly backend: SecretBackend;
  /** Set whenever `backend` is "file" — i.e. the secret is NOT in the OS keychain. */
  readonly reason?: FallbackReason;
}

interface EntryLike {
  getPassword(): string;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

type KeyringModule = { Entry: new (service: string, account: string) => EntryLike };

let cached: { mod: KeyringModule | null; reason?: FallbackReason } | undefined;

/** Reset the module-load memo. Tests only. */
export function resetKeychainCache(): void {
  cached = undefined;
}

/**
 * Load @napi-rs/keyring once, remembering WHY it failed if it did.
 *
 * Note the two distinct failure modes, which the user needs told apart:
 *   • the module is absent (no prebuilt binary for their platform) — a packaging fact;
 *   • the module loaded but there is no usable keyring (headless Linux, locked keychain)
 *     — an environment fact they can often fix.
 */
async function keyring(): Promise<{ mod: KeyringModule | null; reason?: FallbackReason }> {
  if (cached !== undefined) return cached;

  if (process.env.PAYLOD_NO_KEYCHAIN === "1") {
    cached = { mod: null, reason: "disabled by PAYLOD_NO_KEYCHAIN=1" };
    return cached;
  }

  try {
    const mod = (await import("@napi-rs/keyring")) as unknown as KeyringModule;
    cached = mod?.Entry
      ? { mod }
      : {
          mod: null,
          reason: "the @napi-rs/keyring native module is not installed for this platform",
        };
  } catch {
    cached = {
      mod: null,
      reason: "the @napi-rs/keyring native module is not installed for this platform",
    };
  }
  return cached;
}

/**
 * Store a secret. Returns the backend actually used AND, when it fell back, why — so the
 * caller can persist to the file store instead and tell the user what just happened.
 */
export async function setSecret(account: string, secret: string): Promise<StoreResult> {
  const { mod, reason } = await keyring();
  if (!mod) {
    return {
      backend: "file",
      reason: reason ?? "the @napi-rs/keyring native module is not installed for this platform",
    };
  }
  try {
    new mod.Entry(SERVICE, account).setPassword(secret);
    return { backend: "keychain" };
  } catch {
    // Headless Linux with no unlocked keyring throws here. Fall back, don't crash — but
    // do not pretend it went to the keychain.
    return {
      backend: "file",
      reason: "no OS keyring is available (on Linux this means no unlocked D-Bus Secret Service)",
    };
  }
}

/** Read a secret from the keychain. Returns undefined if absent or unavailable. */
export async function getSecret(account: string): Promise<string | undefined> {
  const { mod } = await keyring();
  if (!mod) return undefined;
  try {
    const value = new mod.Entry(SERVICE, account).getPassword();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort delete. Never throws — logout must always succeed. */
export async function deleteSecret(account: string): Promise<void> {
  const { mod } = await keyring();
  if (!mod) return;
  try {
    new mod.Entry(SERVICE, account).deletePassword();
  } catch {
    /* already gone, or no keyring — nothing to do */
  }
}

/** Whether the keychain WOULD be used, and if not, why. For `whoami` / `login`. */
export async function keychainStatus(): Promise<KeychainStatus> {
  const { mod, reason } = await keyring();
  return mod ? { available: true } : { available: false, reason };
}

/** Back-compat convenience for display code that only needs the backend name. */
export async function activeBackend(): Promise<SecretBackend> {
  return (await keychainStatus()).available ? "keychain" : "file";
}
