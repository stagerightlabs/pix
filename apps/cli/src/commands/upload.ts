import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import type { Image } from "@pix/schema";
import { glob, isDynamicPattern } from "tinyglobby";
import { ApiClientError } from "../client";
import { csv, intOption, type Register } from "../context";
import { CliError } from "../errors";
import { type IO, line, note } from "../io";

type Result =
  | { file: string; status: "created" | "duplicate"; image: Image }
  | { file: string; status: "error"; error: { code: string; message: string } };

/** Literal paths are used as they are; anything else with glob characters is expanded. */
async function expand(io: IO, patterns: string[]): Promise<string[]> {
  const files = new Set<string>();
  const missing: string[] = [];
  for (const pattern of patterns) {
    const path = resolve(io.cwd, pattern);
    if (
      await stat(path).then(
        (s) => s.isFile(),
        () => false,
      )
    ) {
      files.add(path);
    } else if (isDynamicPattern(pattern)) {
      const found = await glob(pattern, { cwd: io.cwd, absolute: true, onlyFiles: true });
      if (found.length === 0) missing.push(pattern);
      for (const f of found.sort()) files.add(f);
    } else {
      missing.push(pattern);
    }
  }
  if (missing.length > 0) {
    throw new CliError(`No such file: ${missing.join(", ")}`);
  }
  return [...files];
}

/** Runs `fn` over `items` with at most `limit` in flight, returning results in input order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const registerUpload: Register = (program, ctx) => {
  program
    .command("upload")
    .description("Upload images and print one URL per file")
    .argument("<files...>", "files or glob patterns (quote globs to let pix expand them)")
    .requiredOption("--site <site>", "site to upload to")
    .option("--tag <tags>", "comma-separated tags", csv)
    .option("--alt <text>", "alt text")
    .option("--concurrency <n>", "uploads at once (1 to 10)", intOption(1, 10), 3)
    .action(async (patterns: string[], opts) => {
      const client = await ctx.client();
      const files = await expand(ctx.io, patterns);

      const results = await pool(files, opts.concurrency, async (path): Promise<Result> => {
        const name = relative(ctx.io.cwd, path) || basename(path);
        try {
          const file = new File([await openAsBlob(path)], basename(path));
          const { image, duplicate } = await client.uploadImage(file, {
            site: opts.site,
            tags: opts.tag,
            alt: opts.alt,
          });
          const status = duplicate ? "duplicate" : "created";
          note(
            ctx.io,
            duplicate ? `duplicate ${name} (already stored as ${image.id})` : `uploaded  ${name}`,
          );
          return { file: name, status, image };
        } catch (err) {
          const error =
            err instanceof ApiClientError
              ? { code: err.code, message: err.message }
              : { code: "error", message: err instanceof Error ? err.message : String(err) };
          note(ctx.io, `failed    ${name}: ${error.message} (${error.code})`);
          return { file: name, status: "error", error };
        }
      });

      const count = (s: Result["status"]) => results.filter((r) => r.status === s).length;
      note(
        ctx.io,
        `${count("created")} uploaded, ${count("duplicate")} duplicate, ${count("error")} failed`,
      );

      ctx.output(results, () => {
        for (const r of results) if (r.status !== "error") line(ctx.io, r.image.url);
      });
      if (count("error") > 0) throw new CliError("", "upload_failed"); // exit 1; the results above are the message
    });
};
