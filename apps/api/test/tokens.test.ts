import { env } from "cloudflare:workers";
import type { CreatedTokenResponse, TokenResponse, TokensResponse } from "@pix/schema";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { apiTokens } from "../src/db/schema";
import { hashToken } from "../src/lib/auth";
import { api, body, db, errorCode, seedSite, siteAuth } from "./helpers";

let blog: string;

beforeAll(async () => {
  await seedSite("blog");
  blog = await siteAuth("blog");
});

const create = async (data: unknown) =>
  body<CreatedTokenResponse>(await api("POST", "/tokens", { body: data }));
const use = (secret: string, method: string, path: string, data?: unknown) =>
  api(method, path, { auth: `Bearer ${secret}`, body: data });

describe("tokens", () => {
  it("creates admin and site-scoped tokens whose secrets work, and stores only the hash", async () => {
    const adminToken = await create({ name: "ci" });
    expect(adminToken.token).toMatchObject({ site_id: null, revoked_at: null, last_used_at: null });
    expect(adminToken.secret).toMatch(/^pix_/);
    expect(
      (await use(adminToken.secret, "POST", "/sites", { id: "viaadmin", name: "N" })).status,
    ).toBe(201);

    const scoped = await create({ name: "blog-ci", site_id: "blog" });
    expect(scoped.token.site_id).toBe("blog");
    expect((await use(scoped.secret, "GET", "/images")).status).toBe(200);
    expect((await use(scoped.secret, "POST", "/sites", { id: "z", name: "Z" })).status).toBe(403);

    const row = await db.select().from(apiTokens).where(eq(apiTokens.id, scoped.token.id)).get();
    expect(row?.tokenHash).toBe(await hashToken(scoped.secret));
    expect(JSON.stringify(row)).not.toContain(scoped.secret);
  });

  it("rejects an unknown site and invalid bodies", async () => {
    const missing = await api("POST", "/tokens", { body: { name: "x", site_id: "nope" } });
    expect([missing.status, await errorCode(missing)]).toEqual([404, "site_not_found"]);
    for (const data of [{}, { name: "x", site_id: "Bad Slug" }]) {
      expect((await api("POST", "/tokens", { body: data })).status).toBe(400);
    }
  });

  it("lists tokens, including revoked ones, without hashes or secrets", async () => {
    const { token, secret } = await create({ name: "listed" });
    await api("DELETE", `/tokens/${token.id}`);
    const res = await api("GET", "/tokens");
    const text = await res.text();
    const listed = (JSON.parse(text) as TokensResponse).tokens.find((t) => t.id === token.id);
    expect(listed?.revoked_at).toBeTypeOf("number");
    for (const secretValue of [secret, await hashToken(secret), env.ADMIN_TOKEN]) {
      expect(text).not.toContain(secretValue);
    }
    expect(text).not.toMatch(/token_hash|tokenHash/);
  });

  it("revokes immediately, idempotently, and rejects unknown or malformed ids", async () => {
    const { token, secret } = await create({ name: "short-lived" });
    expect((await use(secret, "GET", "/sites")).status).toBe(200);

    const first = await body<TokenResponse>(await api("DELETE", `/tokens/${token.id}`));
    const second = await body<TokenResponse>(await api("DELETE", `/tokens/${token.id}`));
    expect(second.token.revoked_at).toBe(first.token.revoked_at);

    const after = await use(secret, "GET", "/sites");
    expect([after.status, await errorCode(after)]).toEqual([401, "token_revoked"]);

    const missing = await api("DELETE", "/tokens/01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect([missing.status, await errorCode(missing)]).toEqual([404, "token_not_found"]);
    expect((await api("DELETE", "/tokens/bad")).status).toBe(400);
  });

  it.each([
    ["GET", "/tokens"],
    ["POST", "/tokens"],
    ["DELETE", "/tokens/01ARZ3NDEKTSV4RRFFQ69G5FAV"],
  ])("%s %s is admin only", async (method, path) => {
    const data = method === "POST" ? { name: "escalate" } : undefined;
    const denied = await api(method, path, { auth: blog, body: data });
    expect([denied.status, await errorCode(denied)]).toEqual([403, "forbidden"]);
    expect((await api(method, path, { auth: null, body: data })).status).toBe(401);
  });
});
