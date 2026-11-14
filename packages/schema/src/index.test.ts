import { describe, expect, it } from "vitest";
import { originalUrl, transformUrl } from "./index";

const host = "pix.example.com";
const key = "blog/2026/01ARZ3NDEKTSV4RRFFQ69G5FAV.png";

describe("URL helpers", () => {
  it("builds the original URL, and returns it when no transform options are given", () => {
    expect(originalUrl(host, key)).toBe(`https://${host}/${key}`);
    expect(transformUrl(host, key)).toBe(originalUrl(host, key));
    expect(transformUrl(host, key, {})).toBe(originalUrl(host, key));
  });

  it("builds transform URLs with options in a fixed order", () => {
    expect(transformUrl(host, key, { width: 800, quality: 80, format: "auto" })).toBe(
      `https://${host}/cdn-cgi/image/width=800,quality=80,format=auto/${key}`,
    );
    // Property order of the input must not change the URL (cache key stability).
    expect(transformUrl(host, key, { format: "webp", fit: "cover", height: 50, width: 100 })).toBe(
      `https://${host}/cdn-cgi/image/width=100,height=50,fit=cover,format=webp/${key}`,
    );
  });

  it.each([
    [{ width: 0 }],
    [{ width: 1.5 }],
    [{ height: 10_001 }],
    [{ quality: 0 }],
    [{ quality: 101 }],
    [{ format: "gif" }],
    [{ format: "auto,width=1" }], // no option injection
    [{ fit: "stretch" }],
  ])("rejects %j", (options) => {
    expect(() => transformUrl(host, key, options as never)).toThrow(RangeError);
  });
});
