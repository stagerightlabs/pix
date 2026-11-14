import {
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
    .description("Print an image's URL, optionally resized or converted")
    .argument("<id>", "image id")
    .option("--width <px>", "resize to this width", intOption(1, 10_000))
    .option("--height <px>", "resize to this height", intOption(1, 10_000))
    .addOption(new Option("--fit <mode>", "how to fit width and height").choices(TRANSFORM_FITS))
    .option("--quality <n>", "quality, 1 to 100", intOption(1, 100))
    .addOption(new Option("--format <format>", "output format").choices(TRANSFORM_FORMATS))
    .action(async (id: string, opts: TransformOptions) => {
      const { image } = await (await ctx.client()).getImage(id);
      // The API already knows the public host, so the URL is built from the record rather than config.
      let url: string;
      try {
        url = transformUrl(new URL(image.url).host, image.r2_key, opts);
      } catch (err) {
        throw new UsageError(err instanceof Error ? err.message : String(err));
      }
      ctx.output({ url }, () => line(ctx.io, url));
    });
};
