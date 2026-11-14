import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ID, image, setup } from "./harness";

let t: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  t = await setup();
});
afterEach(() => t.cleanup());

const site = { id: "docs", name: "Docs", created_at: 1_700_000_000 };
const token = {
  id: ID,
  name: "ci",
  site_id: null,
  created_at: 1_700_000_000,
  last_used_at: null,
  revoked_at: null,
};

// [args, expected request, API reply, text expected on stdout]
const cases: [
  string[],
  { method: string; path: string; query?: Record<string, string>; body?: unknown },
  unknown,
  string,
][] = [
  [
    ["list", "--site", "blog", "--tag", "hero", "--q", "sun", "--limit", "5", "--deleted", "only"],
    {
      method: "GET",
      path: "/v1/images",
      query: { site: "blog", tag: "hero", q: "sun", deleted: "only", limit: "5" },
    },
    { images: [image()], next_cursor: null },
    "sunset.png",
  ],
  [
    ["info", ID],
    { method: "GET", path: `/v1/images/${ID}` },
    { image: image() },
    "dimensions: 64 x 32",
  ],
  [
    ["tag", ID, "--add", "a, b", "--remove", "c"],
    {
      method: "PATCH",
      path: `/v1/images/${ID}`,
      body: { add_tags: ["a", "b"], remove_tags: ["c"] },
    },
    { image: image({ tags: ["a", "b"] }) },
    "tags: a, b",
  ],
  [
    ["alt", ID, "A sunset"],
    { method: "PATCH", path: `/v1/images/${ID}`, body: { alt_text: "A sunset" } },
    { image: image({ alt_text: "A sunset" }) },
    "alt: A sunset",
  ],
  [
    ["alt", ID, "--clear"],
    { method: "PATCH", path: `/v1/images/${ID}`, body: { alt_text: null } },
    { image: image() },
    "alt: (none)",
  ],
  [
    ["rm", ID],
    { method: "DELETE", path: `/v1/images/${ID}` },
    { image: image({ deleted_at: 1 }) },
    "pix restore",
  ],
  [
    ["rm", ID, "--hard"],
    { method: "DELETE", path: `/v1/images/${ID}`, query: { hard: "true" } },
    new Response(null, { status: 204 }),
    "Permanently deleted",
  ],
  [
    ["restore", ID],
    { method: "POST", path: `/v1/images/${ID}/restore` },
    { image: image() },
    "Restored",
  ],
  [
    ["url", ID, "--width", "800", "--format", "auto"],
    { method: "GET", path: `/v1/images/${ID}` },
    { image: image() },
    `https://pix.example.com/cdn-cgi/image/width=800,format=auto/blog/2026/${ID}.png`,
  ],
  [["sites", "list"], { method: "GET", path: "/v1/sites" }, { sites: [site] }, "docs"],
  [
    ["sites", "create", "docs", "--name", "Docs"],
    { method: "POST", path: "/v1/sites", body: { id: "docs", name: "Docs" } },
    { site },
    "Created site docs",
  ],
  [["tokens", "list"], { method: "GET", path: "/v1/tokens" }, { tokens: [token] }, "(admin)"],
  [
    ["tokens", "create", "ci", "--site", "blog"],
    { method: "POST", path: "/v1/tokens", body: { name: "ci", site_id: "blog" } },
    { token: { ...token, site_id: "blog" }, secret: "pix_secret" },
    "pix_secret",
  ],
  [
    ["tokens", "revoke", ID],
    { method: "DELETE", path: `/v1/tokens/${ID}` },
    { token: { ...token, revoked_at: 1 } },
    "Revoked token",
  ],
];

describe("commands", () => {
  it.each(cases)(
    "%j sends the right request and prints the result",
    async (args, req, reply, stdout) => {
      t.api(reply);
      const { code, out } = await t.pix(...args);
      expect(code).toBe(0);
      expect(out).toContain(stdout);

      const call = t.calls.at(-1);
      expect(call?.method).toBe(req.method);
      expect(call?.url.pathname).toBe(req.path);
      expect(Object.fromEntries(call?.url.searchParams ?? [])).toEqual(req.query ?? {});
      expect(call?.headers.get("authorization")).toBe("Bearer test-token");
      if (req.body) expect(JSON.parse(call?.body as string)).toEqual(req.body);
    },
  );

  it.each(cases)("%j with --json prints only JSON", async (args, _req, reply) => {
    t.api(reply instanceof Response ? new Response(null, { status: 204 }) : reply);
    const { code, out } = await t.pix(...args, "--json");
    expect(code).toBe(0);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("lists with a next-page hint on stderr, and follows every page with --all", async () => {
    const second = image({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAW", original_filename: "second.png" });
    t.api((c: { url: URL }) =>
      c.url.searchParams.get("cursor")
        ? { images: [second], next_cursor: null }
        : { images: [image()], next_cursor: ID },
    );
    const page = await t.pix("list");
    expect([page.out.includes("sunset.png"), page.err.includes(`--cursor ${ID}`)]).toEqual([
      true,
      true,
    ]);

    const all = await t.pix("list", "--all");
    expect(all.out).toContain("second.png");
    expect(all.err).toBe("");
  });

  it("marks soft-deleted images in the list", async () => {
    t.api({ images: [image({ deleted_at: 5 })], next_cursor: null });
    expect((await t.pix("list", "--deleted", "include")).out).toContain("sunset.png (deleted)");
  });
});
