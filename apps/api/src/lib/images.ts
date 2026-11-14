import { type Image, originalUrl } from "@pix/schema";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { images, imageTags, tags } from "../db/schema";

type ImageRow = typeof images.$inferSelect;

export function toImageDto(row: ImageRow, tagNames: string[], publicHost: string): Image {
  return {
    id: row.id,
    site_id: row.siteId,
    r2_key: row.r2Key,
    url: originalUrl(publicHost, row.r2Key),
    original_filename: row.originalFilename,
    content_type: row.contentType as Image["content_type"],
    size_bytes: row.sizeBytes,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    alt_text: row.altText,
    tags: tagNames,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    deleted_at: row.deletedAt,
  };
}

export async function getTagNames(db: Db, imageId: string): Promise<string[]> {
  const rows = await db
    .select({ name: tags.name })
    .from(imageTags)
    .innerJoin(tags, eq(imageTags.tagId, tags.id))
    .where(eq(imageTags.imageId, imageId))
    .orderBy(tags.name);
  return rows.map((r) => r.name);
}

export async function findImage(db: Db, id: string): Promise<ImageRow | undefined> {
  return db.select().from(images).where(eq(images.id, id)).get();
}

/** Lowercase, trim, drop empties and duplicates, and cap the length. */
export function normalizeTags(input: string[] | undefined, maxLength: number): string[] {
  const out = new Set<string>();
  for (const raw of input ?? []) {
    const t = raw.trim().toLowerCase();
    if (t) out.add(t.slice(0, maxLength));
  }
  return [...out].sort();
}
