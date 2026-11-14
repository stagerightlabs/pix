import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { CliError } from "./errors";
import type { IO } from "./io";
import { note } from "./io";

const configSchema = z.object({ api_url: z.string().optional(), token: z.string().optional() });
export type Config = z.infer<typeof configSchema>;

/** `$XDG_CONFIG_HOME/pix/config.json`, which is `~/.config/pix/config.json` by default. */
export function configPath(io: IO): string {
  return join(io.env.XDG_CONFIG_HOME || join(io.home, ".config"), "pix", "config.json");
}

export async function readConfigFile(io: IO): Promise<Config> {
  const path = configPath(io);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
  }
  const parsed = configSchema.safeParse(safeJson(text));
  if (!parsed.success)
    throw new CliError(`${path} is not valid. Run \`pix login\` to recreate it.`);
  const mode = (await stat(path)).mode & 0o077;
  if (mode !== 0) note(io, `Warning: ${path} is readable by other users. Run: chmod 600 ${path}`);
  return parsed.data;
}

/** Writes the file readable by its owner only, since it holds a token. */
export async function writeConfigFile(io: IO, config: Config): Promise<string> {
  const path = configPath(io);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600); // writeFile's mode is ignored when the file already exists
  return path;
}

/** The API URL is the host only: the client adds `/v1`. */
export function parseApiUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CliError(
      `"${input}" is not a valid URL. Use something like https://pix-api.example.com`,
    );
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new CliError(
      "The API URL must start with https:// (http:// is allowed only for localhost).",
    );
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new CliError(`Use just the host, without a path: ${url.origin}`);
  }
  return url.origin;
}

/** `PIX_API_URL` and `PIX_TOKEN` override the config file, one by one. */
export async function resolveConfig(io: IO): Promise<{ apiUrl: string; token: string }> {
  const file = await readConfigFile(io);
  const apiUrl = io.env.PIX_API_URL || file.api_url;
  const token = io.env.PIX_TOKEN || file.token;
  if (!apiUrl || !token) {
    throw new CliError(
      "Not logged in. Run `pix login`, or set PIX_API_URL and PIX_TOKEN.",
      "not_logged_in",
    );
  }
  return { apiUrl: parseApiUrl(apiUrl), token };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
