import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app";
import { apiTokens } from "../src/db/schema";
import { assertSiteAccess, createToken, hashToken, requireAdmin } from "../src/lib/auth";
import { onError } from "../src/lib/errors";
import { sha256Hex } from "../src/lib/hash";
import { type AppEnv, authMiddleware } from "../src/middleware/auth";
import { body, db, errorCode, seedSite } from "./helpers";

// A tiny app that exercises the middleware and the scoping helpers.
const probe = new Hono<AppEnv>();
probe.onError(onError);
probe.use("*", authMiddleware);
probe.get("/whoami", (c) => c.json(c.var.auth));
probe.get("/admin", (c) => {
  requireAdmin(c.var.auth);
  return c.json({ ok: true });
});
probe.get("/sites/:id", (c) => {
  assertSiteAccess(c.var.auth, c.req.param("id"));
  return c.json({ ok: true });
});

const call = (path: string, authorization?: string) =>
  probe.request(path, { headers: authorization ? { Authorization: authorization } : {} }, env);
const bearer = (token: string) => `Bearer ${token}`;

let blog: string;
let adminDb: string;
let revoked: string;

beforeAll(async () => {
  await seedSite("blog");
  blog = (await createToken(db, { name: "blog", siteId: "blog" })).token;
  adminDb = (await createToken(db, { name: "admin", siteId: null })).token;
  const old = await createToken(db, { name: "old", siteId: "blog" });
  revoked = old.token;
  await db.update(apiTokens).set({ revokedAt: 1 }).where(eq(apiTokens.id, old.record.id));
});

describe("authentication", () => {
  it.each([undefined, "Basic abc", "Bearer", "Bearer a b", "Bearer pix_unknown"])(
    "rejects the credentials %j",
    async (header) => {
      const res = await call("/whoami", header);
      expect([res.status, await errorCode(res)]).toEqual([401, "unauthorized"]);
    },
  );

  it("accepts the bootstrap secret, an admin database token, and a site token", async () => {
    const who = async (token: string) => body(await call("/whoami", bearer(token)));
    expect(await who(env.ADMIN_TOKEN)).toEqual({ kind: "admin", tokenId: null });
    expect(await who(adminDb)).toMatchObject({ kind: "admin" });
    expect(await who(blog)).toMatchObject({ kind: "site", siteId: "blog" });
  });

  it("rejects a revoked token as token_revoked", async () => {
    const res = await call("/whoami", bearer(revoked));
    expect([res.status, await errorCode(res)]).toEqual([401, "token_revoked"]);
  });

  it("stores only the SHA-256 hash, never the plaintext", async () => {
    const rows = await db.select().from(apiTokens).all();
    expect(rows.map((r) => r.tokenHash)).toContain(await sha256Hex(blog));
    expect(await hashToken(blog)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(blog);
  });
});

describe("authorization", () => {
  it.each([
    ["/sites/blog", () => blog, 200],
    ["/sites/shop", () => blog, 403], // a site token cannot reach another site
    ["/sites/shop", () => env.ADMIN_TOKEN, 200],
    ["/sites/shop", () => adminDb, 200],
    ["/admin", () => env.ADMIN_TOKEN, 200],
    ["/admin", () => adminDb, 200],
    ["/admin", () => blog, 403], // a site token cannot use admin routes
  ])("%s as %#", async (path, token, status) => {
    const res = await call(path, bearer(token()));
    expect(res.status).toBe(status);
    if (status === 403) expect(await errorCode(res)).toBe("forbidden");
  });
});

describe("app wiring", () => {
  it("keeps /health public, protects /v1, and uses the not_found shape when authorized", async () => {
    expect((await app.request("/health", {}, env)).status).toBe(200);
    expect((await app.request("/v1/anything", {}, env)).status).toBe(401);
    const res = await app.request(
      "/v1/anything",
      { headers: { Authorization: bearer(env.ADMIN_TOKEN) } },
      env,
    );
    expect([res.status, await body(res)]).toEqual([
      404,
      { error: { code: "not_found", message: "Not found" } },
    ]);
  });
});
