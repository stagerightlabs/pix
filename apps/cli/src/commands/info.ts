import type { Register } from "../context";
import { formatBytes, isoTime, line } from "../io";

export const registerInfo: Register = (program, ctx) => {
  program
    .command("info")
    .description("Show one file's details")
    .argument("<id>", "image id")
    .action(async (id: string) => {
      const { image: i } = await (await ctx.client()).getImage(id);
      ctx.output({ image: i }, () => {
        const rows: [string, string][] = [
          ["id", i.id],
          ["site", i.site_id],
          ["url", i.url],
          ["file", i.original_filename],
          ["type", i.content_type],
          ["size", formatBytes(i.size_bytes)],
          [
            "dimensions",
            i.width && i.height
              ? `${i.width} x ${i.height}`
              : i.content_type === "application/pdf"
                ? "n/a"
                : "unknown",
          ],
          ["sha256", i.sha256],
          ["alt", i.alt_text ?? ""],
          ["tags", i.tags.join(", ")],
          ["created", isoTime(i.created_at)],
          ["updated", isoTime(i.updated_at)],
          ["deleted", i.deleted_at ? isoTime(i.deleted_at) : "no"],
        ];
        for (const [k, v] of rows) line(ctx.io, `${`${k}:`.padEnd(12)}${v}`);
      });
    });
};
