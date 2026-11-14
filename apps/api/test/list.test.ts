import type { ListResponse } from "@pix/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { admin, api, body, errorCode, seedImage, seedSite, siteAuth } from "./helpers";

let blog: string;
const ids: string[] = []; // blog images, oldest first; ids[5] is soft-deleted

const list = async (query = "", auth: string | null = admin) =>
  body<ListResponse>(await api("GET", `/images?${query}`, { auth }));
const names = async (query: string) =>
  (await list(`limit=100&${query}`)).images.map((i) => i.original_filename).sort();

beforeAll(async () => {
  await seedSite("blog");
  await seedSite("shop");
  blog = await siteAuth("blog");
  const blogImage = async (
    o: Parameters<typeof seedImage>[0] extends infer T ? Partial<T> : never,
  ) => ids.push(await seedImage({ site: "blog", ...o }));
  await blogImage({ filename: "sunset.png", tags: ["nature", "hero"] });
  await blogImage({ filename: "Mountain.PNG", alt: "A big mountain" });
  await blogImage({ filename: "50%_off.png", tags: ["sale"] });
  await blogImage({ filename: "abc.png" });
  await blogImage({ filename: "logo.png", tags: ["hero"] });
  await blogImage({ filename: "old.png", deleted: true });
  await blogImage({ filename: "banner.png", tags: ["hero", "sale"] });
  await seedImage({ site: "shop", filename: "mug.png", tags: ["hero"] });
  await seedImage({ site: "shop", filename: "shirt.png" });
});

describe("GET /images", () => {
  it("pages newest-first to the end with no gaps, and null cursor on the last page", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: ListResponse = await list(
        `site=blog&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      );
      seen.push(...page.images.map((i) => i.id));
      cursor = page.next_cursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual(ids.filter((id) => id !== ids[5]).reverse());
    expect(pages).toBe(3);
    expect((await list("site=blog&limit=6")).next_cursor).toBeNull(); // exact fit
  });

  it("includes sorted tags and the public URL", async () => {
    const [image] = (await list("site=blog&tag=nature")).images;
    expect(image).toMatchObject({
      tags: ["hero", "nature"],
      url: expect.stringContaining("/blog/"),
    });
  });

  it.each([
    ["site=shop", ["mug.png", "shirt.png"]],
    ["site=blog&tag=HERO", ["banner.png", "logo.png", "sunset.png"]],
    ["site=blog&tag=none", []],
    ["site=blog&q=SUNSET", ["sunset.png"]],
    ["site=blog&q=big", ["Mountain.PNG"]], // alt text
    ["site=blog&q=50%25", ["50%_off.png"]], // % is literal
    ["site=blog&q=a_c", []], // _ is literal, so abc.png does not match
    ["site=blog&deleted=only", ["old.png"]],
  ])("filters: %s", async (query, expected) => {
    expect(await names(query)).toEqual(expected);
  });

  it("shows admins every site, and includes deleted on request", async () => {
    expect(new Set((await list("limit=100")).images.map((i) => i.site_id))).toEqual(
      new Set(["blog", "shop"]),
    );
    expect(await names("site=blog&deleted=include")).toContain("old.png");
  });

  it.each(["limit=0", "limit=101", "limit=abc", "cursor=nope", "deleted=maybe"])(
    "rejects %s",
    async (query) => {
      const res = await api("GET", `/images?${query}`);
      expect([res.status, await errorCode(res)]).toEqual([400, "validation_error"]);
    },
  );

  it("pins a site token to its site, and enforces auth", async () => {
    expect(new Set((await list("limit=100", blog)).images.map((i) => i.site_id))).toEqual(
      new Set(["blog"]),
    );
    expect((await api("GET", "/images?site=blog", { auth: blog })).status).toBe(200);
    expect((await api("GET", "/images?site=shop", { auth: blog })).status).toBe(403);
    expect((await api("GET", "/images", { auth: null })).status).toBe(401);
  });
});
