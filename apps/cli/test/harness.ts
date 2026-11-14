import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Image } from "@pix/schema";
import { run } from "../src/cli";
import type { IO } from "../src/io";

export const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

export const image = (over: Partial<Image> = {}): Image => ({
  id: ID,
  site_id: "blog",
  r2_key: `blog/2026/${ID}.png`,
  url: `https://pix.example.com/blog/2026/${ID}.png`,
  original_filename: "sunset.png",
  content_type: "image/png",
  size_bytes: 2048,
  width: 64,
  height: 32,
  sha256: "a".repeat(64),
  alt_text: null,
  tags: ["hero"],
  created_at: 1_700_000_000,
  updated_at: 1_700_000_000,
  deleted_at: null,
  ...over,
});

export type Call = { method: string; url: URL; headers: Headers; body: unknown };
/** Returns a Response, or any value to be sent as a 200 JSON body. */
export type Reply = Response | unknown | ((call: Call) => Response | unknown | Promise<unknown>);

const asResponse = (r: unknown) => (r instanceof Response ? r : Response.json(r, { status: 200 }));

export const apiError = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status });

/** A scratch directory with a config home, and a `pix` runner wired to a fake API. */
export async function setup(env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pix-cli-"));
  const calls: Call[] = [];
  let reply: (call: Call) => Promise<unknown> = async () => ({});
  let out = "";
  let err = "";
  const answers: string[] = [];

  const fetchFake = (async (input: URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: new URL(input),
      headers: new Headers(init?.headers),
      body: init?.body,
    };
    calls.push(call);
    return asResponse(await reply(call));
  }) as unknown as typeof fetch;

  const io: IO = {
    stdout: {
      write: (s) => {
        out += s;
      },
    },
    stderr: {
      write: (s) => {
        err += s;
      },
    },
    env: {
      XDG_CONFIG_HOME: join(dir, "config"),
      PIX_API_URL: "https://pix-api.example.com",
      PIX_TOKEN: "test-token",
      ...env,
    },
    cwd: dir,
    home: dir,
    fetch: fetchFake,
    interactive: false,
    prompt: async () => answers.shift() ?? "",
  };

  return {
    dir,
    calls,
    answers,
    io,
    /** Sets what the fake API answers with. */
    api(r: Reply) {
      reply = async (call) => (typeof r === "function" ? (r as (c: Call) => unknown)(call) : r);
    },
    file: (name: string, content = "x") => writeFile(join(dir, name), content),
    async pix(...args: string[]) {
      out = "";
      err = "";
      const code = await run(args, io);
      return { code, out, err };
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
