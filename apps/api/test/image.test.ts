import { describe, expect, it } from "vitest";
import { detectImageType, getDimensions } from "../src/lib/image";
import { avif, gif, jpeg, png, svg, webpExtended, webpLossless } from "./fixtures";

describe("image detection and dimensions", () => {
  it.each([
    ["jpeg", jpeg, "image/jpeg"],
    ["png", png, "image/png"],
    ["gif", gif, "image/gif"],
    ["webp (lossless)", webpLossless, "image/webp"],
    ["webp (extended)", webpExtended, "image/webp"],
    ["avif", avif, "image/avif"],
  ] as const)("%s: type from magic bytes and size from the header", (_name, build, type) => {
    const bytes = build(640, 480);
    expect(detectImageType(bytes)).toBe(type);
    expect(getDimensions(bytes, type)).toEqual({ width: 640, height: 480 });
  });

  it("rejects SVG, text, truncated input and non-AVIF ISO-BMFF", () => {
    const heic = avif(1, 1);
    heic.set(new TextEncoder().encode("heic"), 8);
    heic.set(new TextEncoder().encode("mif1"), 16);
    heic.set(new TextEncoder().encode("heic"), 20);
    for (const bytes of [
      svg(),
      new TextEncoder().encode("hello world, not an image"),
      new Uint8Array([0xff, 0xd8]),
      heic,
    ]) {
      expect(detectImageType(bytes)).toBeNull();
    }
  });

  it("returns null dimensions when the header is unreadable", () => {
    const broken = png(1, 1);
    broken.fill(0, 12, 16);
    expect(getDimensions(broken, "image/png")).toBeNull();
  });
});
