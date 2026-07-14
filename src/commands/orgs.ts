/**
 * `paylod orgs list|create|rename` — organizations.
 *
 * Backed by the NEW `/organizations` edge function (this work). The dashboard lists orgs
 * via the SECURITY DEFINER RPC `list_my_organizations` and renames with a direct RLS
 * UPDATE — neither reachable from an OAuth token.
 *
 * NOT IMPLEMENTED: `orgs switch`. The dashboard's switcher calls the RPC
 * `set_active_organization`, which re-mints the GoTrue JWT with a new `org_id` claim.
 * That is a SESSION concept and does not exist for OAuth tokens — paylod's OAuth plane is
 * deliberately org-per-action (the org is derived from the target application, never
 * carried in the token). So there is nothing to "switch": every command takes --app, and
 * `paylod apps use` pins the default. Documented rather than faked.
 */

import { Command } from "commander";
import { requireOAuth } from "../lib/session.js";
import { oauthRequest, type Organization } from "../lib/client.js";
import { color as c, emit, isJson, kv, line, ok, rule, spinner, warn } from "../lib/ui.js";

export function orgsCommand(): Command {
  const orgs = new Command("orgs")
    .alias("organizations")
    .description("Manage your organizations");

  orgs
    .command("list")
    .alias("ls")
    .description("List the organizations you belong to")
    .action(async () => {
      const session = await requireOAuth("`paylod orgs list`");

      const spin = spinner("Loading organizations…");
      let res: { organizations: readonly Organization[] };
      try {
        res = await oauthRequest(session.apiBase, session.accessToken, "GET", "/organizations");
      } catch (e) {
        spin.error("Could not load organizations.");
        throw e;
      }
      spin.stop();

      if (isJson()) {
        emit({ ok: true, organizations: res.organizations });
        return;
      }

      line();
      rule(`organizations (${res.organizations.length})`);
      line();

      if (res.organizations.length === 0) {
        warn("You do not belong to any organization yet.");
        line(c.dim('  Create one with: paylod orgs create --name "My Company"'));
        line();
        return;
      }

      for (const o of res.organizations) {
        line(`  ${c.bold(o.name)}  ${roleBadge(o.role)}`);
        line(`    ${c.dim(o.organizationId)}`);
      }
      line();
    });

  orgs
    .command("create")
    .description("Create a new organization (you become the owner)")
    .requiredOption("--name <name>", "organization name")
    .option("--billing-email <email>", "billing contact")
    .action(async (opts: { name: string; billingEmail?: string }) => {
      const session = await requireOAuth("`paylod orgs create`");

      const spin = spinner("Creating organization…");
      let res: Organization;
      try {
        res = await oauthRequest<Organization>(
          session.apiBase,
          session.accessToken,
          "POST",
          "/organizations",
          {
            body: {
              name: opts.name,
              ...(opts.billingEmail ? { billingEmail: opts.billingEmail } : {}),
            },
          },
        );
      } catch (e) {
        spin.error("Could not create the organization.");
        throw e;
      }
      spin.succeed("Organization created.");

      if (isJson()) {
        emit({ ok: true, ...res });
        return;
      }

      line();
      kv([
        ["organization", c.bold(res.name)],
        ["id", c.dim(res.organizationId)],
        ["your role", roleBadge(res.role)],
      ]);
      line();
      line(
        `  ${c.dim("Next:")} ${c.cyan(`paylod apps create --name "My App" --org ${res.organizationId}`)}`,
      );
      line();
    });

  orgs
    .command("rename")
    .description("Rename an organization (owner or admin only)")
    .argument("<organizationId>")
    .requiredOption("--name <name>", "the new name")
    .action(async (organizationId: string, opts: { name: string }) => {
      const session = await requireOAuth("`paylod orgs rename`");

      const spin = spinner("Renaming…");
      let res: { organizationId: string; name: string };
      try {
        res = await oauthRequest(
          session.apiBase,
          session.accessToken,
          "PATCH",
          `/organizations/${encodeURIComponent(organizationId)}`,
          { body: { name: opts.name } },
        );
      } catch (e) {
        spin.error("Could not rename the organization.");
        throw e;
      }
      spin.stop();

      if (isJson()) {
        emit({ ok: true, ...res });
        return;
      }
      ok(`Renamed to ${c.bold(res.name)}.`);
    });

  return orgs;
}

function roleBadge(role: string): string {
  switch (role) {
    case "owner":
      return c.green("owner");
    case "admin":
      return c.cyan("admin");
    case "developer":
      return c.magenta("developer");
    case "viewer":
      return c.dim("viewer");
    default:
      return c.dim(role);
  }
}
