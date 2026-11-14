import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { apiTokens } from "../src/db/schema";
import { createToken } from "../src/lib/auth";
import { api, db, errorCode, seedSite } from "./helpers";

describe("request id", () => {
  it("is returned on success and failure, and logged once per request", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const ok = await api("GET", "/sites");
    const bad = await api("GET", "/sites", { auth: null });
    expect(ok.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(bad.headers.get("X-Request-Id")).not.toBe(ok.headers.get("X-Request-Id"));
    const lines = log.mock.calls.map((c) => JSON.parse(String(c[0])));
    log.mockRestore();
    expect(lines).toMatchObject([
      { requestId: ok.headers.get("X-Request-Id"), method: "GET", path: "/v1/sites", status: 200 },
      { requestId: bad.headers.get("X-Request-Id"), status: 401 },
    ]);
  });
});

describe("last_used_at", () => {
  it("is set on first use, then left alone within the interval", async () => {
    await seedSite("lu");
    const { token, record } = await createToken(db, { name: "lu", siteId: "lu" });
    const lastUsed = async () =>
      (await db.select().from(apiTokens).where(eq(apiTokens.id, record.id)).get())?.lastUsedAt;

    expect(await lastUsed()).toBeNull();
    await api("GET", "/images", { auth: `Bearer ${token}` });
    const first = (await lastUsed()) ?? 0;
    expect(first).toBeGreaterThan(0);

    await db
      .update(apiTokens)
      .set({ lastUsedAt: first - 10 })
      .where(eq(apiTokens.id, record.id));
    await api("GET", "/images", { auth: `Bearer ${token}` });
    expect(await lastUsed()).toBe(first - 10); // recent enough: no write
  });
});

describe("rate limit", () => {
  it("answers 429 with Retry-After once the binding says no, before auth runs", async () => {
    let allowed = true;
    const limiter = { limit: async () => ({ success: allowed }) };
    const call = () =>
      app.request("/v1/sites", {}, { ...env, RATE_LIMITER: limiter } as unknown as typeof env);

    expect((await call()).status).toBe(401); // allowed through, then fails auth
    allowed = false;
    const res = await call();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await errorCode(res)).toBe("rate_limited");
  });
});

describe("internal errors", () => {
  it("return a generic body carrying the request id, and log the detail", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { ...env, DB: {} } as unknown as typeof env;
    const res = await app.request(
      "/v1/sites",
      { headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` } },
      broken,
    );
    const logged = String(err.mock.calls[0]?.[0]);
    err.mockRestore();
    const json = (await res.json()) as {
      error: { code: string; message: string; request_id: string };
    };
    expect(res.status).toBe(500);
    expect(json.error).toMatchObject({ code: "internal_error", message: "Internal server error" });
    expect(json.error.request_id).toBe(res.headers.get("X-Request-Id"));
    expect(logged).toContain(json.error.request_id);
  });
});
