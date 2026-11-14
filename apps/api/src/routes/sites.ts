import { createRoute } from "@hono/zod-openapi";
import {
  createSiteBodySchema,
  type Site,
  siteResponseSchema,
  sitesResponseSchema,
} from "@pix/schema";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { sites } from "../db/schema";
import { requireAdmin } from "../lib/auth";
import { ApiError } from "../lib/errors";
import { createRouter } from "../lib/router";
import { errorResponse, json, now, security } from "./common";

const tags = ["Sites"];

const toSite = (r: typeof sites.$inferSelect): Site => ({
  id: r.id,
  name: r.name,
  created_at: r.createdAt,
});

const listRoute = createRoute({
  method: "get",
  path: "/sites",
  summary: "List sites",
  description: "A site-scoped token sees only its own site.",
  security,
  tags,
  responses: {
    200: json(sitesResponseSchema, "Sites"),
    401: errorResponse("Unauthorized"),
  },
});

const createSiteRoute = createRoute({
  method: "post",
  path: "/sites",
  summary: "Create a site",
  description: "Admin only. The id is a slug that becomes the first segment of R2 keys.",
  security,
  tags,
  request: {
    body: { required: true, content: { "application/json": { schema: createSiteBodySchema } } },
  },
  responses: {
    201: json(siteResponseSchema, "Site created"),
    400: errorResponse("Invalid request"),
    401: errorResponse("Unauthorized"),
    403: errorResponse("Admin token required"),
    409: errorResponse("A site with this id already exists"),
  },
});

export const siteRoutes = createRouter();

siteRoutes.openapi(listRoute, async (c) => {
  const db = getDb(c.env.DB);
  const auth = c.var.auth;
  const rows =
    auth.kind === "site"
      ? await db.select().from(sites).where(eq(sites.id, auth.siteId))
      : await db.select().from(sites).orderBy(sites.id);
  return c.json({ sites: rows.map(toSite) }, 200);
});

siteRoutes.openapi(createSiteRoute, async (c) => {
  requireAdmin(c.var.auth);
  const body = c.req.valid("json");
  const db = getDb(c.env.DB);

  const row = { id: body.id, name: body.name, createdAt: now() };
  // The primary key makes this race-safe: a concurrent duplicate inserts nothing.
  const inserted = await db.insert(sites).values(row).onConflictDoNothing().returning();
  if (inserted.length === 0) {
    throw new ApiError(409, "site_exists", `Site "${body.id}" already exists`);
  }
  return c.json({ site: toSite(row) }, 201);
});
