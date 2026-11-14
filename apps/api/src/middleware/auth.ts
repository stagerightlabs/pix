import { createMiddleware } from "hono/factory";
import { getDb } from "../db/client";
import { type AuthContext, authenticate, touchLastUsed } from "../lib/auth";

export type AppEnv = { Bindings: Env; Variables: { auth: AuthContext; requestId: string } };

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const auth = await authenticate(
    getDb(c.env.DB),
    c.env.ADMIN_TOKEN,
    c.req.header("Authorization"),
  );
  c.set("auth", auth);
  if (auth.tokenId) await touchLastUsed(getDb(c.env.DB), auth.tokenId);
  await next();
});
