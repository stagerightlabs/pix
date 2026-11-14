import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../src/app";

type Doc = ReturnType<typeof app.getOpenAPI31Document>;
const spec = async (e: Env = env) =>
  (await app.request("/openapi.json", {}, e)).json() as Promise<Doc>; // no auth header

describe("GET /openapi.json", () => {
  it("is public OpenAPI 3.1 pointing at the configured API host", async () => {
    const doc = await spec();
    expect([doc.openapi, doc.servers?.[0]?.url]).toEqual(["3.1.0", `https://${env.API_HOST}`]);
    const other = await spec({ ...env, API_HOST: "api.example.test" } as unknown as Env);
    expect(other.servers?.[0]?.url).toBe("https://api.example.test");
  });

  it("documents every route, each secured with bearer auth, a 401 response and a tag", async () => {
    const doc = await spec();
    const ops = Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
      Object.entries(item ?? {}).map(([method, op]) => ({
        label: `${method.toUpperCase()} ${path}`,
        path,
        op,
      })),
    );
    expect(ops.map((o) => o.label).sort()).toEqual(
      [
        "GET /health",
        "GET /v1/images",
        "POST /v1/images",
        "GET /v1/images/{id}",
        "PATCH /v1/images/{id}",
        "DELETE /v1/images/{id}",
        "POST /v1/images/{id}/restore",
        "GET /v1/sites",
        "POST /v1/sites",
        "GET /v1/tokens",
        "POST /v1/tokens",
        "DELETE /v1/tokens/{id}",
      ].sort(),
    );
    // The zone blocks URLs containing "/api/" at the edge, so no route may live under one.
    expect(ops.filter((o) => o.path.includes("/api/"))).toEqual([]);
    expect(doc.components?.securitySchemes?.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    for (const { label, op } of ops.filter((o) => o.path !== "/health")) {
      const o = op as { security?: object[]; responses: object; tags?: string[] };
      expect(
        o.security?.some((s) => "bearerAuth" in s),
        label,
      ).toBe(true);
      expect(Object.keys(o.responses), label).toContain("401");
      expect(o.tags?.length, label).toBeGreaterThan(0);
    }
  });

  it("describes the upload as multipart with a binary file field", async () => {
    const op = (await spec()).paths?.["/v1/images"]?.post;
    expect(JSON.stringify(op?.requestBody)).toMatch(/multipart\/form-data.*"format":"binary"/);
  });
});
