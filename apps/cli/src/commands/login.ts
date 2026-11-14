import { createClient } from "../client";
import { parseApiUrl, writeConfigFile } from "../config";
import type { Register } from "../context";
import { UsageError } from "../errors";
import { line } from "../io";

const DEFAULT_URL = "https://pix-api.stagerightlabs.com";

export const registerLogin: Register = (program, ctx) => {
  program
    .command("login")
    .description("Save the API URL and token to ~/.config/pix/config.json (mode 0600)")
    .option("--url <url>", "API URL, host only")
    .option("--token <token>", "API token (visible in shell history; prefer the prompt)")
    .action(async (opts) => {
      const { io } = ctx;
      if (!io.interactive && !(opts.url && opts.token)) {
        throw new UsageError("Not a terminal: pass both --url and --token.");
      }
      const url = parseApiUrl(
        opts.url ?? ((await io.prompt(`API URL [${DEFAULT_URL}]: `)) || DEFAULT_URL),
      );
      const token = opts.token ?? (await io.prompt("API token: ", { hidden: true }));
      if (!token) throw new UsageError("A token is required.");

      // Check the credentials before saving them.
      const client = createClient({ baseUrl: url, token, fetch: io.fetch });
      await client.listSites();

      const path = await writeConfigFile(io, { api_url: url, token });
      ctx.output({ api_url: url, config: path }, () =>
        line(io, `Logged in to ${url}. Saved to ${path}`),
      );
    });
};
