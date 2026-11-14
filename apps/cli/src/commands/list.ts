import type { Image, ListQuery } from "@pix/schema";
import { Option } from "commander";
import { intOption, type Register } from "../context";
import { formatBytes, isoTime, line, note, table } from "../io";

export const registerList: Register = (program, ctx) => {
  program
    .command("list")
    .description("List images, newest first")
    .option("--site <site>", "only this site")
    .option("--tag <tag>", "only images with this tag")
    .option("--q <text>", "search filename and alt text")
    .option("--limit <n>", "page size (1 to 100)", intOption(1, 100), 50)
    .option("--cursor <id>", "continue after this image id")
    .addOption(
      new Option("--deleted <mode>", "soft-deleted images").choices(["exclude", "include", "only"]),
    )
    .option("--all", "follow every page")
    .action(async (opts) => {
      const client = await ctx.client();
      const query: Partial<ListQuery> = {
        site: opts.site,
        tag: opts.tag,
        q: opts.q,
        limit: opts.limit,
        cursor: opts.cursor,
        deleted: opts.deleted,
      };

      let images: Image[] = [];
      let next: string | null = null;
      do {
        const page = await client.listImages({ ...query, cursor: next ?? query.cursor });
        images = images.concat(page.images);
        next = page.next_cursor;
      } while (opts.all && next);

      ctx.output({ images, next_cursor: next }, () => {
        if (images.length === 0) return note(ctx.io, "No images found.");
        const rows = images.map((i) => [
          i.id,
          i.site_id,
          i.deleted_at ? `${i.original_filename} (deleted)` : i.original_filename,
          formatBytes(i.size_bytes),
          i.tags.join(","),
          isoTime(i.created_at).slice(0, 10),
        ]);
        for (const l of table([["ID", "SITE", "FILE", "SIZE", "TAGS", "CREATED"], ...rows])) {
          line(ctx.io, l);
        }
        if (next) note(ctx.io, `More results: add --cursor ${next} (or use --all)`);
      });
    });
};
