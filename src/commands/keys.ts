/**
 * `paylod keys mint|use` — merchant API keys (the data plane credential).
 *
 * A minted key is shown ONCE by the backend. We save it into the profile so
 * `paylod collect` works immediately afterwards, and we never print a live key
 * without saying so loudly.
 */

import { Command, Option } from "commander";
import { loadConfig, saveConfig, currentProfile, withProfile } from "../lib/config.js";
import { requireOAuth } from "../lib/session.js";
import { oauthRequest, type ApiKeyRow } from "../lib/client.js";
import { color as c, emit, isJson, kv, line, ok, spinner, warn, rule } from "../lib/ui.js";
import { PaylodError } from "../lib/errors.js";

interface MintResponse {
  apiKey?: string;
  prefix?: string;
  env?: string;
}

interface ListKeysOpts {
  app?: string;
  env?: "sandbox" | "production";
  includeRevoked?: boolean;
}

export function keysCommand(): Command {
  const keys = new Command("keys").description("Manage paylod API keys");

  keys
    .command("mint")
    .description("Mint a new merchant API key")
    .addOption(
      new Option("--env <env>", "environment for the key")
        .choices(["sandbox", "production"])
        .default("sandbox"),
    )
    .option("--name <name>", "human label for the key")
    .option("--app <applicationId>", "application to mint on")
    .option("--no-save", "print the key but do not save it to your profile")
    .action(async (opts: MintOpts) => {
      const session = await requireOAuth("`paylod keys mint`");
      const config = loadConfig();
      const applicationId = opts.app ?? currentProfile(config).applicationId;

      if (!applicationId) {
        throw new PaylodError("No application selected.", {
          hint: "Pass --app <applicationId>, or run `paylod apps use <id>`.",
          exitCode: 2,
        });
      }

      const spin = spinner("Minting API key…");
      let res: MintResponse;
      try {
        res = await oauthRequest<MintResponse>(session.apiBase, session.accessToken, "POST", "/mint-key", {
          body: {
            applicationId,
            env: opts.env,
            ...(opts.name ? { name: opts.name } : {}),
          },
        });
      } catch (e) {
        spin.error("Could not mint the key.");
        throw e;
      }
      spin.succeed("API key minted.");

      if (!res.apiKey) throw new PaylodError("paylod did not return an API key.", { body: res });

      if (opts.save !== false) {
        saveConfig(withProfile(loadConfig(), { apiKey: res.apiKey, env: opts.env }));
      }

      if (isJson()) {
        emit({ ok: true, ...res, saved: opts.save !== false });
        return;
      }

      line();
      rule("api key");
      line();
      kv([
        ["key", c.bold(opts.env === "production" ? c.red(res.apiKey) : c.green(res.apiKey))],
        ["env", opts.env],
        ...(opts.save !== false ? [["saved to", c.dim("your paylod profile")] as const] : []),
      ]);
      line();
      warn("This key is shown ONCE. Store it somewhere safe.");
      if (opts.env === "production") {
        warn(c.red("This is a LIVE key — it moves real money."));
      }
      line();
    });

  // Backed by the NEW `/api-keys` edge function (this work). The dashboard listed keys by
  // reading the table under RLS and revoked by UPDATEing `revoked_at` — neither reachable
  // with an OAuth token, so "I leaked a key, kill it" had no headless answer at all.
  keys
    .command("list")
    .alias("ls")
    .description("List this application's API keys")
    .option("--app <applicationId>")
    .addOption(new Option("--env <env>", "environment").choices(["sandbox", "production"]))
    .option("--include-revoked", "also show revoked keys")
    .action(async (opts: ListKeysOpts) => {
      const session = await requireOAuth("`paylod keys list`");
      const applicationId = opts.app ?? currentProfile(loadConfig()).applicationId;
      if (!applicationId) {
        throw new PaylodError("No application selected.", {
          hint: "Pass --app <applicationId>, or run `paylod apps use <id>`.",
          exitCode: 2,
        });
      }

      const spin = spinner("Loading API keys…");
      let res: { keys: readonly ApiKeyRow[] };
      try {
        res = await oauthRequest(session.apiBase, session.accessToken, "GET", "/api-keys", {
          query: {
            applicationId,
            ...(opts.env ? { env: opts.env } : {}),
            ...(opts.includeRevoked ? { includeRevoked: "true" } : {}),
          },
        });
      } catch (e) {
        spin.error("Could not load API keys.");
        throw e;
      }
      spin.stop();

      if (isJson()) {
        emit({ ok: true, keys: res.keys });
        return;
      }

      line();
      rule(`api keys (${res.keys.length})`);
      line();

      if (res.keys.length === 0) {
        warn("No API keys yet.");
        line(c.dim("  Mint one with: paylod keys mint"));
        line();
        return;
      }

      for (const k of res.keys) {
        const live = k.env === "production";
        const dead = Boolean(k.revokedAt);
        const dot = dead ? c.dim("○") : live ? c.red("●") : c.green("●");
        line(
          `  ${dot} ${c.bold(`${k.prefix}…`)} ${live ? c.red("live") : c.dim("test")}` +
            `${dead ? ` ${c.dim("(revoked)")}` : ""}`,
        );
        kv([
          ["id", c.dim(k.id)],
          ...(k.name ? [["name", k.name] as const] : []),
          [
            "last used",
            k.lastUsedAt ? c.dim(new Date(k.lastUsedAt).toLocaleString()) : c.dim("never"),
          ],
        ]);
        line();
      }
      line(c.dim("  Revoke one with: paylod keys revoke <id>"));
      line();
    });

  keys
    .command("revoke")
    .description("Revoke an API key immediately")
    .argument("<apiKeyId>", "the key's id (see `paylod keys list`)")
    .action(async (apiKeyId: string) => {
      const session = await requireOAuth("`paylod keys revoke`");

      const spin = spinner("Revoking key…");
      let res: { revoked: boolean; prefix?: string; alreadyRevoked?: boolean };
      try {
        res = await oauthRequest(
          session.apiBase,
          session.accessToken,
          "POST",
          `/api-keys/${encodeURIComponent(apiKeyId)}/revoke`,
        );
      } catch (e) {
        spin.error("Could not revoke the key.");
        throw e;
      }
      spin.stop();

      if (isJson()) {
        emit({ ok: true, ...res });
        return;
      }
      ok(
        res.alreadyRevoked
          ? `Key ${c.bold(`${res.prefix}…`)} was already revoked.`
          : `Key ${c.bold(`${res.prefix}…`)} revoked. It will be rejected immediately.`,
      );
    });

  keys
    .command("use")
    .description("Store an existing API key in your profile")
    .argument("<apiKey>", "an mp_test_… or mp_live_… key")
    .action((apiKey: string) => {
      if (!/^mp_(test|live)_/.test(apiKey)) {
        throw new PaylodError("That does not look like a paylod API key.", {
          hint: "Keys start with mp_test_ or mp_live_.",
          exitCode: 2,
        });
      }
      saveConfig(withProfile(loadConfig(), { apiKey }));
      if (isJson()) {
        emit({ ok: true, mode: apiKey.startsWith("mp_live_") ? "live" : "test" });
        return;
      }
      ok("API key saved to your profile.");
    });

  return keys;
}

interface MintOpts {
  env: "sandbox" | "production";
  name?: string;
  app?: string;
  save?: boolean;
}
