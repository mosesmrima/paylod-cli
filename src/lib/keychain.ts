/**
 * OS keychain storage for the OAuth refresh token, with a safe file fallback.
 *
 * `@napi-rs/keyring` is a NATIVE module and is declared in `optionalDependencies`
 * on purpose: `npx @paylod/cli` must never fail to install because a prebuilt binary is
 * missing for someone's platform. If the import fails for ANY reason we silently
 * fall back to the 0600 config file, which is what gh/vercel/wrangler effectively
 * do anyway. Storage location is reported by `paylod whoami` so the user always
 * knows where their refresh token actually lives.
 *
 * Only the REFRESH token goes to the keychain. The access token is short-lived and
 * stays in the config file — keychain round-trips on every command would be slow
 * and, on Linux, can pop a gnome-keyring unlock prompt mid-pipeline.
 */

const SERVICE = "paylod-cli";

export type SecretBackend = "keychain" | "file";

interface EntryLike {
  getPassword(): string;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

type KeyringModule = { Entry: new (service: string, account: string) => EntryLike };

let cached: KeyringModule | null | undefined;

/**
 * Load @napi-rs/keyring once. Returns null when unavailable (not installed, no
 * prebuilt binary, or no D-Bus secret service on a headless Linux box).
 */
async function keyring(): Promise<KeyringModule | null> {
  if (cached !== undefined) return cached;
  if (process.env.PAYLOD_NO_KEYCHAIN === "1") {
    cached = null;
    return cached;
  }
  try {
    const mod = (await import("@napi-rs/keyring")) as unknown as KeyringModule;
    cached = mod?.Entry ? mod : null;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * Store a secret. Returns the backend actually used so the caller can decide
 * whether it ALSO needs to persist to the config file.
 */
export async function setSecret(account: string, secret: string): Promise<SecretBackend> {
  const kr = await keyring();
  if (!kr) return "file";
  try {
    new kr.Entry(SERVICE, account).setPassword(secret);
    return "keychain";
  } catch {
    // Headless Linux with no unlocked keyring throws here. Fall back, don't crash.
    return "file";
  }
}

/** Read a secret from the keychain. Returns undefined if absent or unavailable. */
export async function getSecret(account: string): Promise<string | undefined> {
  const kr = await keyring();
  if (!kr) return undefined;
  try {
    const value = new kr.Entry(SERVICE, account).getPassword();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort delete. Never throws — logout must always succeed. */
export async function deleteSecret(account: string): Promise<void> {
  const kr = await keyring();
  if (!kr) return;
  try {
    new kr.Entry(SERVICE, account).deletePassword();
  } catch {
    /* already gone, or no keyring — nothing to do */
  }
}

/** Which backend WOULD be used, for display in `whoami` / `login`. */
export async function activeBackend(): Promise<SecretBackend> {
  return (await keyring()) ? "keychain" : "file";
}
