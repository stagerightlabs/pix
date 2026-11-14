import { createMiddleware } from "hono/factory";
import { ApiError } from "../lib/errors";
import type { AppEnv } from "./auth";

/**
 * Per-client-IP limit, applied before authentication so it also slows token guessing. Uses the
 * Workers rate-limiting binding (`RATE_LIMITER`, configured in wrangler.jsonc); without the binding
 * it does nothing, so local setups keep working.
 */
export const rateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const limiter = c.env.RATE_LIMITER;
  if (limiter) {
    const { success } = await limiter.limit({ key: c.req.header("CF-Connecting-IP") ?? "unknown" });
    if (!success) {
      c.header("Retry-After", "60");
      throw new ApiError(429, "rate_limited", "Too many requests; slow down");
    }
  }
  await next();
});
