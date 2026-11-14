import { DOWNLOAD_PARAM } from "@pix/schema";
import { eq } from "drizzle-orm";
import { getDb } from "./db/client";
import { images } from "./db/schema";
import { errorBody } from "./lib/errors";

/** `{site}/{yyyy}/{ulid}.{ext}`: the only shape of key we ever create. Anything else is a 404. */
const KEY =
  /^[a-z0-9][a-z0-9-]{0,39}\/\d{4}\/[0-9A-HJKMNP-TV-Z]{26}\.(?:jpg|png|webp|avif|gif|pdf)$/;

/** On every public response, so canvas/fetch use and `COEP: require-corp` pages both work. */
const CROSS_ORIGIN = {
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Content-Type-Options": "nosniff",
};

function notFound(): Response {
  // no-store, so an image that is restored shows up again straight away.
  return Response.json(errorBody("not_found", "Not found"), {
    status: 404,
    headers: { ...CROSS_ORIGIN, "Cache-Control": "no-store" },
  });
}

/**
 * Serves originals from R2 at `/{r2_key}`. Only images that have a live (not soft-deleted) row in D1
 * are served, so a soft delete takes effect on the next request that is not already cached.
 * Never sets cookies. Transformations (`/cdn-cgi/image/...`) are handled by Cloudflare in front of
 * this Worker, which sees only the resulting source-image request.
 */
export async function handlePublic(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...CROSS_ORIGIN,
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "If-None-Match, If-Modified-Since",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { ...CROSS_ORIGIN, Allow: "GET, HEAD, OPTIONS" },
    });
  }

  const url = new URL(request.url);
  const key = url.pathname.slice(1);
  if (!KEY.test(key)) return notFound();

  const row = await getDb(env.DB)
    .select({ deletedAt: images.deletedAt })
    .from(images)
    .where(eq(images.r2Key, key))
    .get();
  if (!row || row.deletedAt !== null) return notFound(); // unknown or soft-deleted

  const object =
    request.method === "HEAD"
      ? await env.IMAGES.head(key)
      : await env.IMAGES.get(key, { onlyIf: request.headers });
  if (!object) return notFound();

  const headers = new Headers(CROSS_ORIGIN);
  headers.set("Cache-Control", "public, max-age=31536000, immutable"); // keys never change
  headers.set("ETag", object.httpEtag);
  if (object.httpMetadata?.contentType) {
    headers.set("Content-Type", object.httpMetadata.contentType);
  }

  if (url.searchParams.has(DOWNLOAD_PARAM)) {
    headers.set("Content-Disposition", "attachment");
  } else if (object.httpMetadata?.contentType === "application/pdf") {
    headers.set("Content-Disposition", "inline");
  }

  if (request.method === "HEAD") {
    headers.set("Content-Length", String(object.size));
    return new Response(null, { headers });
  }

  // `get` with `onlyIf` returns the object without a body when a precondition fails.
  if (!("body" in object)) return new Response(null, { status: 304, headers });

  headers.set("Content-Length", String(object.size));
  return new Response((object as R2ObjectBody).body, { headers });
}
