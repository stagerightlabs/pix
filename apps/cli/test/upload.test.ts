import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiError, type Call, image, setup } from "./harness";

let t: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  t = await setup();
});
afterEach(() => t.cleanup());

const form = (c: Call) => c.body as FormData;
const fileName = (c: Call) => (form(c).get("file") as File).name;
const created = (c: Call) => ({
  image: image({ original_filename: fileName(c), url: `https://pix.example.com/${fileName(c)}` }),
  duplicate: false,
});

describe("upload", () => {
  it("uploads literal files and quoted globs, sending the fields and printing one URL each", async () => {
    await Promise.all([t.file("b.png"), t.file("a.jpg"), t.file("c.jpg")]);
    t.api(created);
    const { code, out, err } = await t.pix(
      "upload",
      "b.png",
      "*.jpg",
      "--site",
      "blog",
      "--tag",
      "Hero,sale",
      "--alt",
      "pic",
    );

    expect(code).toBe(0);
    expect(out.trim().split("\n")).toEqual([
      "https://pix.example.com/b.png",
      "https://pix.example.com/a.jpg",
      "https://pix.example.com/c.jpg",
    ]);
    expect(err).toContain("3 uploaded, 0 duplicate, 0 failed");
    const first = t.calls.find((c) => fileName(c) === "b.png") as Call;
    expect([
      form(first).get("site"),
      form(first).getAll("tags[]"),
      form(first).get("alt_text"),
    ]).toEqual(["blog", ["Hero", "sale"], "pic"]);
  });

  it("uploads a file named twice only once", async () => {
    await t.file("a.png");
    t.api(created);
    await t.pix("upload", "a.png", "./a.png", "--site", "blog");
    expect(t.calls).toHaveLength(1);
  });

  it.each([
    [[], 3], // the default
    [["--concurrency", "1"], 1],
    [["--concurrency", "2"], 2],
  ])("runs at most the allowed uploads at once (%j)", async (flags, max) => {
    await Promise.all([1, 2, 3, 4, 5, 6, 7].map((n) => t.file(`f${n}.png`)));
    let inFlight = 0;
    let peak = 0;
    t.api(async (c: Call) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return created(c);
    });
    await t.pix("upload", "*.png", "--site", "blog", ...flags);
    expect(peak).toBe(max);
  });

  it("reports duplicates and failures, keeps going, and exits 1", async () => {
    await Promise.all(["ok.png", "dup.png", "bad.txt"].map((f) => t.file(f)));
    t.api((c: Call) => {
      if (fileName(c) === "bad.txt")
        return apiError(415, "unsupported_media_type", "Unsupported file type");
      return { ...created(c), duplicate: fileName(c) === "dup.png" };
    });
    const { code, out, err } = await t.pix(
      "upload",
      "ok.png",
      "dup.png",
      "bad.txt",
      "--site",
      "blog",
    );

    expect(code).toBe(1);
    expect(out.trim().split("\n")).toEqual([
      "https://pix.example.com/ok.png",
      "https://pix.example.com/dup.png",
    ]);
    expect(err).toContain("duplicate dup.png (already stored as 01ARZ3NDEKTSV4RRFFQ69G5FAV)");
    expect(err).toContain("failed    bad.txt: Unsupported file type (unsupported_media_type)");
    expect(err).toContain("1 uploaded, 1 duplicate, 1 failed");
    expect(err).not.toContain("Error:"); // the per-file lines and summary are the message

    const json = await t.pix("upload", "ok.png", "dup.png", "bad.txt", "--site", "blog", "--json");
    const results = JSON.parse(json.out) as { file: string; status: string }[];
    expect(results.map((r) => [r.file, r.status])).toEqual([
      ["ok.png", "created"],
      ["dup.png", "duplicate"],
      ["bad.txt", "error"],
    ]);
  });

  it.each([["nope.png"], ["*.gif"]])(
    "fails before uploading anything when %s matches no file",
    async (arg) => {
      await t.file("real.png");
      t.api(created);
      const { code, err } = await t.pix("upload", "real.png", arg, "--site", "blog");
      expect([code, t.calls.length, err]).toEqual([1, 0, `Error: No such file: ${arg}\n`]);
    },
  );
});
