// Minimal synthetic image files: valid headers, so detection and dimension parsing are real.
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];

/** Distinct `salt` values give distinct bytes, and therefore distinct hashes. */
const tail = (salt: string) => ascii(`--${salt}--`);

export const png = (w: number, h: number, salt = "") =>
  new Uint8Array([
    0x89,
    ...ascii("PNG"),
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    ...ascii("IHDR"),
    ...be32(w),
    ...be32(h),
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...tail(salt),
  ]);

export const gif = (w: number, h: number, salt = "") =>
  new Uint8Array([...ascii("GIF89a"), ...le16(w), ...le16(h), 0, 0, 0, ...tail(salt)]);

export const jpeg = (w: number, h: number, salt = "") =>
  new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    ...be16(16),
    ...ascii("JFIF"),
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0, // APP0
    0xff,
    0xc0,
    ...be16(11),
    8,
    ...be16(h),
    ...be16(w),
    1,
    1,
    0x11,
    0,
    ...tail(salt),
  ]);

export const webpLossless = (w: number, h: number, salt = "") => {
  const bits = (w - 1) | ((h - 1) << 14);
  return new Uint8Array([
    ...ascii("RIFF"),
    0,
    0,
    0,
    0,
    ...ascii("WEBP"),
    ...ascii("VP8L"),
    ...be32(0).reverse(),
    0x2f,
    bits & 255,
    (bits >> 8) & 255,
    (bits >> 16) & 255,
    (bits >>> 24) & 255,
    ...tail(salt),
  ]);
};

export const webpExtended = (w: number, h: number, salt = "") =>
  new Uint8Array([
    ...ascii("RIFF"),
    0,
    0,
    0,
    0,
    ...ascii("WEBP"),
    ...ascii("VP8X"),
    10,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...le24(w - 1),
    ...le24(h - 1),
    ...tail(salt),
  ]);

export const avif = (w: number, h: number, salt = "") =>
  new Uint8Array([
    ...be32(24),
    ...ascii("ftyp"),
    ...ascii("avif"),
    0,
    0,
    0,
    0,
    ...ascii("avif"),
    ...ascii("mif1"),
    ...be32(20),
    ...ascii("ispe"),
    0,
    0,
    0,
    0,
    ...be32(w),
    ...be32(h),
    ...tail(salt),
  ]);

export const svg = () =>
  new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');

export const pdf = (salt = "") =>
  new TextEncoder().encode(`%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n${salt}`);
