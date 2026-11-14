import { createRoute, z } from "@hono/zod-openapi";
import {
  createdTokenResponseSchema,
  createTokenBodySchema,
  type Token,
  tokenResponseSchema,
  tokensResponseSchema,
  ulidSchema,
} from "@pix/schema";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { apiTokens, sites } from "../db/schema";
import { createToken, requireAdmin } from "../lib/auth";
import { ApiError } from "../lib/errors";
import { createRouter } from "../lib/router";
import { errorResponse, json, now, security } from "./common";

const tags = ["Tokens"];

/** Never includes the hash. */
const toToken = (r: typeof apiTokens.$inferSelect): Token => ({
  id: r.id,
  name: r.name,
  site_id: r.siteId,
  created_at: r.createdAt,
  last_used_at: r.lastUsedAt,
  revoked_at: r.revokedAt,
});

const idParam = z.object({ id: ulidSchema.openapi({ param: { name: "id", in: "path" } }) });

const listRoute = createRoute({
  method: "get",
  path: "/tokens",
  summary: "List tokens",
  description: "Admin only. Revoked tokens are included, with `revoked_at` set.",
  security,
  tags,
  responses: {
    200: json(tokensResponseSchema, "Tokens"),
    401: errorResponse("Unauthorized"),
    403: errorResponse("Admin token required"),
  },
});

const createTokenRoute = createRoute({
  method: "post",
  path: "/tokens",
  summary: "Create a token",
  description:
    "Admin only. Omit `site_id` (or send null) for an admin token. The plaintext `secret` is " +
    "returned once and cannot be retrieved again.",
  security,
  tags,
  request: {
    body: { required: true, content: { "application/json": { schema: createTokenBodySchema } } },
  },
  responses: {
    201: json(createdTokenResponseSchema, "Token created"),
    400: errorResponse("Invalid request"),
    401: errorResponse("Unauthorized"),
    403: errorResponse("Admin token required"),
    404: errorResponse("Site not found"),
  },
});

const revokeRoute = createRoute({
  method: "delete",
  path: "/tokens/{id}",
  summary: "Revoke a token",
  description: "Admin only. Idempotent. A revoked token is rejected immediately.",
  security,
  tags,
  request: { params: idParam },
  responses: {
    200: json(tokenResponseSchema, "The revoked token"),
    401: errorResponse("Unauthorized"),
    403: errorResponse("Admin token required"),
    404: errorResponse("Token not found"),
  },
});

export const tokenRoutes = createRouter();

tokenRoutes.openapi(listRoute, async (c) => {
  requireAdmin(c.var.auth);
  const rows = await getDb(c.env.DB).select().from(apiTokens).orderBy(apiTokens.id);
  return c.json({ tokens: rows.map(toToken) }, 200);
});

tokenRoutes.openapi(createTokenRoute, async (c) => {
  requireAdmin(c.var.auth);
  const body = c.req.valid("json");
  const db = getDb(c.env.DB);

  const siteId = body.site_id ?? null;
  if (siteId !== null) {
    const site = await db.select().from(sites).where(eq(sites.id, siteId)).get();
    if (!site) throw new ApiError(404, "site_not_found", `Site "${siteId}" does not exist`);
  }

  const { token, record } = await createToken(db, { name: body.name, siteId });
  return c.json(
    {
      token: toToken({ ...record, lastUsedAt: null, revokedAt: null }),
      secret: token,
    },
    201,
  );
});

tokenRoutes.openapi(revokeRoute, async (c) => {
  requireAdmin(c.var.auth);
  const db = getDb(c.env.DB);
  const { id } = c.req.valid("param");

  const row = await db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
  if (!row) throw new ApiError(404, "token_not_found", "Token not found");

  if (row.revokedAt !== null) return c.json({ token: toToken(row) }, 200);
  const revokedAt = now();
  await db.update(apiTokens).set({ revokedAt }).where(eq(apiTokens.id, id));
  return c.json({ token: toToken({ ...row, revokedAt }) }, 200);
});
