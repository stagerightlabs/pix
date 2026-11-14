import { env } from "cloudflare:workers";
import type { ImageResponse, UploadResponse } from "@pix/schema";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app";
import { images, imageTags, tags } from "../src/db/schema";
import { avif, gif, jpeg, png, svg, webpExtended } from "./fixtures";
import { admin, api, body, db, errorCode, seedImage, seedSite, siteAuth } from "./helpers";

let blog: string;
let shop: string;

beforeAll(async () => {
  await seedSite("blog");
  await seedSite("shop");
  blog = await siteAuth("blog");
  shop = await siteAuth("shop");
});

type UploadOpts = {
  site?: string | null;
  name?: string;
  type?: string;
  tags?: string[];
  alt?: string;
  auth?: string | null;
  env?: Env;
  headers?: Record<string, string>;
};

function upload(bytes: Uint8Array, o: UploadOpts = {}) {
  const form = new FormData();
  form.set("file", new File([bytes], o.name ?? "pic.png", { type: o.type ?? "image/png" }));
  if (o.site !== null) form.set("site", o.site ?? "blog");
  for (const t of o.tags ?? []) form.append("tags[]", t);
  if (o.alt) form.set("alt_text", o.alt);
  const headers = { ...o.headers, ...(o.auth === null ? {} : { Authorization: o.auth ?? admin }) };
  return app.request("/v1/images", { method: "POST", body: form, headers }, o.env ?? env);
}
const uploaded = async (bytes: Uint8Array, o?: UploadOpts) =>
  body<UploadResponse>(await upload(bytes, o));
const status = async (res: Response) => [res.status, await errorCode(res)];

describe("POST /images", () => {
  it("stores the image and returns its record", async () => {
    const { image, duplicate } = await uploaded(png(640, 480, "happy"), {
      name: "My Photo.png",
      alt: "a photo",
    });
    expect(duplicate).toBe(false);
    expect(image).toMatchObject({
      site_id: "blog",
      original_filename: "My Photo.png",
      content_type: "image/png",
      width: 640,
      height: 480,
      alt_text: "a photo",
      deleted_at: null,
      tags: [],
    });
    expect(image.sha256).toMatch(/^[0-9a-f]{64}$/);
    // {site}/{year}/{ulid}.{ext}, and the filename never appears in the key.
    expect(image.r2_key).toBe(`blog/${new Date().getUTCFullYear()}/${image.id}.png`);
    expect(image.url).toBe(`https://pix.stagerightlabs.com/${image.r2_key}`);
    const object = await env.IMAGES.get(image.r2_key);
    expect([object?.httpMetadata?.contentType, object?.size]).toEqual([
      "image/png",
      image.size_bytes,
    ]);
  });

  it.each([
    [jpeg, "image/jpeg", "jpg"],
    [gif, "image/gif", "gif"],
    [webpExtended, "image/webp", "webp"],
    [avif, "image/avif", "avif"],
  ] as const)(
    "accepts %# by content, ignoring a false name and header",
    async (build, type, ext) => {
      const res = await upload(build(30, 20, "formats"), {
        name: "x.exe",
        type: "application/octet-stream",
      });
      expect(res.status).toBe(201);
      const { image } = await body<UploadResponse>(res);
      expect(image).toMatchObject({ content_type: type, width: 30, height: 20 });
      expect(image.r2_key.endsWith(`.${ext}`)).toBe(true);
    },
  );

  it("normalizes tags and reuses existing ones", async () => {
    const { image } = await uploaded(png(5, 5, "tags"), {
      tags: ["Hero", " hero ", "Blog Post", ""],
    });
    expect(image.tags).toEqual(["blog post", "hero"]);
    await uploaded(png(6, 6, "tags2"), { tags: ["hero"] });
    const hero = (await db.select().from(tags).where(eq(tags.siteId, "blog"))).filter(
      (t) => t.name === "hero",
    );
    expect(hero).toHaveLength(1);
  });

  it("dedupes per site and restores a soft-deleted duplicate", async () => {
    const bytes = png(10, 10, "dup");
    const first = await uploaded(bytes);
    const objects = (await env.IMAGES.list()).objects.length;

    const again = await upload(bytes, { name: "renamed.png" });
    expect(again.status).toBe(200);
    expect(await body<UploadResponse>(again)).toMatchObject({
      duplicate: true,
      image: { id: first.image.id },
    });
    expect((await env.IMAGES.list()).objects.length).toBe(objects);

    const other = await upload(bytes, { site: "shop" }); // same bytes, other site: a new image
    expect([other.status, (await body<UploadResponse>(other)).image.id]).not.toContain(
      first.image.id,
    );

    await api("DELETE", `/images/${first.image.id}`);
    const restored = await body<UploadResponse>(await upload(bytes));
    expect(restored).toMatchObject({
      duplicate: true,
      image: { id: first.image.id, deleted_at: null },
    });
  });

  it.each([
    [
      "SVG by content",
      () => svg(),
      { name: "logo.svg", type: "image/svg+xml" },
      415,
      "unsupported_media_type",
    ],
    [
      "text named .png",
      () => new TextEncoder().encode("definitely not a png file"),
      {},
      415,
      "unsupported_media_type",
    ],
    ["an empty file", () => new Uint8Array(0), {}, 400, "empty_file"],
    ["a missing site", () => png(1, 1, "a"), { site: null }, 400, "validation_error"],
    ["an unknown site", () => png(1, 1, "b"), { site: "nope" }, 404, "site_not_found"],
  ] as const)("rejects %s", async (_name, bytes, opts, code, error) => {
    expect(await status(await upload(bytes(), opts))).toEqual([code, error]);
  });

  it("rejects a request with no file part", async () => {
    const res = await app.request(
      "/v1/images",
      { method: "POST", body: new FormData(), headers: { Authorization: admin } },
      env,
    );
    expect(await status(res)).toEqual([400, "validation_error"]);
  });

  describe("size limits", () => {
    const small = { ...env, MAX_UPLOAD_BYTES: "100" } as unknown as Env;

    it.each([
      [
        "Content-Length",
        { headers: { "Content-Length": String(10 * 1024 * 1024) } },
        png(1, 1, "cl"),
      ],
      ["file size, within the multipart slack", {}, png(1, 1, "x".repeat(500))],
    ])("rejects by %s", async (_name, opts, bytes) => {
      expect(await status(await upload(bytes, { env: small, ...opts }))).toEqual([
        413,
        "payload_too_large",
      ]);
    });

    it("enforces the limit while streaming, even with a false Content-Length", async () => {
      const boundary = "----pixtest";
      const head = `--${boundary}\r\nContent-Disposition: form-data; name="site"\r\n\r\nblog\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`;
      const chunks = [
        new TextEncoder().encode(head),
        ...Array(6).fill(new Uint8Array(32 * 1024).fill(0x41)),
      ];
      const stream = new ReadableStream<Uint8Array>({
        pull: (c) => (chunks.length ? c.enqueue(chunks.shift()) : c.close()),
      });
      const res = await app.request(
        "/v1/images",
        {
          method: "POST",
          body: stream,
          headers: {
            Authorization: admin,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": "100", // a lie
          },
          // @ts-expect-error duplex is required by some runtimes for streaming request bodies
          duplex: "half",
        },
        small,
      );
      expect(await status(res)).toEqual([413, "payload_too_large"]);
    });
  });

  it("enforces auth: a token is required, and a site token is confined to its site", async () => {
    expect((await upload(png(1, 1, "a1"), { auth: null })).status).toBe(401);
    expect((await upload(png(2, 2, "own"), { auth: blog })).status).toBe(201);
    expect(await status(await upload(png(2, 2, "other"), { auth: blog, site: "shop" }))).toEqual([
      403,
      "forbidden",
    ]);
  });
});

const record = async (id: string, auth?: string | null) => api("GET", `/images/${id}`, { auth });

describe("GET /images/:id", () => {
  it("returns the record with tags and URL", async () => {
    const { image } = await uploaded(png(8, 8, "get"), { tags: ["a"] });
    expect((await body<ImageResponse>(await record(image.id))).image).toEqual(image);
  });

  it("returns 404 or 400 for a missing or malformed id", async () => {
    expect(await status(await record("01ARZ3NDEKTSV4RRFFQ69G5FAV"))).toEqual([
      404,
      "image_not_found",
    ]);
    expect((await record("not-an-id")).status).toBe(400);
  });

  it("is confined by site and requires a token", async () => {
    const id = await seedImage({ site: "shop" });
    expect((await record(id, blog)).status).toBe(403);
    expect((await record(id, shop)).status).toBe(200);
    expect((await record(id, admin)).status).toBe(200);
    expect((await record(id, null)).status).toBe(401);
  });
});

describe("DELETE /images/:id and restore", () => {
  it("soft-deletes (keeping object and row, idempotent) and restores", async () => {
    const { image } = await uploaded(png(7, 7, "soft"));
    const del = await body<ImageResponse>(await api("DELETE", `/images/${image.id}`));
    expect(del.image.deleted_at).toBeTypeOf("number");
    expect(await env.IMAGES.head(image.r2_key)).not.toBeNull();

    const again = await body<ImageResponse>(await api("DELETE", `/images/${image.id}`));
    expect(again.image.deleted_at).toBe(del.image.deleted_at);
    expect((await body<ImageResponse>(await record(image.id))).image.deleted_at).toBe(
      del.image.deleted_at,
    );

    const restored = await api("POST", `/images/${image.id}/restore`);
    expect((await body<ImageResponse>(restored)).image.deleted_at).toBeNull();
    expect((await api("POST", `/images/${image.id}/restore`)).status).toBe(200); // no-op when live
  });

  it.each([false, true])(
    "hard-deletes the object, row and tag links (after soft delete: %s)",
    async (soft) => {
      const { image } = await uploaded(png(9, 9, `hard${soft}`), { tags: ["gone"] });
      if (soft) await api("DELETE", `/images/${image.id}`);
      expect((await api("DELETE", `/images/${image.id}?hard=true`)).status).toBe(204);
      expect(await env.IMAGES.head(image.r2_key)).toBeNull();
      expect(await db.select().from(images).where(eq(images.id, image.id))).toHaveLength(0);
      expect(await db.select().from(imageTags).where(eq(imageTags.imageId, image.id))).toHaveLength(
        0,
      );
      expect((await record(image.id)).status).toBe(404);
    },
  );

  it("rejects missing images, bad ids and a bad hard flag", async () => {
    expect((await api("DELETE", "/images/01ARZ3NDEKTSV4RRFFQ69G5FAV")).status).toBe(404);
    expect(
      (await api("DELETE", `/images/${await seedImage({ site: "blog" })}?hard=yes`)).status,
    ).toBe(400);
  });

  it("denies cross-site and unauthenticated deletes and restores, leaving the image untouched", async () => {
    const { image } = await uploaded(png(4, 4, "protected"), { site: "shop" });
    for (const [method, path] of [
      ["DELETE", `/images/${image.id}`],
      ["DELETE", `/images/${image.id}?hard=true`],
      ["POST", `/images/${image.id}/restore`],
    ]) {
      expect(
        (await api(method as string, path as string, { auth: blog })).status,
        `${method} ${path}`,
      ).toBe(403);
      expect((await api(method as string, path as string, { auth: null })).status).toBe(401);
    }
    expect(await env.IMAGES.head(image.r2_key)).not.toBeNull();
    expect((await body<ImageResponse>(await record(image.id))).image.deleted_at).toBeNull();
  });
});
