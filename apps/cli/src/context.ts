import { type Command, InvalidArgumentError } from "commander";
import { type Client, createClient } from "./client";
import { resolveConfig } from "./config";
import { type IO, line, printJson } from "./io";

/** What every command gets: the IO, the --json switch, and a lazily created API client. */
export type Ctx = {
  io: IO;
  json: boolean;
  client(): Promise<Client>;
  /** Print `data` as JSON with --json, otherwise run `human`. */
  output(data: unknown, human: () => void): void;
};

export function makeCtx(io: IO, program: Command): Ctx {
  return {
    io,
    get json() {
      return program.opts<{ json?: boolean }>().json === true;
    },
    async client() {
      const { apiUrl, token } = await resolveConfig(io);
      return createClient({
        baseUrl: apiUrl,
        token,
        fetch: io.fetch,
        retryDelayMs: io.env.PIX_RETRY_DELAY_MS ? Number(io.env.PIX_RETRY_DELAY_MS) : undefined,
      });
    },
    output(data, human) {
      if (program.opts<{ json?: boolean }>().json) printJson(io, data);
      else human();
    },
  };
}

export type Register = (program: Command, ctx: Ctx) => void;

export const intOption = (min: number, max: number) => (value: string) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new InvalidArgumentError(`must be a whole number from ${min} to ${max}`);
  }
  return n;
};

export const csv = (value: string) =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export { line };
