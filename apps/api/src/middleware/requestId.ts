import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./auth";

/**
 * Tags every request with an id (echoed in `X-Request-Id`, so a failing call can be matched to a log
 * line) and writes one structured log line per request.
 */
export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  const id = crypto.randomUUID();
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  const start = Date.now();
  await next();
  console.log(
    JSON.stringify({
      requestId: id,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      ms: Date.now() - start,
      tokenId: c.var.auth?.tokenId ?? null,
    }),
  );
});
