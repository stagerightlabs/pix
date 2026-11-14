import { createMiddleware } from "hono/factory";
import { ApiError, errorBody } from "../lib/errors";
import type { AppEnv } from "./auth";

/** Allowance for multipart boundaries and the small text fields around the file. */
const OVERHEAD_BYTES = 64 * 1024;

export function maxUploadBytes(env: Env): number {
  const n = Number(env.MAX_UPLOAD_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 25 * 1024 * 1024;
}

const tooLarge = (max: number) =>
  new ApiError(413, "payload_too_large", `Upload exceeds the ${max} byte limit`);

/**
 * Rejects oversize uploads early from Content-Length, then enforces the limit while the body is
 * read, because Content-Length can be absent or wrong.
 */
export const uploadLimit = createMiddleware<AppEnv>(async (c, next) => {
  const max = maxUploadBytes(c.env);
  const limit = max + OVERHEAD_BYTES;

  const declared = Number(c.req.header("Content-Length"));
  if (Number.isFinite(declared) && declared > limit) throw tooLarge(max);

  let exceeded = false;
  const body = c.req.raw.body;
  if (body) {
    let seen = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) {
          exceeded = true;
          controller.error(tooLarge(max));
          return;
        }
        controller.enqueue(chunk);
      },
    });
    c.req.raw = new Request(c.req.raw, { body: body.pipeThrough(counter) });
  }

  await next();

  // A body that blows the limit surfaces as a parse failure downstream; report it as 413.
  if (exceeded) c.res = c.json(errorBody("payload_too_large", tooLarge(max).message), 413);
});
