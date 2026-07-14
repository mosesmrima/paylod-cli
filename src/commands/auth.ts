/**
 * `paylod login` / `logout` / `whoami`.
 *
 * login  — OAuth 2.1 authorization-code + PKCE over a loopback redirect (RFC 8252).
 *          Opens the browser, waits for the consent screen, stores the refresh token
 *          in the OS keychain when one is available (else a 0600 file) and reports
 *          which of the two it used. No secret is ever printed.
 * whoami — shows the active profile, granted scopes, and WHERE the token lives.
 * logout — revokes nothing server-side (the AS has /revoke; wired below) and wipes
 *          local credentials from both the keychain and the config file.
 */

import { Command } from "commander";
import {
  loadConfig,
  saveConfig,
  currentProfile,
  withoutProfileKeys,
  resolveApiBase,
  ALL_SCOPES,
  AS_ISSUER,
  configPath,
} from "../lib/config.js";
import { startLogin, openBrowser } from "../lib/oauth.js";
import { persistTokens, refreshAccount, requireOAuth } from "../lib/session.js";
import { deleteSecret, getSecret, activeBackend } from "../lib/keychain.js";
import { oauthRequest, type AppsResponse } from "../lib/client.js";
import { color as c, emit, isJson, kv, line, ok, spinner, info, rule } from "../lib/ui.js";

export function loginCommand(): Command {
  return new Command("login")
    .description("Sign in to paylod (opens your browser)")
    .option("--no-browser", "print the URL instead of opening a browser")
    .option(
      "--scope <scopes...>",
      "request a subset of scopes (default: all)",
    )
    .action(async (opts: { browser?: boolean; scope?: string[] }) => {
      const scopes = opts.scope?.length ? opts.scope : [...ALL_SCOPES];

      const handle = await startLogin(scopes);

      if (!isJson()) {
        line();
        line(`  ${c.bold("Sign in to paylod")}`);
        line();
        line(`  ${c.dim("Opening")} ${c.cyan(handle.authorizeUrl)}`);
        line();
      }

      if (opts.browser !== false) openBrowser(handle.authorizeUrl);

      const spin = spinner("Waiting for you to approve access in the browser…");

      let tokens;
      try {
        tokens = await handle.result;
      } catch (e) {
        spin.error("Login failed.");
        throw e;
      }
      spin.succeed("Approved.");

      const config = loadConfig();
      const backend = await persistTokens(config, tokens);

      // Best-effort: pick a sensible default app so `collect`/`simulate` "just work".
      let defaultApp: string | undefined;
      try {
        const apps = await oauthRequest<AppsResponse>(
          resolveApiBase(config),
          tokens.accessToken,
          "GET",
          "/apps",
        );
        if (apps.applications.length === 1) {
          defaultApp = apps.applications[0]?.applicationId;
        }
      } catch {
        /* non-fatal — the user can set one with `paylod apps use` */
      }

      if (defaultApp) {
        const fresh = loadConfig();
        saveConfig({
          ...fresh,
          profiles: {
            ...fresh.profiles,
            [fresh.currentProfile]: {
              ...(fresh.profiles[fresh.currentProfile] ?? {}),
              applicationId: defaultApp,
            },
          },
        });
      }

      if (isJson()) {
        emit({
          ok: true,
          scopes: tokens.scope.split(/\s+/).filter(Boolean),
          storage: backend,
          ...(defaultApp ? { applicationId: defaultApp } : {}),
        });
        return;
      }

      line();
      ok(`Logged in to ${c.bold("paylod")}.`);
      line();
      kv([
        ["scopes", tokens.scope.split(/\s+/).filter(Boolean).join(", ") || "—"],
        [
          "token stored in",
          backend === "keychain"
            ? `${c.green("OS keychain")}`
            : `${c.yellow("file")} ${c.dim(`${configPath()} (0600)`)}`,
        ],
        ...(defaultApp ? [["default app", c.dim(defaultApp)] as const] : []),
      ]);
      line();
      line(`  ${c.dim("Next:")} ${c.cyan("paylod collect --phone 2547… --amount 10")}`);
      line();
    });
}

export function logoutCommand(): Command {
  return new Command("logout")
    .description("Sign out and remove stored credentials")
    .option("--all", "also forget the stored API key and default app")
    .action(async (opts: { all?: boolean }) => {
      const config = loadConfig();
      const profile = currentProfile(config);

      // Best-effort server-side revocation of the refresh token.
      const refresh =
        (await getSecret(refreshAccount(config.currentProfile))) ?? profile.oauth?.refreshToken;
      if (refresh && profile.oauth?.clientId) {
        try {
          await fetch(`${AS_ISSUER}/revoke`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token: refresh,
              token_type_hint: "refresh_token",
              client_id: profile.oauth.clientId,
            }).toString(),
          });
        } catch {
          /* offline logout must still clear local state */
        }
      }

      await deleteSecret(refreshAccount(config.currentProfile));

      const keys = opts.all
        ? (["oauth", "apiKey", "applicationId", "webhookSecret"] as const)
        : (["oauth"] as const);
      saveConfig(withoutProfileKeys(config, keys));

      if (isJson()) {
        emit({ ok: true, clearedAll: Boolean(opts.all) });
        return;
      }
      ok(opts.all ? "Signed out and cleared all local paylod credentials." : "Signed out.");
    });
}

export function whoamiCommand(): Command {
  return new Command("whoami")
    .description("Show who you are signed in as, and where your token is stored")
    .action(async () => {
      const session = await requireOAuth("`paylod whoami`");
      const config = loadConfig();
      const profile = currentProfile(config);
      const backend = await activeBackend();

      const spin = spinner("Checking your session…");
      let apps: AppsResponse;
      try {
        apps = await oauthRequest<AppsResponse>(
          session.apiBase,
          session.accessToken,
          "GET",
          "/apps",
        );
      } catch (e) {
        spin.error("Could not reach paylod.");
        throw e;
      }
      spin.stop();

      const org = apps.applications[0]?.organizationId;

      if (isJson()) {
        emit({
          ok: true,
          profile: config.currentProfile,
          apiBase: session.apiBase,
          scopes: session.scopes,
          storage: backend,
          organizationId: org ?? null,
          applications: apps.applications.length,
          defaultApplicationId: profile.applicationId ?? null,
          hasApiKey: Boolean(profile.apiKey),
        });
        return;
      }

      line();
      rule("paylod");
      line();
      kv([
        ["profile", c.bold(config.currentProfile)],
        ["api", c.dim(session.apiBase)],
        ...(org ? [["organization", c.dim(org)] as const] : []),
        ["applications", String(apps.applications.length)],
        ...(profile.applicationId
          ? [["default app", c.dim(profile.applicationId)] as const]
          : []),
        [
          "api key",
          profile.apiKey
            ? `${c.green("set")} ${c.dim(mask(profile.apiKey))}`
            : c.dim("none — run `paylod keys mint`"),
        ],
        [
          "token in",
          backend === "keychain" ? c.green("OS keychain") : `${c.yellow("file")} ${c.dim("(0600)")}`,
        ],
        ["scopes", session.scopes.join(", ") || "—"],
      ]);
      line();
    });
}

/** Show enough of a key to identify it, never enough to use it. */
function mask(key: string): string {
  if (key.length <= 12) return "****";
  return `${key.slice(0, 11)}…${key.slice(-4)}`;
}
