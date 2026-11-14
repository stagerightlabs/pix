import { createRoute } from "@hono/zod-openapi";
import { healthResponseSchema } from "@pix/schema";
import { onError, onNotFound } from "./lib/errors";
import { createRouter } from "./lib/router";
import { authMiddleware } from "./middleware/auth";
import { rateLimit } from "./middleware/rateLimit";
import { requestId } from "./middleware/requestId";
import { imageRoutes } from "./routes/images";
import { siteRoutes } from "./routes/sites";
import { tokenRoutes } from "./routes/tokens";

export const app = createRouter();

app.use("*", requestId);
app.onError(onError);
app.notFound(onNotFound);

// Declared once; each authenticated route references it with `security: [{ bearerAuth: [] }]`.
app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  description: "API token, or the bootstrap admin token",
});

app.openapi(
  createRoute({
    method: "get",
    path: "/health",
    summary: "Liveness check",
    responses: {
      200: {
        description: "Service is up",
        content: { "application/json": { schema: healthResponseSchema } },
      },
    },
  }),
  (c) => c.json({ status: "ok" as const }, 200),
);

// Everything under the API base path requires a bearer token. The base path is /v1, not /api/v1:
// the stagerightlabs.com zone blocks any URL containing "/api/" before it reaches the Worker.
const api = createRouter();
api.use("*", rateLimit, authMiddleware);
api.route("/", imageRoutes);
api.route("/", siteRoutes);
api.route("/", tokenRoutes);
app.route("/v1", api);

// Public on purpose: the spec describes routes and holds no data. Registered after the routes it
// documents, and outside the authenticated base path like /health.
app.doc31("/openapi.json", (c) => ({
  openapi: "3.1.0",
  info: {
    title: "pix API",
    version: "1.0.0",
    description: "Management API for the pix image host.",
  },
  servers: [{ url: `https://${c.env.API_HOST}` }],
}));
