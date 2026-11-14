import type { z } from "@hono/zod-openapi";
import { errorSchema } from "@pix/schema";

export const security = [{ bearerAuth: [] }];

export const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: errorSchema } },
});

export const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

export const now = () => Math.floor(Date.now() / 1000);
