import { createRoute, z } from "@hono/zod-openapi";
import {
  ALLOWED_CONTENT_TYPES,
  deleteQuerySchema,
  imageIdSchema,
  imageResponseSchema,
  listQuerySchema,
  listResponseSchema,
  MAX_TAG_LENGTH,
  patchBodySchema,
  uploadFieldsSchema,
  uploadResponseSchema,
} from "@pix/schema";
import { and, desc, eq, exists, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { ulid } from "ulid";
import { getDb } from "../db/client";
import { images, imageTags, sites, tags } from "../db/schema";
import { assertSiteAccess } from "../lib/auth";
import { ApiError } from "../lib/errors";
import { sha256Hex } from "../lib/hash";
import { detectImageType, getDimensions } from "../lib/image";
import { findImage, getTagNames, normalizeTags, toImageDto } from "../lib/images";
import { buildR2Key } from "../lib/keys";
import { createRouter } from "../lib/router";
import { maxUploadBytes, uploadLimit } from "../middleware/uploadLimit";
import { errorResponse, json, now, security } from "./common";

const tag = ["Images"];

const idParam = z.object({ id: imageIdSchema.openapi({ param: { name: "id", in: "path" } }) });

const uploadForm = uploadFieldsSchema.extend({
  file: z
    .instanceof(File)
    .openapi({ type: "string", format: "binary", description: "JPEG, PNG, WebP, AVIF or GIF" }),
});

const uploadRoute = createRoute({
  method: "post",
  path: "/images",
  summary: "Upload an image",
  description:
    "Multipart upload. If the same file (by SHA-256) already exists for the site, the existing " +
    "record is returned with 200 and `duplicate: true`. A soft-deleted duplicate is restored.",
  security,
  tags: tag,
  middleware: [uploadLimit],
  request: { body: { required: true, content: { "multipart/form-data": { schema: uploadForm } } } },
  responses: {
    201: json(uploadResponseSchema, "Image created"),
    200: json(uploadResponseSchema, "Duplicate: existing image returned"),
    400: errorResponse("Invalid request"),
    401: errorResponse("Unauthorized"),
    403: errorResponse("Token cannot access this site"),
    404: errorResponse("Site not found"),
    413: errorResponse("Upload too large"),
    415: errorResponse("Unsupported file type"),
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/images/{id}",
  summary: "Get an image record",
  description: "Includes soft-deleted images (see `deleted_at`).",
  security,
  tags: tag,
  request: { params: idParam },
  responses: {
    200: json(imageResponseSchema, "The image"),
    401: errorResponse("Unauthorized"),
    403: errorResponse("Token cannot access this site"),
    404: errorResponse("Image not found"),
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/images/{id}",
  summary: "Delete an image",
  description:
    "Soft delete by default (public serving then returns 404). `?hard=true` permanently removes " +
    "the R2 object and the record.",
  security,
  tags: tag,
  request: { params: idParam, query: deleteQuerySchema },
  responses: {
    200: json(imageResponseSchema, "Soft-deleted image"),
    204: { description: "Permanently deleted" },
    401: errorResponse("Unauthorized"),
    403: errorResponse("Token cannot access this site"),
    404: errorResponse("Image not found"),
  },
});

const restoreRoute = createRoute({
  method: "post",
  path: "/images/{id}/restore",
  summary: "Restore a soft-deleted image",
  security,
  tags: tag,
  request: { params: idParam },
  responses: {
    200: json(imageResponseSchema, "The restored image"),
    401: errorResponse("Unauthorized"),
    403: errorResponse("Token cannot access this site"),
    404: errorResponse("Image not found"),
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/images",
  summary: "List images",
  description:
    "Newest first, cursor-paginated on the image id. Pass the previous response's `next_cursor` " +
    "as `cursor`. A site-scoped token only ever sees its own site. `q` matches the original " +
    "filename or alt text. Soft-deleted images are excluded unless `deleted` says otherwise.",
  security,
  tags: tag,
  request: { query: listQuerySchema },
  responses: {
    200: json(listResponseSchema, "A page of images"),
    400: errorResponse("Invalid query"),
    401: errorResponse("Unauthorized"),
    403: errorResponse("Token cannot access this site"),
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/images/{id}",
  summary: "Update alt text and tags",
  description:
    "`alt_text: null` clears it. Tags are added or removed by name, created on first use, and " +
    "a name cannot be in both lists.",
  security,
  tags: tag,
  request: {
    params: idParam,
    body: { required: true, content: { "application/json": { schema: patchBodySchema } } },
  },
  responses: {
    200: json(imageResponseSchema, "The updated image"),
    400: errorResponse("Invalid request"),
    401: errorResponse("Unauthorized"),
    403: errorResponse("Token cannot access this site"),
    404: errorResponse("Image not found"),
  },
});

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(`${err.message} ${err.cause}`);
}

export const imageRoutes = createRouter();

imageRoutes.openapi(uploadRoute, async (c) => {
  const form = c.req.valid("form");
  const db = getDb(c.env.DB);
  const auth = c.var.auth;

  assertSiteAccess(auth, form.site);
  const site = await db.select().from(sites).where(eq(sites.id, form.site)).get();
  if (!site) throw new ApiError(404, "site_not_found", `Site "${form.site}" does not exist`);

  const max = maxUploadBytes(c.env);
  if (form.file.size === 0) throw new ApiError(400, "empty_file", "The file is empty");
  if (form.file.size > max) {
    throw new ApiError(413, "payload_too_large", `Upload exceeds the ${max} byte limit`);
  }

  const buffer = await form.file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const contentType = detectImageType(bytes);
  if (!contentType) {
    throw new ApiError(
      415,
      "unsupported_media_type",
      `Unsupported file type. Allowed: ${ALLOWED_CONTENT_TYPES.join(", ")}`,
    );
  }

  const sha256 = await sha256Hex(buffer);
  const existing = await db
    .select()
    .from(images)
    .where(and(eq(images.siteId, site.id), eq(images.sha256, sha256)))
    .get();
  if (existing) {
    let row = existing;
    if (existing.deletedAt !== null) {
      row = { ...existing, deletedAt: null, updatedAt: now() };
      await db
        .update(images)
        .set({ deletedAt: null, updatedAt: row.updatedAt })
        .where(eq(images.id, existing.id));
    }
    return c.json(
      { image: toImageDto(row, await getTagNames(db, row.id), c.env.PUBLIC_HOST), duplicate: true },
      200,
    );
  }

  const id = ulid();
  const created = new Date();
  const r2Key = buildR2Key(site.id, id, contentType, created);
  const dims = getDimensions(bytes, contentType);
  const tagNames = normalizeTags(form["tags[]"], MAX_TAG_LENGTH);
  const ts = Math.floor(created.getTime() / 1000);
  const row = {
    id,
    siteId: site.id,
    r2Key,
    originalFilename: form.file.name || "upload",
    contentType,
    sizeBytes: buffer.byteLength,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    sha256,
    altText: form.alt_text ?? null,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
  };

  await c.env.IMAGES.put(r2Key, buffer, { httpMetadata: { contentType }, sha256 });

  try {
    // One D1 batch is atomic: the image, its tags, and the links either all land or none do.
    const tagInserts = tagNames.map((name) =>
      db.insert(tags).values({ id: ulid(), siteId: site.id, name }).onConflictDoNothing(),
    );
    const link = tagNames.length
      ? [
          db.insert(imageTags).select(
            db
              .select({ imageId: sql<string>`${id}`.as("image_id"), tagId: tags.id })
              .from(tags)
              .where(and(eq(tags.siteId, site.id), inArray(tags.name, tagNames))),
          ),
        ]
      : [];
    await db.batch([db.insert(images).values(row), ...tagInserts, ...link]);
  } catch (err) {
    await c.env.IMAGES.delete(r2Key); // never leave an orphaned object behind
    if (isUniqueViolation(err)) {
      // A concurrent upload of the same file won the race; return its record.
      const winner = await db
        .select()
        .from(images)
        .where(and(eq(images.siteId, site.id), eq(images.sha256, sha256)))
        .get();
      if (winner) {
        return c.json(
          {
            image: toImageDto(winner, await getTagNames(db, winner.id), c.env.PUBLIC_HOST),
            duplicate: true,
          },
          200,
        );
      }
    }
    throw err;
  }

  return c.json({ image: toImageDto(row, tagNames, c.env.PUBLIC_HOST), duplicate: false }, 201);
});

async function loadAuthorized(
  c: { env: Env; var: { auth: import("../lib/auth").AuthContext } },
  id: string,
) {
  const db = getDb(c.env.DB);
  const row = await findImage(db, id);
  if (!row) throw new ApiError(404, "image_not_found", "Image not found");
  assertSiteAccess(c.var.auth, row.siteId);
  return { db, row };
}

imageRoutes.openapi(getRoute, async (c) => {
  const { db, row } = await loadAuthorized(c, c.req.valid("param").id);
  return c.json({ image: toImageDto(row, await getTagNames(db, row.id), c.env.PUBLIC_HOST) }, 200);
});

imageRoutes.openapi(deleteRoute, async (c) => {
  const { db, row } = await loadAuthorized(c, c.req.valid("param").id);

  if (c.req.valid("query").hard === "true") {
    // R2 first: deleting an absent object is a no-op, so a failed D1 step can simply be retried.
    await c.env.IMAGES.delete(row.r2Key);
    await db.batch([
      db.delete(imageTags).where(eq(imageTags.imageId, row.id)),
      db.delete(images).where(eq(images.id, row.id)),
    ]);
    return c.body(null, 204);
  }

  const updated = row.deletedAt === null ? { ...row, deletedAt: now(), updatedAt: now() } : row;
  if (updated !== row) {
    await db
      .update(images)
      .set({ deletedAt: updated.deletedAt, updatedAt: updated.updatedAt })
      .where(eq(images.id, row.id));
  }
  return c.json(
    { image: toImageDto(updated, await getTagNames(db, row.id), c.env.PUBLIC_HOST) },
    200,
  );
});

imageRoutes.openapi(restoreRoute, async (c) => {
  const { db, row } = await loadAuthorized(c, c.req.valid("param").id);
  const updated = row.deletedAt === null ? row : { ...row, deletedAt: null, updatedAt: now() };
  if (updated !== row) {
    await db
      .update(images)
      .set({ deletedAt: null, updatedAt: updated.updatedAt })
      .where(eq(images.id, row.id));
  }
  return c.json(
    { image: toImageDto(updated, await getTagNames(db, row.id), c.env.PUBLIC_HOST) },
    200,
  );
});

/** Escapes LIKE wildcards so a search for "50%" matches literally. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

imageRoutes.openapi(listRoute, async (c) => {
  const query = c.req.valid("query");
  const auth = c.var.auth;
  const db = getDb(c.env.DB);

  // A site-scoped token is pinned to its site; naming another one is an error.
  if (query.site !== undefined) assertSiteAccess(auth, query.site);
  const site = auth.kind === "site" ? auth.siteId : query.site;

  const filters = [
    site !== undefined ? eq(images.siteId, site) : undefined,
    query.deleted === "exclude" ? isNull(images.deletedAt) : undefined,
    query.deleted === "only" ? isNotNull(images.deletedAt) : undefined,
    query.cursor ? lt(images.id, query.cursor) : undefined,
    query.tag
      ? exists(
          db
            .select({ one: sql`1` })
            .from(imageTags)
            .innerJoin(tags, eq(imageTags.tagId, tags.id))
            .where(
              and(eq(imageTags.imageId, images.id), eq(tags.name, query.tag.trim().toLowerCase())),
            ),
        )
      : undefined,
    query.q
      ? or(
          sql`${images.originalFilename} LIKE ${likePattern(query.q)} ESCAPE '\\'`,
          sql`${images.altText} LIKE ${likePattern(query.q)} ESCAPE '\\'`,
        )
      : undefined,
  ];

  // Fetch one extra row to learn whether another page exists.
  const rows = await db
    .select()
    .from(images)
    .where(and(...filters))
    .orderBy(desc(images.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);

  const tagsByImage = new Map<string, string[]>();
  if (page.length > 0) {
    const links = await db
      .select({ imageId: imageTags.imageId, name: tags.name })
      .from(imageTags)
      .innerJoin(tags, eq(imageTags.tagId, tags.id))
      .where(
        inArray(
          imageTags.imageId,
          page.map((r) => r.id),
        ),
      )
      .orderBy(tags.name);
    for (const l of links)
      tagsByImage.set(l.imageId, [...(tagsByImage.get(l.imageId) ?? []), l.name]);
  }

  return c.json(
    {
      images: page.map((r) => toImageDto(r, tagsByImage.get(r.id) ?? [], c.env.PUBLIC_HOST)),
      next_cursor: rows.length > query.limit && last ? last.id : null,
    },
    200,
  );
});

imageRoutes.openapi(patchRoute, async (c) => {
  const { db, row } = await loadAuthorized(c, c.req.valid("param").id);
  const body = c.req.valid("json");
  const add = normalizeTags(body.add_tags, MAX_TAG_LENGTH);
  const remove = normalizeTags(body.remove_tags, MAX_TAG_LENGTH);

  const both = add.filter((t) => remove.includes(t));
  if (both.length > 0) {
    throw new ApiError(
      400,
      "validation_error",
      `Cannot add and remove the same tag: ${both.join(", ")}`,
    );
  }

  const alt = body.alt_text === undefined ? {} : { altText: body.alt_text };
  const statements: BatchItem<"sqlite">[] = [
    db
      .update(images)
      .set({ ...alt, updatedAt: now() })
      .where(eq(images.id, row.id)),
    ...add.map((name) =>
      db.insert(tags).values({ id: ulid(), siteId: row.siteId, name }).onConflictDoNothing(),
    ),
  ];
  if (add.length > 0) {
    statements.push(
      db
        .insert(imageTags)
        .select(
          db
            .select({ imageId: sql<string>`${row.id}`.as("image_id"), tagId: tags.id })
            .from(tags)
            .where(and(eq(tags.siteId, row.siteId), inArray(tags.name, add))),
        )
        .onConflictDoNothing(),
    );
  }
  if (remove.length > 0) {
    statements.push(
      db.delete(imageTags).where(
        and(
          eq(imageTags.imageId, row.id),
          inArray(
            imageTags.tagId,
            db
              .select({ id: tags.id })
              .from(tags)
              .where(and(eq(tags.siteId, row.siteId), inArray(tags.name, remove))),
          ),
        ),
      ),
    );
  }
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

  const updated = await findImage(db, row.id);
  if (!updated) throw new ApiError(404, "image_not_found", "Image not found");
  return c.json(
    { image: toImageDto(updated, await getTagNames(db, row.id), c.env.PUBLIC_HOST) },
    200,
  );
});
