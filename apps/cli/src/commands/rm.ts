import type { Register } from "../context";
import { line } from "../io";

export const registerRm: Register = (program, ctx) => {
  program
    .command("rm")
    .description("Delete an image (soft by default, so it can be restored)")
    .argument("<id>", "image id")
    .option("--hard", "permanently delete the file and its record")
    .action(async (id: string, opts) => {
      const client = await ctx.client();
      if (opts.hard) {
        await client.hardDelete(id);
        return ctx.output({ id, deleted: "hard" }, () => line(ctx.io, `Permanently deleted ${id}`));
      }
      const { image } = await client.softDelete(id);
      ctx.output({ image }, () =>
        line(ctx.io, `Deleted ${id}. Restore it with: pix restore ${id}`),
      );
    });

  program
    .command("restore")
    .description("Restore a soft-deleted image")
    .argument("<id>", "image id")
    .action(async (id: string) => {
      const { image } = await (await ctx.client()).restoreImage(id);
      ctx.output({ image }, () => line(ctx.io, `Restored ${id}: ${image.url}`));
    });
};
