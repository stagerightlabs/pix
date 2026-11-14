import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../middleware/auth";
import { errorBody } from "./errors";

/** An OpenAPIHono whose validation failures use the shared error shape. */
export function createRouter() {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const message = result.error.issues
          .map((i) => `${i.path.join(".") || "request"}: ${i.message}`)
          .join("; ");
        return c.json(errorBody("validation_error", message), 400);
      }
    },
  });
}
