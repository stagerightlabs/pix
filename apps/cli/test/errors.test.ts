import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiError, ID, setup } from "./harness";

let t: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  t = await setup();
});
afterEach(() => t.cleanup());

describe("API and network errors", () => {
  it("shows the message with the API error code in parentheses, exit 1", async () => {
    t.api(apiError(404, "image_not_found", "Image not found"));
    expect(await t.pix("info", ID)).toEqual({
      code: 1,
      out: "",
      err: "Error: Image not found (image_not_found)\n",
    });
  });

  it("prints errors as JSON on stderr with --json", async () => {
    t.api(apiError(404, "image_not_found", "Image not found"));
    const { code, out, err } = await t.pix("info", ID, "--json");
    expect([code, out]).toEqual([1, ""]);
    expect(JSON.parse(err)).toEqual({
      error: { code: "image_not_found", message: "Image not found" },
    });
  });

  it.each([
    [
      "an unreachable host",
      () => {
        throw new TypeError("fetch failed", { cause: "ECONNREFUSED" });
      },
      "Could not reach https://pix-api.example.com: ECONNREFUSED (network_error)",
    ],
    [
      "a non-JSON error page",
      () => new Response("<html>blocked</html>", { status: 403 }),
      "HTTP 403 from pix-api.example.com (http_403)",
    ],
    [
      "an unexpected response shape",
      () => ({ unexpected: true }),
      `Unexpected response from the API for GET /images/${ID} (bad_response)`,
    ],
  ])("handles %s", async (_name, reply, message) => {
    t.api(reply);
    expect(await t.pix("info", ID)).toEqual({ code: 1, out: "", err: `Error: ${message}\n` });
  });
});

describe("retries", () => {
  it("retries a failing GET and succeeds, but never repeats a write", async () => {
    const o = await setup({ PIX_RETRY_DELAY_MS: "0" });
    let n = 0;
    o.api(() =>
      ++n < 3 ? apiError(500, "internal_error", "Internal server error") : { sites: [] },
    );
    expect((await o.pix("sites", "list")).code).toBe(0);
    expect(o.calls).toHaveLength(3);

    o.calls.length = 0;
    o.api(() => apiError(500, "internal_error", "Internal server error")); // a fresh Response per call
    expect((await o.pix("sites", "create", "docs")).code).toBe(1);
    expect(o.calls).toHaveLength(1); // a POST is sent once
    expect((await o.pix("sites", "list")).err).toBe(
      "Error: Internal server error (internal_error)\n",
    );
    expect(o.calls).toHaveLength(4); // 1 + three attempts for the GET
    await o.cleanup();
  });
});

describe("usage errors exit 2 without calling the API", () => {
  it.each([
    [["upload", "a.png"]], // --site is required
    [["nope"]],
    [["tag", ID]],
    [["alt", ID]],
    [["alt", ID, "text", "--clear"]],
    [["url", ID, "--width", "0"]],
    [["url", ID, "--format", "gif"]],
    [["list", "--limit", "abc"]],
    [["list", "--deleted", "maybe"]],
    [["upload", "a.png", "--site", "blog", "--concurrency", "99"]],
    [["login"]], // not a terminal, and no --url and --token
  ])("%j", async (args) => {
    const { code, out } = await t.pix(...args);
    expect([code, out, t.calls.length]).toEqual([2, "", 0]);
  });

  it("treats --help and --version as success", async () => {
    expect((await t.pix("--help")).code).toBe(0);
    expect((await t.pix("--version")).out).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("config and login", () => {
  const noEnv = { PIX_API_URL: "", PIX_TOKEN: "" };

  it("login checks the credentials, saves them with mode 0600, and later commands use the file", async () => {
    const o = await setup(noEnv);
    o.api({ sites: [] });
    const login = await o.pix(
      "login",
      "--url",
      "https://pix-api.example.com/",
      "--token",
      "tok-123",
    );
    expect(login.code).toBe(0);
    expect(o.calls[0]?.headers.get("authorization")).toBe("Bearer tok-123"); // checked before saving

    const file = join(o.dir, "config", "pix", "config.json");
    expect(JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8"))).toEqual({
      api_url: "https://pix-api.example.com",
      token: "tok-123",
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    o.api({ sites: [] });
    expect((await o.pix("sites", "list")).code).toBe(0);
    expect(o.calls.at(-1)?.headers.get("authorization")).toBe("Bearer tok-123");
    await o.cleanup();
  });

  it("lets PIX_API_URL and PIX_TOKEN override the file one by one", async () => {
    const o = await setup({ PIX_TOKEN: "env-token", PIX_API_URL: "" });
    await mkdir(join(o.dir, "config", "pix"), { recursive: true });
    await writeFile(
      join(o.dir, "config", "pix", "config.json"),
      JSON.stringify({ api_url: "https://file.example.com", token: "file-token" }),
      { mode: 0o600 },
    );
    o.api({ sites: [] });
    await o.pix("sites", "list");
    expect([o.calls[0]?.url.origin, o.calls[0]?.headers.get("authorization")]).toEqual([
      "https://file.example.com",
      "Bearer env-token",
    ]);
    await o.cleanup();
  });

  it("does not save anything when the credentials are rejected", async () => {
    const o = await setup(noEnv);
    o.api(apiError(401, "unauthorized", "Invalid token"));
    const { code, err } = await o.pix(
      "login",
      "--url",
      "https://pix-api.example.com",
      "--token",
      "bad",
    );
    expect([code, err]).toEqual([1, "Error: Invalid token (unauthorized)\n"]);
    await expect(stat(join(o.dir, "config", "pix", "config.json"))).rejects.toThrow();
    await o.cleanup();
  });

  it.each(["http://pix.example.com", "https://pix.example.com/v1", "not a url"])(
    "rejects the API URL %s",
    async (url) => {
      const { code, err } = await t.pix("login", "--url", url, "--token", "x");
      expect([code, t.calls.length, err.startsWith("Error: ")]).toEqual([1, 0, true]);
    },
  );

  it("allows plain http for localhost", async () => {
    t.api({ sites: [] });
    expect((await t.pix("login", "--url", "http://localhost:8787", "--token", "x")).code).toBe(0);
  });

  it("prompts when interactive, defaulting the URL", async () => {
    const o = await setup(noEnv);
    o.io.interactive = true;
    o.answers.push("", "typed-token");
    o.api({ sites: [] });
    expect((await o.pix("login")).code).toBe(0);
    expect(o.calls[0]?.url.origin).toBe("https://pix-api.stagerightlabs.com");
    expect(o.calls[0]?.headers.get("authorization")).toBe("Bearer typed-token");
    await o.cleanup();
  });

  it("asks you to log in when nothing is configured, and warns about a loose config file", async () => {
    const o = await setup(noEnv);
    expect(await o.pix("list")).toEqual({
      code: 1,
      out: "",
      err: "Error: Not logged in. Run `pix login`, or set PIX_API_URL and PIX_TOKEN.\n",
    });
    await mkdir(join(o.dir, "config", "pix"), { recursive: true });
    await writeFile(
      join(o.dir, "config", "pix", "config.json"),
      '{"api_url":"https://x.example.com","token":"t"}',
      { mode: 0o644 },
    );
    o.api({ images: [], next_cursor: null });
    expect((await o.pix("list")).err).toContain("readable by other users");
    await o.cleanup();
  });
});
