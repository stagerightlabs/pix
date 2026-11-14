import type { ImageResponse } from "@pix/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { api, body, errorCode, seedImage, seedSite, siteAuth } from "./helpers";

let blog: string;

beforeAll(async () => {
  await seedSite("blog");
  await seedSite("shop");
  blog = await siteAuth("blog");
});

const patch = async (id: string, data: unknown, auth?: string | null) =>
  api("PATCH", `/images/${id}`, { body: data, auth });
const patched = async (id: string, data: unknown) =>
  (await body<ImageResponse>(await patch(id, data))).image;

describe("PATCH /images/:id", () => {
  it("sets, preserves and clears alt text, and bumps updated_at", async () => {
    const id = await seedImage({ site: "blog" }); // seeded with updated_at = 1
    const set = await patched(id, { alt_text: "A mountain" });
    expect(set.alt_text).toBe("A mountain");
    expect(set.updated_at).toBeGreaterThan(1_000_000);
    expect((await patched(id, { add_tags: ["x"] })).alt_text).toBe("A mountain");
    expect((await patched(id, { alt_text: null })).alt_text).toBeNull();
  });

  it("adds (normalized, idempotent) and removes tags, ignoring unknown ones", async () => {
    const id = await seedImage({ site: "blog", tags: ["old", "keep"] });
    const image = await patched(id, {
      add_tags: ["Hero", " hero ", "keep"],
      remove_tags: ["OLD", "never-had"],
    });
    expect(image.tags).toEqual(["hero", "keep"]);
  });

  it("keeps tags separate per site", async () => {
    const a = await seedImage({ site: "blog", tags: ["shared"] });
    const b = await seedImage({ site: "shop", tags: ["shared"] });
    await patch(b, { remove_tags: ["shared"] });
    expect((await body<ImageResponse>(await api("GET", `/images/${a}`))).image.tags).toEqual([
      "shared",
    ]);
  });

  it.each([
    [{}],
    [{ add_tags: [] }],
    [{ add_tags: ["x"], remove_tags: ["X"] }],
    [{ add_tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }],
  ])("rejects the invalid body %j", async (data) => {
    const res = await patch(await seedImage({ site: "blog" }), data);
    expect([res.status, await errorCode(res)]).toEqual([400, "validation_error"]);
  });

  it("returns 404 for a missing image and 400 for a malformed id", async () => {
    const missing = await patch("01ARZ3NDEKTSV4RRFFQ69G5FAV", { alt_text: "x" });
    expect([missing.status, await errorCode(missing)]).toEqual([404, "image_not_found"]);
    expect((await patch("bad-id", { alt_text: "x" })).status).toBe(400);
  });

  it("lets a site token edit only its own site, and requires a token", async () => {
    const own = await seedImage({ site: "blog" });
    const other = await seedImage({ site: "shop", alt: "untouched" });
    expect((await patch(own, { alt_text: "mine" }, blog)).status).toBe(200);
    const denied = await patch(other, { alt_text: "hacked", add_tags: ["x"] }, blog);
    expect([denied.status, await errorCode(denied)]).toEqual([403, "forbidden"]);
    expect(await patched(other, { add_tags: ["y"] })).toMatchObject({
      alt_text: "untouched",
      tags: ["y"],
    });
    expect((await patch(own, { alt_text: "x" }, null)).status).toBe(401);
  });
});
