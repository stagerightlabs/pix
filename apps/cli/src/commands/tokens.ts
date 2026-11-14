import type { Register } from "../context";
import { isoTime, line, note, table } from "../io";

export const registerTokens: Register = (program, ctx) => {
  const tokens = program.command("tokens").description("Manage API tokens (admin token)");

  tokens
    .command("list")
    .description("List tokens")
    .action(async () => {
      const data = await (await ctx.client()).listTokens();
      ctx.output(data, () => {
        const rows = data.tokens.map((t) => [
          t.id,
          t.name,
          t.site_id ?? "(admin)",
          t.revoked_at ? "revoked" : "active",
          t.last_used_at ? isoTime(t.last_used_at).slice(0, 10) : "never",
        ]);
        for (const l of table([["ID", "NAME", "SITE", "STATUS", "LAST USED"], ...rows]))
          line(ctx.io, l);
      });
    });

  tokens
    .command("create")
    .description("Create a token; the secret is shown once")
    .argument("<name>", "a label for the token")
    .option("--site <site>", "limit the token to one site (omit for an admin token)")
    .action(async (name: string, opts) => {
      const data = await (await ctx.client()).createToken({ name, site_id: opts.site ?? null });
      ctx.output(data, () => {
        line(ctx.io, `Created token ${data.token.id} (${data.token.site_id ?? "admin"})`);
        line(ctx.io, data.secret);
        note(ctx.io, "Save the secret now: it will not be shown again.");
      });
    });

  tokens
    .command("revoke")
    .description("Revoke a token immediately")
    .argument("<id>", "token id")
    .action(async (id: string) => {
      const data = await (await ctx.client()).revokeToken(id);
      ctx.output(data, () => line(ctx.io, `Revoked token ${id}`));
    });
};
