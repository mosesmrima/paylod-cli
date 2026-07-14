/**
 * `paylod apps list|use|create` — the management plane (OAuth).
 *
 * `apps use` is what makes every other command short: it pins a default
 * applicationId into the profile so you never have to type --app again.
 */

import { Command, Option } from "commander";
import * as p from "@clack/prompts";
import { loadConfig, saveConfig, currentProfile, withProfile } from "../lib/config.js";
import { requireOAuth } from "../lib/session.js";
import { oauthRequest, type AppsResponse } from "../lib/client.js";
import { color as c, emit, isJson, kv, line, ok, spinner, rule, warn } from "../lib/ui.js";
import { PaylodError } from "../lib/errors.js";

export function appsCommand(): Command {
  const apps = new Command("apps").description("Manage your paylod applications");

  apps
    .command("list")
    .alias("ls")
    .description("List the applications you can access")
    .action(async () => {
      const session = await requireOAuth("`paylod apps list`");
      const spin = spinner("Loading applications…");
      let res: AppsResponse;
      try {
        res = await oauthRequest<AppsResponse>(session.apiBase, session.accessToken, "GET", "/apps");
      } catch (e) {
        spin.error("Could not load applications.");
        throw e;
      }
      spin.stop();

      if (isJson()) {
        emit({ ok: true, applications: res.applications });
        return;
      }

      const current = currentProfile(loadConfig()).applicationId;

      line();
      rule(`applications (${res.applications.length})`);
      line();
      if (res.applications.length === 0) {
        warn("You have no applications yet.");
        line(c.dim("  Create one with: paylod apps create --name \"My Shop\""));
        line();
        return;
      }
      for (const app of res.applications) {
        const active = app.applicationId === current;
        line(
          `  ${active ? c.green("●") : c.dim("○")} ${c.bold(app.name)} ${c.dim(app.provider)}`,
        );
        line(`    ${c.dim(app.applicationId)}${active ? ` ${c.green("(default)")}` : ""}`);
      }
      line();
      line(c.dim("  Set a default with: paylod apps use <applicationId>"));
      line();
    });

  apps
    .command("use")
    .description("Set the default application for this profile")
    .argument("<applicationId>")
    .action((applicationId: string) => {
      const config = loadConfig();
      saveConfig(withProfile(config, { applicationId }));
      if (isJson()) {
        emit({ ok: true, applicationId });
        return;
      }
      ok(`Default application set to ${c.dim(applicationId)}.`);
    });

  apps
    .command("create")
    .description("Create an application (bootstraps an organization if you have none)")
    .requiredOption("--name <name>", "application name")
    .option("--org <organizationId>", "organization to create it in (see `paylod orgs list`)")
    .option("--org-name <name>", "name for the org, when bootstrapping your very first app")
    // `product` is the SHORTCODE KIND (paybill vs till) — it drives tx_type. It is NOT the
    // Daraja API family; the backend enum really is paybill|till.
    .addOption(
      new Option("--product <product>", "shortcode kind")
        .choices(["paybill", "till"])
        .default("paybill"),
    )
    .addOption(
      new Option("--env <env>", "environment to provision")
        .choices(["sandbox", "production"])
        .default("sandbox"),
    )
    .action(async (opts: CreateOpts) => {
      const session = await requireOAuth("`paylod apps create`");

      const spin = spinner("Creating your application…");
      let res: ProvisionResponse;
      try {
        res = await createApp(session.apiBase, session.accessToken, opts);
      } catch (e) {
        spin.error("Could not create the application.");
        throw e;
      }
      spin.succeed("Application created.");

      if (!res.applicationId) {
        throw new PaylodError("paylod did not return an applicationId.", { body: res });
      }

      // Adopt it as the default, and keep the API key it handed us (shown once).
      const config = loadConfig();
      saveConfig(
        withProfile(config, {
          applicationId: res.applicationId,
          env: opts.env,
          ...(res.apiKey ? { apiKey: res.apiKey } : {}),
        }),
      );

      if (isJson()) {
        emit({ ok: true, ...res });
        return;
      }

      line();
      kv([
        ["application", c.bold(res.applicationId)],
        ...(res.organizationId ? [["organization", c.dim(res.organizationId)] as const] : []),
        ["env", opts.env],
        ...(res.apiKey ? [["api key", `${c.green(res.apiKey)} ${c.dim("(shown once — saved to your profile)")}`] as const] : []),
        ...(res.callbackUrl ? [["callback", c.dim(res.callbackUrl)] as const] : []),
      ]);
      line();
      line(`  ${c.dim("Next:")} ${c.cyan("paylod creds set")} ${c.dim("— paste your Daraja keys")}`);
      line();
    });

  // Backed by the NEW routes on `/applications` (this work). The dashboard renamed and
  // deleted apps with direct RLS UPDATE/DELETE — not reachable from an OAuth token.
  apps
    .command("rename")
    .description("Rename an application")
    .argument("<applicationId>")
    .requiredOption("--name <name>", "the new name")
    .action(async (applicationId: string, opts: { name: string }) => {
      const session = await requireOAuth("`paylod apps rename`");

      const spin = spinner("Renaming…");
      let res: { applicationId: string; name: string };
      try {
        res = await oauthRequest(
          session.apiBase,
          session.accessToken,
          "PATCH",
          `/applications/${encodeURIComponent(applicationId)}`,
          { body: { name: opts.name } },
        );
      } catch (e) {
        spin.error("Could not rename the application.");
        throw e;
      }
      spin.stop();

      if (isJson()) {
        emit({ ok: true, ...res });
        return;
      }
      ok(`Renamed to ${c.bold(res.name)}.`);
    });

  apps
    .command("delete")
    .alias("rm")
    .description("Delete an application (cascades keys, credentials and webhooks)")
    .argument("<applicationId>")
    .option("-y, --yes", "skip the confirmation prompt")
    .action(async (applicationId: string, opts: { yes?: boolean }) => {
      const session = await requireOAuth("`paylod apps delete`");

      // Destructive + cascading. Make the user type the id back unless they pass -y.
      if (!opts.yes) {
        if (!process.stdin.isTTY || isJson()) {
          throw new PaylodError("Refusing to delete without confirmation.", {
            hint: "Re-run with --yes to confirm in a non-interactive context.",
            exitCode: 2,
          });
        }
        warn("This deletes the app AND cascades its credentials, API keys and webhooks.");
        const answer = await p.text({
          message: `Type the application id to confirm:`,
          placeholder: applicationId,
          validate: (v) =>
            v?.trim() === applicationId ? undefined : "That does not match — nothing was deleted.",
        });
        if (p.isCancel(answer)) throw new PaylodError("Cancelled.", { exitCode: 130 });
      }

      const spin = spinner("Deleting application…");
      let res: { deleted: boolean; applicationId: string };
      try {
        res = await oauthRequest(
          session.apiBase,
          session.accessToken,
          "DELETE",
          `/applications/${encodeURIComponent(applicationId)}`,
        );
      } catch (e) {
        spin.error("Could not delete the application.");
        throw e;
      }
      spin.stop();

      // Drop it from the profile if it was the default, so later commands don't 404.
      const config = loadConfig();
      if (currentProfile(config).applicationId === applicationId) {
        saveConfig(withProfile(config, { applicationId: undefined }));
      }

      if (isJson()) {
        emit({ ok: true, ...res });
        return;
      }
      ok("Application deleted.");
    });

  return apps;
}

interface CreateOpts {
  name: string;
  /** Organization ID to create the app in. */
  org?: string;
  /** Organization NAME, used only on the /provision bootstrap path. */
  orgName?: string;
  product: "paybill" | "till";
  env: "sandbox" | "production";
}

interface ProvisionResponse {
  organizationId?: string;
  applicationId?: string;
  name?: string;
  env?: string;
  collectEndpoint?: string;
  callbackUrl?: string;
  callbackToken?: string;
  apiKey?: string;
}

/**
 * Create an application, choosing the right endpoint for the caller's situation.
 *
 * There are TWO create paths on the backend and picking the wrong one is a hard failure:
 *
 *   POST /provision     BOOTSTRAPS org + first app. It 409s "already onboarded" for any
 *                       user who already owns an organization. Correct ONLY for a brand-new
 *                       account.
 *   POST /applications  Creates an app in an EXISTING org. 403s "no organization" for a
 *                       user who has none. Correct for everyone else.
 *
 * So: try /applications first (the common case — most people already have an org), and fall
 * back to /provision only on the specific "no organization" 403 that means "you are new".
 * Trying /provision first would 409 for every existing user, which is precisely the bug that
 * made the MCP server's `create_app` unusable.
 */
async function createApp(
  apiBase: string,
  token: string,
  opts: CreateOpts,
): Promise<ProvisionResponse> {
  try {
    return await oauthRequest<ProvisionResponse>(apiBase, token, "POST", "/applications", {
      body: {
        name: opts.name,
        ...(opts.org ? { organizationId: opts.org } : {}),
        product: opts.product,
        env: opts.env,
      },
    });
  } catch (e) {
    const isBrandNewUser =
      e instanceof PaylodError &&
      e.status === 403 &&
      /no organization/i.test(e.message);
    if (!isBrandNewUser) throw e;

    // First-ever app: bootstrap the org too.
    return await oauthRequest<ProvisionResponse>(apiBase, token, "POST", "/provision", {
      body: {
        organizationName: opts.orgName ?? opts.name,
        applicationName: opts.name,
        product: opts.product,
        env: opts.env,
      },
    });
  }
}
