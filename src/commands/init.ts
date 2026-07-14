/**
 * `paylod init` — the guided path from "npx @paylod/cli" to a working STK push.
 *
 * It is deliberately a thin ORCHESTRATOR over the other commands rather than a
 * fourth implementation of login/apps/creds: it checks what you already have and
 * only asks for what is missing, then tells you the one command to run next.
 */

import { Command } from "commander";
import * as p from "@clack/prompts";
import { loadConfig, saveConfig, currentProfile, withProfile, resolveApiBase } from "../lib/config.js";
import { startLogin, openBrowser } from "../lib/oauth.js";
import { persistTokens, requireOAuth } from "../lib/session.js";
import { oauthRequest, type AppsResponse } from "../lib/client.js";
import { color as c, isJson, line, spinner, rule } from "../lib/ui.js";
import { PaylodError } from "../lib/errors.js";

export function initCommand(): Command {
  return new Command("init")
    .description("Set up paylod in this terminal — login, pick an app, mint a key")
    .action(async () => {
      if (isJson()) {
        throw new PaylodError("`paylod init` is interactive and has no --json form.", {
          hint: "Script it with `paylod login`, `paylod apps use` and `paylod keys mint`.",
          exitCode: 2,
        });
      }

      line();
      rule("paylod init");
      line();

      // 1. Login, unless already logged in.
      let session;
      try {
        session = await requireOAuth();
        line(`  ${c.green("✔")} Already signed in.`);
      } catch {
        const handle = await startLogin();
        line(`  ${c.dim("Opening")} ${c.cyan(handle.authorizeUrl)}`);
        line();
        openBrowser(handle.authorizeUrl);

        const spin = spinner("Waiting for you to approve access…");
        const tokens = await handle.result.catch((e) => {
          spin.error("Login failed.");
          throw e;
        });
        spin.succeed("Signed in.");
        await persistTokens(loadConfig(), tokens);
        session = await requireOAuth();
      }

      // 2. Pick an application.
      const spin = spinner("Loading your applications…");
      const apps = await oauthRequest<AppsResponse>(
        session.apiBase,
        session.accessToken,
        "GET",
        "/apps",
      ).catch((e) => {
        spin.error("Could not load applications.");
        throw e;
      });
      spin.stop();

      let applicationId = currentProfile(loadConfig()).applicationId;

      if (apps.applications.length === 0) {
        line();
        line(`  ${c.yellow("!")} You have no applications yet.`);
        line(`  ${c.dim("Create one with:")} ${c.cyan('paylod apps create --name "My Shop"')}`);
        line();
        return;
      }

      if (apps.applications.length === 1) {
        applicationId = apps.applications[0]!.applicationId;
        line(`  ${c.green("✔")} Using ${c.bold(apps.applications[0]!.name)}.`);
      } else if (!applicationId) {
        const chosen = await p.select({
          message: "Which application?",
          options: apps.applications.map((a) => ({
            value: a.applicationId,
            label: a.name,
            hint: a.applicationId,
          })),
        });
        if (p.isCancel(chosen)) throw new PaylodError("Cancelled.", { exitCode: 130 });
        applicationId = String(chosen);
      } else {
        line(`  ${c.green("✔")} Using your default application.`);
      }

      saveConfig(withProfile(loadConfig(), { applicationId }));

      // 3. Mint a sandbox key if we have none, so `collect` works immediately.
      const profile = currentProfile(loadConfig());
      if (!profile.apiKey) {
        const spin2 = spinner("Minting a sandbox API key…");
        try {
          const res = await oauthRequest<{ apiKey?: string }>(
            session.apiBase,
            session.accessToken,
            "POST",
            "/mint-key",
            { body: { applicationId, env: "sandbox", name: "paylod CLI" } },
          );
          if (res.apiKey) {
            saveConfig(withProfile(loadConfig(), { apiKey: res.apiKey, env: "sandbox" }));
            spin2.succeed("Sandbox API key minted and saved.");
          } else {
            spin2.stop();
          }
        } catch {
          spin2.error("Could not mint a key — do it later with `paylod keys mint`.");
        }
      } else {
        line(`  ${c.green("✔")} API key already set.`);
      }

      line();
      rule("you're ready");
      line();
      line(`  ${c.dim("Test with no Daraja creds at all:")}`);
      line(`    ${c.cyan("paylod simulate --interactive")}`);
      line();
      line(`  ${c.dim("Or fire a real STK push:")}`);
      line(`    ${c.cyan("paylod collect --phone 2547… --amount 1")}`);
      line();
      line(`  ${c.dim("Forward webhooks to localhost:")}`);
      line(`    ${c.cyan("paylod listen --forward http://localhost:3000/webhook")}`);
      line();
    });
}
