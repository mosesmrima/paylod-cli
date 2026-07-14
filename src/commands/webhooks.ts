/**
 * `paylod webhooks list|add|secret` — manage where paylod POSTs your events.
 *
 * `webhooks secret` (re)rolls the HMAC signing secret and caches it locally so
 * `paylod listen` can verify signatures. The secret is returned exactly once by the
 * backend, which is why we cache it rather than re-fetching.
 */

import { Command } from "commander";
import * as p from "@clack/prompts";
import { loadConfig, saveConfig, currentProfile, withProfile } from "../lib/config.js";
import { requireOAuth } from "../lib/session.js";
import { oauthRequest, endpointId, type WebhookEndpoint } from "../lib/client.js";
import { color as c, emit, isJson, kv, line, ok, rule, spinner, warn } from "../lib/ui.js";
import { PaylodError } from "../lib/errors.js";

function appId(flag?: string): string {
  const id = flag ?? currentProfile(loadConfig()).applicationId;
  if (!id) {
    throw new PaylodError("No application selected.", {
      hint: "Pass --app <applicationId>, or run `paylod apps use <id>`.",
      exitCode: 2,
    });
  }
  return id;
}

export function webhooksCommand(): Command {
  const webhooks = new Command("webhooks").description("Manage webhook endpoints");

  webhooks
    .command("list")
    .alias("ls")
    .description("List your webhook endpoints")
    .option("--app <applicationId>")
    .action(async (opts: { app?: string }) => {
      const session = await requireOAuth("`paylod webhooks list`");
      const applicationId = appId(opts.app);

      const spin = spinner("Loading webhook endpoints…");
      let res: { endpoints?: readonly WebhookEndpoint[] };
      try {
        res = await oauthRequest(session.apiBase, session.accessToken, "GET", "/webhook-endpoints", {
          query: { applicationId },
        });
      } catch (e) {
        spin.error("Could not load webhook endpoints.");
        throw e;
      }
      spin.stop();

      const endpoints = res.endpoints ?? [];

      if (isJson()) {
        emit({ ok: true, endpoints });
        return;
      }

      line();
      rule(`webhook endpoints (${endpoints.length})`);
      line();
      if (endpoints.length === 0) {
        warn("No webhook endpoints configured.");
        line(c.dim("  Add one with: paylod webhooks add https://your.app/webhook"));
        line();
        return;
      }
      for (const e of endpoints) {
        line(`  ${e.active ? c.green("●") : c.dim("○")} ${c.bold(e.url)}`);
        kv([
          ["id", c.dim(endpointId(e))],
          ["active", e.active ? c.green("yes") : c.dim("no")],
          ["signing secret", e.hasSigningSecret ? c.green("set") : c.yellow("not set")],
        ]);
        line();
      }
    });

  webhooks
    .command("add")
    .description("Add a webhook endpoint")
    .argument("<url>", "https URL paylod should POST events to")
    .option("--app <applicationId>")
    .option("--secret", "also roll a signing secret and cache it locally")
    .action(async (url: string, opts: { app?: string; secret?: boolean }) => {
      const session = await requireOAuth("`paylod webhooks add`");
      const applicationId = appId(opts.app);

      if (!/^https:\/\//i.test(url)) {
        throw new PaylodError("Webhook URLs must be https.", {
          hint: "paylod refuses plaintext webhook targets. Use `paylod listen` for localhost.",
          exitCode: 2,
        });
      }

      const spin = spinner("Adding webhook endpoint…");
      let created: WebhookEndpoint;
      try {
        created = await oauthRequest<WebhookEndpoint>(
          session.apiBase,
          session.accessToken,
          "POST",
          "/webhook-endpoints",
          { body: { applicationId, url, active: true } },
        );
      } catch (e) {
        spin.error("Could not add the webhook endpoint.");
        throw e;
      }
      spin.succeed("Webhook endpoint added.");

      let signingSecret: string | undefined;
      if (opts.secret) {
        signingSecret = await rollSecret(
          session.apiBase,
          session.accessToken,
          applicationId,
          endpointId(created),
        );
      }

      if (isJson()) {
        emit({ ok: true, ...created, ...(signingSecret ? { signingSecret } : {}) });
        return;
      }

      line();
      kv([
        ["url", c.bold(created.url)],
        ["id", c.dim(endpointId(created))],
        ...(signingSecret
          ? [["signing secret", `${c.green(signingSecret)} ${c.dim("(shown once)")}`] as const]
          : []),
      ]);
      line();
    });

  // PATCH /webhook-endpoints/:id already existed; DELETE is NEW (this work).
  webhooks
    .command("toggle")
    .description("Enable or disable a webhook endpoint")
    .argument("<webhookEndpointId>")
    .option("--on", "activate")
    .option("--off", "deactivate")
    .action(async (id: string, opts: { on?: boolean; off?: boolean }) => {
      if (opts.on === opts.off) {
        throw new PaylodError("Pass exactly one of --on or --off.", { exitCode: 2 });
      }
      const session = await requireOAuth("`paylod webhooks toggle`");
      const active = Boolean(opts.on);

      const spin = spinner(active ? "Activating…" : "Deactivating…");
      let res: WebhookEndpoint;
      try {
        res = await oauthRequest<WebhookEndpoint>(
          session.apiBase,
          session.accessToken,
          "PATCH",
          `/webhook-endpoints/${encodeURIComponent(id)}`,
          { body: { active } },
        );
      } catch (e) {
        spin.error("Could not update the endpoint.");
        throw e;
      }
      spin.stop();

      if (isJson()) {
        emit({ ok: true, ...res });
        return;
      }
      ok(`Endpoint ${active ? c.green("activated") : c.yellow("deactivated")}.`);
    });

  webhooks
    .command("delete")
    .alias("rm")
    .description("Delete a webhook endpoint")
    .argument("<webhookEndpointId>")
    .option("-y, --yes", "skip the confirmation prompt")
    .action(async (id: string, opts: { yes?: boolean }) => {
      const session = await requireOAuth("`paylod webhooks delete`");

      if (!opts.yes && process.stdin.isTTY && !isJson()) {
        const confirmed = await p.confirm({
          message: "Delete this endpoint? Its delivery history goes with it.",
          initialValue: false,
        });
        if (p.isCancel(confirmed) || !confirmed) {
          throw new PaylodError("Cancelled.", { exitCode: 130 });
        }
      }

      const spin = spinner("Deleting endpoint…");
      try {
        await oauthRequest(
          session.apiBase,
          session.accessToken,
          "DELETE",
          `/webhook-endpoints/${encodeURIComponent(id)}`,
        );
      } catch (e) {
        spin.error("Could not delete the endpoint.");
        throw e;
      }
      spin.stop();

      if (isJson()) {
        emit({ ok: true, deleted: true, webhookEndpointId: id });
        return;
      }
      ok("Webhook endpoint deleted.");
    });

  webhooks
    .command("secret")
    .description("Roll the webhook signing secret (and cache it for `paylod listen`)")
    .option("--app <applicationId>")
    .option("--endpoint <webhookEndpointId>")
    .action(async (opts: { app?: string; endpoint?: string }) => {
      const session = await requireOAuth("`paylod webhooks secret`");
      const applicationId = appId(opts.app);

      const secret = await rollSecret(
        session.apiBase,
        session.accessToken,
        applicationId,
        opts.endpoint,
      );

      if (!secret) {
        throw new PaylodError("paylod did not return a signing secret.");
      }

      if (isJson()) {
        emit({ ok: true, signingSecret: secret });
        return;
      }

      line();
      kv([["signing secret", c.bold(secret)]]);
      line();
      ok("Cached locally — `paylod listen` will verify signatures with it.");
      warn("This secret is shown ONCE. Rolling it invalidates the previous one.");
      line();
    });

  return webhooks;
}

/**
 * POST /webhook-secret and cache the result into the profile.
 *
 * The backend takes `{ webhookEndpointId }` — REQUIRED, and it is the ONLY field it
 * accepts (it derives the application from the endpoint row). Passing `applicationId`
 * instead is a 422. When the caller has no endpoint id, resolve one first by listing
 * the app's endpoints — and refuse to guess when there is more than one, because
 * rolling the wrong endpoint's secret silently breaks a live integration.
 */
async function rollSecret(
  apiBase: string,
  token: string,
  applicationId: string,
  webhookEndpointId?: string,
): Promise<string | undefined> {
  const targetId =
    webhookEndpointId ?? (await resolveEndpointId(apiBase, token, applicationId));

  const spin = spinner("Rolling the signing secret…");
  try {
    const res = await oauthRequest<{ signingSecret?: string }>(
      apiBase,
      token,
      "POST",
      "/webhook-secret",
      { body: { webhookEndpointId: targetId } },
    );
    spin.succeed("Signing secret rolled.");
    if (res.signingSecret) {
      saveConfig(withProfile(loadConfig(), { webhookSecret: res.signingSecret }));
    }
    return res.signingSecret;
  } catch (e) {
    spin.error("Could not roll the signing secret.");
    throw e;
  }
}

/** Find the one endpoint to act on, or make the caller disambiguate. */
async function resolveEndpointId(
  apiBase: string,
  token: string,
  applicationId: string,
): Promise<string> {
  const res = await oauthRequest<{ endpoints?: readonly WebhookEndpoint[] }>(
    apiBase,
    token,
    "GET",
    "/webhook-endpoints",
    { query: { applicationId } },
  );
  const endpoints = res.endpoints ?? [];

  if (endpoints.length === 0) {
    throw new PaylodError("This application has no webhook endpoints.", {
      hint: "Add one first: paylod webhooks add https://your.app/webhook",
      exitCode: 2,
    });
  }
  if (endpoints.length > 1) {
    throw new PaylodError(
      `This application has ${endpoints.length} webhook endpoints — which one?`,
      {
        hint: "Pass --endpoint <webhookEndpointId>. See `paylod webhooks list`.",
        exitCode: 2,
      },
    );
  }
  return endpointId(endpoints[0]!);
}
