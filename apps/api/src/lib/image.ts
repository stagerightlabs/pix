import type { AllowedContentType } from "@pix/schema";

const ascii = (b: Uint8Array, start: number, len: number) =>
  String.fromCharCode(...b.subarray(start, start + len));
const u32be = (b: Uint8Array, i: number) =>
  (b[i] ?? 0) * 2 ** 24 + ((b[i + 1] ?? 0) << 16) + ((b[i + 2] ?? 0) << 8) + (b[i + 3] ?? 0);
const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number) => u16le(b, i) | ((b[i + 2] ?? 0) << 16);

/** Detects the type from magic bytes only. The client's Content-Type and filename are ignored. */
export function detectImageType(b: Uint8Array): AllowedContentType | null {
  if (b.length < 12) return null;
  if (ascii(b, 0, 5) === "%PDF-") return "application/pdf";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(b, 1, 3) === "PNG" && b[0] === 0x89 && ascii(b, 4, 4) === "\r\n\x1a\n") {
    return "image/png";
  }
  const head6 = ascii(b, 0, 6);
  if (head6 === "GIF87a" || head6 === "GIF89a") return "image/gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
  if (ascii(b, 4, 4) === "ftyp") {
    const boxSize = Math.min(u32be(b, 0), b.length);
    // Major brand at 8, then minor version (4 bytes), then compatible brands.
    const brands = [ascii(b, 8, 4)];
    for (let i = 16; i + 4 <= boxSize; i += 4) brands.push(ascii(b, i, 4));
    if (brands.some((x) => x === "avif" || x === "avis")) return "image/avif";
  }
  return null;
}

export type Dimensions = { width: number; height: number };

function png(b: Uint8Array): Dimensions | null {
  return b.length >= 24 && ascii(b, 12, 4) === "IHDR"
    ? { width: u32be(b, 16), height: u32be(b, 20) }
    : null;
}

function gif(b: Uint8Array): Dimensions | null {
  return { width: u16le(b, 6), height: u16le(b, 8) };
}

function jpeg(b: Uint8Array): Dimensions | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1] ?? 0;
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // standalone markers carry no length
      continue;
    }
    // SOF0..SOF15, excluding DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: u16be(b, i + 7), height: u16be(b, i + 5) };
    }
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

function webp(b: Uint8Array): Dimensions | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8X" && b.length >= 30) {
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  if (chunk === "VP8 " && b.length >= 30) {
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
    const bits =
      (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) * 2 ** 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/**
 * AVIF stores sizes in `ispe` boxes. A grid image also carries one per tile, so take the largest.
 * This is a scan, not a full ISO-BMFF parse; it returns null when nothing plausible is found.
 */
function avif(b: Uint8Array): Dimensions | null {
  let best: Dimensions | null = null;
  const limit = Math.min(b.length, 64 * 1024) - 16;
  for (let i = 4; i < limit; i++) {
    if (b[i] === 0x69 && ascii(b, i, 4) === "ispe") {
      const width = u32be(b, i + 8);
      const height = u32be(b, i + 12);
      if (width > 0 && height > 0 && (!best || width * height > best.width * best.height)) {
        best = { width, height };
      }
    }
  }
  return best;
}

/** Pixel dimensions from the file header, or null if they cannot be read. EXIF rotation is not applied. */
export function getDimensions(b: Uint8Array, type: AllowedContentType): Dimensions | null {
  if (type === "application/pdf") return null;
  const dims = {
    "image/png": png,
    "image/gif": gif,
    "image/jpeg": jpeg,
    "image/webp": webp,
    "image/avif": avif,
  }[type](b);
  return dims && dims.width > 0 && dims.height > 0 ? dims : null;
}
