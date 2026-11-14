import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { pdf, png } from "./fixtures";
import { api, errorCode, seedImage, seedSite } from "./helpers";

const PUBLIC = "https://pix.stagerightlabs.com";
const API = "https://pix-api.stagerightlabs.com";
const get = (url: string, init?: RequestInit) => SELF.fetch(url, init);

/** An image with both a D1 row and an R2 object, as the upload route leaves it. */
async function stored(o: Parameters<typeof seedImage>[0] = { site: "blog" }) {
  const id = await seedImage(o);
  const key = `${o.site}/2023/${id}.png`;
  const bytes = png(8, 8, id);
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
  return { id, key, bytes };
}

const crossOrigin = {
  "access-control-allow-origin": "*",
  "cross-origin-resource-policy": "cross-origin",
  "x-content-type-options": "nosniff",
};

beforeAll(() => seedSite("blog"));

describe("public host: serving originals", () => {
  it("serves the bytes with cache, type and cross-origin headers, and no cookies", async () => {
    const { key, bytes } = await stored();
    const res = await get(`${PUBLIC}/${key}`);
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      ...crossOrigin,
      "content-type": "image/png",
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": String(bytes.byteLength),
    });
    expect(res.headers.get("etag")).toBeTruthy();
    expect(res.headers.has("set-cookie")).toBe(false);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it.each([
    ["", "inline"],
    ["?download", "attachment"],
  ])("serves a PDF with content-disposition for %j", async (query, disposition) => {
    const id = await seedImage({ site: "blog" });
    const key = `blog/2023/${id}.pdf`;
    await env.IMAGES.put(key, pdf(id), { httpMetadata: { contentType: "application/pdf" } });
    await env.DB.prepare("UPDATE images SET r2_key = ? WHERE id = ?").bind(key, id).run();
    const res = await get(`${PUBLIC}/${key}${query}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(disposition);
  });

  it("answers HEAD with the same headers and no body", async () => {
    const { key } = await stored();
    const [head, full] = await Promise.all([
      get(`${PUBLIC}/${key}`, { method: "HEAD" }),
      get(`${PUBLIC}/${key}`),
    ]);
    expect([head.status, await head.text()]).toEqual([200, ""]);
    for (const h of ["etag", "content-length", "content-type", "cache-control"]) {
      expect(head.headers.get(h)).toBe(full.headers.get(h));
    }
  });

  it("answers a matching If-None-Match with 304", async () => {
    const { key } = await stored();
    const etag = (await get(`${PUBLIC}/${key}`)).headers.get("etag") as string;
    const res = await get(`${PUBLIC}/${key}`, { headers: { "If-None-Match": etag } });
    expect([res.status, await res.text(), res.headers.get("etag")]).toEqual([304, "", etag]);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("returns 404 while soft-deleted and serves again once restored", async () => {
    const { id, key } = await stored();
    await api("DELETE", `/images/${id}`);
    const gone = await get(`${PUBLIC}/${key}`);
    expect([gone.status, await errorCode(gone)]).toEqual([404, "not_found"]);
    expect(gone.headers.get("cache-control")).toBe("no-store"); // so a restore shows up at once
    expect(gone.headers.get("access-control-allow-origin")).toBe("*");

    await api("POST", `/images/${id}/restore`);
    expect((await get(`${PUBLIC}/${key}`)).status).toBe(200);
  });

  it("serves only what D1 knows about", async () => {
    const orphan = await stored();
    await env.IMAGES.put("blog/2023/01ARZ3NDEKTSV4RRFFQ69G5FAV.png", png(1, 1, "orphan")); // object, no row
    const noObject = await seedImage({ site: "blog" }); // row, no object
    for (const key of ["blog/2023/01ARZ3NDEKTSV4RRFFQ69G5FAV.png", `blog/2023/${noObject}.png`]) {
      expect((await get(`${PUBLIC}/${key}`)).status, key).toBe(404);
    }
    expect((await get(`${PUBLIC}/${orphan.key}`)).status).toBe(200);
  });

  it.each([
    "/",
    "/blog",
    "/blog/2023/short.png",
    "/BLOG/2023/01ARZ3NDEKTSV4RRFFQ69G5FAV.png",
    "/blog/2023/01ARZ3NDEKTSV4RRFFQ69G5FAV.svg",
    "/blog/20x3/01ARZ3NDEKTSV4RRFFQ69G5FAV.png",
    "/../blog/2023/01ARZ3NDEKTSV4RRFFQ69G5FAV.png",
    "/cdn-cgi/image/width=1/blog/2023/01ARZ3NDEKTSV4RRFFQ69G5FAV.png",
  ])("returns 404 for the malformed key %s", async (path) => {
    expect((await get(`${PUBLIC}${path}`)).status).toBe(404);
  });

  it("allows only GET, HEAD and OPTIONS, and answers preflight", async () => {
    const { key } = await stored();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await get(`${PUBLIC}/${key}`, { method });
      expect([res.status, res.headers.get("allow")], method).toEqual([405, "GET, HEAD, OPTIONS"]);
    }
    expect((await get(`${PUBLIC}/${key}`)).status).toBe(200); // still there

    const preflight = await get(`${PUBLIC}/${key}`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
  });
});

describe("host separation", () => {
  it.each([
    [PUBLIC, "/health"],
    [PUBLIC, "/openapi.json"],
    [PUBLIC, "/v1/images"],
    [API, "/blog/2023/01ARZ3NDEKTSV4RRFFQ69G5FAV.png"],
    ["https://example.com", "/health"],
    ["https://pix.workers.dev", "/health"],
  ])("%s%s is not served", async (host, path) => {
    const res = await get(`${host}${path}`, {
      headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` },
    });
    expect([res.status, await errorCode(res)]).toEqual([404, "not_found"]);
  });

  it("does not serve an image through the API host even when it exists", async () => {
    const { key } = await stored();
    expect((await get(`${PUBLIC}/${key}`)).status).toBe(200);
    expect((await get(`${API}/${key}`)).status).toBe(404);
  });

  it("still serves the API and its public spec on the API host", async () => {
    expect((await get(`${API}/health`)).status).toBe(200);
    expect((await get(`${API}/openapi.json`)).status).toBe(200);
    expect((await get(`${API}/v1/images`)).status).toBe(401);
  });
});
