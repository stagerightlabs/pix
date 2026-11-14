import { z } from "zod";

export const healthResponseSchema = z.object({ status: z.literal("ok") });
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Every error response uses this shape. */
export const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiErrorBody = z.infer<typeof errorSchema>;

export const ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
] as const;
export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

export const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "Invalid id");
export const imageIdSchema = ulidSchema;

export const imageSchema = z.object({
  id: z.string(),
  site_id: z.string(),
  r2_key: z.string(),
  url: z.string().url(),
  original_filename: z.string(),
  content_type: z.enum(ALLOWED_CONTENT_TYPES),
  size_bytes: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  sha256: z.string(),
  alt_text: z.string().nullable(),
  tags: z.array(z.string()),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  deleted_at: z.number().int().nullable(),
});
export type Image = z.infer<typeof imageSchema>;

export const imageResponseSchema = z.object({ image: imageSchema });
export type ImageResponse = z.infer<typeof imageResponseSchema>;

/** `duplicate` is true when the (site, sha256) already existed and the existing record was returned. */
export const uploadResponseSchema = z.object({ image: imageSchema, duplicate: z.boolean() });
export type UploadResponse = z.infer<typeof uploadResponseSchema>;

export const MAX_TAGS_PER_IMAGE = 20;
export const MAX_TAG_LENGTH = 64;

/** Fields of the multipart upload, other than the `file` part. */
export const uploadFieldsSchema = z.object({
  site: z.string().min(1),
  "tags[]": z.array(z.string()).max(MAX_TAGS_PER_IMAGE).optional(),
  alt_text: z.string().max(1000).optional(),
});

export const deleteQuerySchema = z.object({ hard: z.enum(["true", "false"]).optional() });

/** Public URL of an original. */
export function originalUrl(publicHost: string, r2Key: string): string {
  return `https://${publicHost}/${r2Key}`;
}

export const TRANSFORM_FORMATS = ["auto", "webp", "avif", "jpeg", "png"] as const;
export const TRANSFORM_FITS = ["scale-down", "contain", "cover", "crop", "pad"] as const;
export const MAX_TRANSFORM_DIMENSION = 10_000;

export type TransformOptions = {
  width?: number;
  height?: number;
  fit?: (typeof TRANSFORM_FITS)[number];
  quality?: number;
  format?: (typeof TRANSFORM_FORMATS)[number];
};

/**
 * URL of a resized or converted image via Cloudflare Image Transformations:
 * `https://{host}/cdn-cgi/image/width=800,quality=80,format=auto/{key}`.
 * With no options it returns the original URL. Options are always emitted in the same order so
 * equal requests share one cache entry. Throws RangeError on values Cloudflare would reject.
 *
 * Widths are always explicit: `width=auto` would count every distinct device width as a separate
 * billable transformation.
 */
export function transformUrl(
  publicHost: string,
  r2Key: string,
  options: TransformOptions = {},
): string {
  const parts: string[] = [];
  for (const name of ["width", "height"] as const) {
    const value = options[name];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1 || value > MAX_TRANSFORM_DIMENSION) {
      throw new RangeError(`${name} must be an integer from 1 to ${MAX_TRANSFORM_DIMENSION}`);
    }
    parts.push(`${name}=${value}`);
  }
  if (options.fit !== undefined) {
    if (!TRANSFORM_FITS.includes(options.fit)) {
      throw new RangeError(`fit must be one of ${TRANSFORM_FITS.join(", ")}`);
    }
    parts.push(`fit=${options.fit}`);
  }
  if (options.quality !== undefined) {
    if (!Number.isInteger(options.quality) || options.quality < 1 || options.quality > 100) {
      throw new RangeError("quality must be an integer from 1 to 100");
    }
    parts.push(`quality=${options.quality}`);
  }
  if (options.format !== undefined) {
    if (!TRANSFORM_FORMATS.includes(options.format)) {
      throw new RangeError(`format must be one of ${TRANSFORM_FORMATS.join(", ")}`);
    }
    parts.push(`format=${options.format}`);
  }
  return parts.length === 0
    ? originalUrl(publicHost, r2Key)
    : `https://${publicHost}/cdn-cgi/image/${parts.join(",")}/${r2Key}`;
}

// --- Listing -----------------------------------------------------------------

export const MAX_LIST_LIMIT = 100; // D1 allows at most 100 bound parameters per query

export const listQuerySchema = z.object({
  site: z.string().optional(),
  tag: z.string().optional(),
  q: z.string().min(1).max(200).optional(),
  deleted: z.enum(["exclude", "include", "only"]).default("exclude"),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(50),
  cursor: ulidSchema.optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

/** `next_cursor` is the id of the last image on the page, or null on the final page. */
export const listResponseSchema = z.object({
  images: z.array(imageSchema),
  next_cursor: z.string().nullable(),
});
export type ListResponse = z.infer<typeof listResponseSchema>;

// --- Updating ------------------------------------------------------------------

export const patchBodySchema = z
  .object({
    alt_text: z.string().max(1000).nullable().optional(), // null clears it
    add_tags: z.array(z.string()).max(MAX_TAGS_PER_IMAGE).optional(),
    remove_tags: z.array(z.string()).max(MAX_TAGS_PER_IMAGE).optional(),
  })
  .refine((b) => b.alt_text !== undefined || b.add_tags?.length || b.remove_tags?.length, {
    message: "Provide at least one of alt_text, add_tags or remove_tags",
  });
export type PatchBody = z.infer<typeof patchBodySchema>;

// --- Sites -----------------------------------------------------------------------

/** Used inside R2 keys, so keep it to lowercase letters, digits and hyphens. */
export const siteIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Use lowercase letters, digits and hyphens (max 40)");

export const siteSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.number().int(),
});
export type Site = z.infer<typeof siteSchema>;

export const createSiteBodySchema = z.object({
  id: siteIdSchema,
  name: z.string().min(1).max(100),
});
export const siteResponseSchema = z.object({ site: siteSchema });
export const sitesResponseSchema = z.object({ sites: z.array(siteSchema) });
export type CreateSiteBody = z.infer<typeof createSiteBodySchema>;
export type SiteResponse = z.infer<typeof siteResponseSchema>;
export type SitesResponse = z.infer<typeof sitesResponseSchema>;

// --- Tokens ----------------------------------------------------------------------

/** A token record. The hash is never exposed. `site_id: null` means admin. */
export const tokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  site_id: z.string().nullable(),
  created_at: z.number().int(),
  last_used_at: z.number().int().nullable(),
  revoked_at: z.number().int().nullable(),
});
export type Token = z.infer<typeof tokenSchema>;

export const createTokenBodySchema = z.object({
  name: z.string().min(1).max(100),
  site_id: siteIdSchema.nullable().optional(), // omit or null for an admin token
});
export const tokenResponseSchema = z.object({ token: tokenSchema });
export const tokensResponseSchema = z.object({ tokens: z.array(tokenSchema) });
/** `secret` is the plaintext token, returned once and never stored. */
export const createdTokenResponseSchema = z.object({ token: tokenSchema, secret: z.string() });
export type CreateTokenBody = z.infer<typeof createTokenBodySchema>;
export type TokenResponse = z.infer<typeof tokenResponseSchema>;
export type TokensResponse = z.infer<typeof tokensResponseSchema>;
export type CreatedTokenResponse = z.infer<typeof createdTokenResponseSchema>;
