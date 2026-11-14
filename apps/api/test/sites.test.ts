import type { SiteResponse, SitesResponse } from "@pix/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { api, body, errorCode, seedSite, siteAuth } from "./helpers";

let blog: string;

beforeAll(async () => {
  await seedSite("blog");
  await seedSite("shop");
  blog = await siteAuth("blog");
});

const siteIds = async (auth?: string) =>
  (await body<SitesResponse>(await api("GET", "/sites", { auth }))).sites.map((s) => s.id);

describe("sites", () => {
  it("lists all sites for an admin but only its own for a site token", async () => {
    expect(await siteIds()).toEqual(["blog", "shop"]);
    expect(await siteIds(blog)).toEqual(["blog"]);
    expect((await api("GET", "/sites", { auth: null })).status).toBe(401);
  });

  it("creates a site, and rejects a duplicate without changing the original", async () => {
    const res = await api("POST", "/sites", { body: { id: "docs", name: "Docs" } });
    expect([res.status, (await body<SiteResponse>(res)).site]).toMatchObject([
      201,
      { id: "docs", name: "Docs" },
    ]);
    expect(await siteIds()).toContain("docs");

    const dup = await api("POST", "/sites", { body: { id: "blog", name: "Changed" } });
    expect([dup.status, await errorCode(dup)]).toEqual([409, "site_exists"]);
    expect(
      (await body<SitesResponse>(await api("GET", "/sites"))).sites.find((s) => s.id === "blog")
        ?.name,
    ).toBe("BLOG");
  });

  it.each(["Blog", "my site", "-lead", "x".repeat(41), "../x", ""])(
    "rejects the slug %j",
    async (id) => {
      const res = await api("POST", "/sites", { body: { id, name: "N" } });
      expect([res.status, await errorCode(res)]).toEqual([400, "validation_error"]);
    },
  );

  it("only lets an admin create sites", async () => {
    const data = { id: "evil", name: "Evil" };
    const denied = await api("POST", "/sites", { auth: blog, body: data });
    expect([denied.status, await errorCode(denied)]).toEqual([403, "forbidden"]);
    expect((await api("POST", "/sites", { auth: null, body: data })).status).toBe(401);
  });
});
