import type { Register } from "../context";
import { UsageError } from "../errors";
import { isoTime, line, table } from "../io";

export const registerSites: Register = (program, ctx) => {
  const sites = program.command("sites").description("Manage sites");

  sites
    .command("list")
    .description("List sites")
    .action(async () => {
      const data = await (await ctx.client()).listSites();
      ctx.output(data, () => {
        const rows = data.sites.map((s) => [s.id, s.name, isoTime(s.created_at).slice(0, 10)]);
        for (const l of table([["ID", "NAME", "CREATED"], ...rows])) line(ctx.io, l);
      });
    });

  sites
    .command("create")
    .description("Create a site (admin token)")
    .argument("<id>", "slug: lowercase letters, digits and hyphens")
    .option("--name <name>", "display name (defaults to the id)")
    .action(async (id: string, opts) => {
      if (!id) throw new UsageError("A site id is required.");
      const data = await (await ctx.client()).createSite({ id, name: opts.name ?? id });
      ctx.output(data, () => line(ctx.io, `Created site ${data.site.id}`));
    });
};
