import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Consistent error shape: { "error": { "code": "...", "message": "..." } } */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export function onError(err: Error, c: Context) {
  if (err instanceof ApiError) {
    return c.json(errorBody(err.code, err.message), err.status);
  }
  const requestId: string | undefined = c.get("requestId");
  console.error(JSON.stringify({ requestId, error: String(err), stack: err.stack }));
  return c.json(
    {
      error: {
        ...errorBody("internal_error", "Internal server error").error,
        request_id: requestId,
      },
    },
    500,
  );
}

export function onNotFound(c: Context) {
  return c.json(errorBody("not_found", "Not found"), 404);
}
