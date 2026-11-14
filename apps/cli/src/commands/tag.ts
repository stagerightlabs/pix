import { csv, type Register } from "../context";
import { UsageError } from "../errors";
import { line } from "../io";

export const registerTag: Register = (program, ctx) => {
  program
    .command("tag")
    .description("Add or remove tags")
    .argument("<id>", "image id")
    .option("--add <tags>", "comma-separated tags to add", csv)
    .option("--remove <tags>", "comma-separated tags to remove", csv)
    .action(async (id: string, opts) => {
      if (!opts.add?.length && !opts.remove?.length)
        throw new UsageError("Give --add and/or --remove.");
      const { image } = await (await ctx.client()).patchImage(id, {
        add_tags: opts.add,
        remove_tags: opts.remove,
      });
      ctx.output({ image }, () => line(ctx.io, `tags: ${image.tags.join(", ") || "(none)"}`));
    });

  program
    .command("alt")
    .description("Set or clear an image's alt text")
    .argument("<id>", "image id")
    .argument("[text]", "the alt text")
    .option("--clear", "remove the alt text")
    .action(async (id: string, text: string | undefined, opts) => {
      if ((text === undefined) === !opts.clear) {
        throw new UsageError("Give the alt text, or --clear, but not both.");
      }
      const { image } = await (await ctx.client()).patchImage(id, {
        alt_text: opts.clear ? null : text,
      });
      ctx.output({ image }, () => line(ctx.io, `alt: ${image.alt_text ?? "(none)"}`));
    });
};
