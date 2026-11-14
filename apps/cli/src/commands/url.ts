import {
  DOWNLOAD_PARAM,
  isTransformable,
  TRANSFORM_FITS,
  TRANSFORM_FORMATS,
  type TransformOptions,
  transformUrl,
} from "@pix/schema";
import { Option } from "commander";
import { intOption, type Register } from "../context";
import { UsageError } from "../errors";
import { line } from "../io";

export const registerUrl: Register = (program, ctx) => {
  program
    .command("url")
    .description("Print a file's URL, optionally resized or converted (images only)")
    .argument("<id>", "image id")
    .option("--width <px>", "resize to this width", intOption(1, 10_000))
    .option("--height <px>", "resize to this height", intOption(1, 10_000))
    .addOption(new Option("--fit <mode>", "how to fit width and height").choices(TRANSFORM_FITS))
    .option("--quality <n>", "quality, 1 to 100", intOption(1, 100))
    .addOption(new Option("--format <format>", "output format").choices(TRANSFORM_FORMATS))
    .option("--download", "make the URL download the file instead of displaying it")
    .action(async (id: string, opts: TransformOptions & { download?: boolean }) => {
      const { image } = await (await ctx.client()).getImage(id);
      // The API already knows the public host, so the URL is built from the record rather than config.
      const { download, ...transform } = opts;
      if (!isTransformable(image.content_type) && Object.keys(transform).length > 0) {
        throw new UsageError("resize and format options only apply to images");
      }
      let url: string;
      try {
        url = transformUrl(new URL(image.url).host, image.r2_key, transform);
        if (download) url += `?${DOWNLOAD_PARAM}`;
      } catch (err) {
        throw new UsageError(err instanceof Error ? err.message : String(err));
      }
      ctx.output({ url }, () => line(ctx.io, url));
    });
};
