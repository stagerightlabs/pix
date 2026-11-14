import type { AllowedContentType } from "@pix/schema";

export const EXTENSIONS: Record<AllowedContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
};

/** `{site_id}/{yyyy}/{ulid}.{ext}`. The extension comes from the detected type, never from user input. */
export function buildR2Key(
  siteId: string,
  id: string,
  contentType: AllowedContentType,
  now: Date,
): string {
  return `${siteId}/${now.getUTCFullYear()}/${id}.${EXTENSIONS[contentType]}`;
}
