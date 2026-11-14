import { env } from "cloudflare:workers";
import { ulid } from "ulid";
import { app } from "../src/app";
import { getDb } from "../src/db/client";
import { images, imageTags, sites, tags } from "../src/db/schema";
import { createToken } from "../src/lib/auth";

export const db = getDb(env.DB);
export const admin = `Bearer ${env.ADMIN_TOKEN}`;

export async function api(
  method: string,
  path: string,
  opts: { auth?: string | null; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.auth !== null) headers.Authorization = opts.auth ?? admin;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  return app.request(
    `/v1${path}`,
    {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    },
    // Without the limiter, so the suite's many requests do not trip it (it has its own test).
    { ...env, RATE_LIMITER: undefined },
  );
}

/** Parsed JSON body of a response. */
export const body = <T>(res: Response) => res.json() as Promise<T>;

export const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;

export async function seedSite(id: string) {
  await db.insert(sites).values({ id, name: id.toUpperCase(), createdAt: 1_700_000_000 });
}

export async function siteAuth(siteId: string) {
  return `Bearer ${(await createToken(db, { name: `${siteId}-token`, siteId })).token}`;
}

let counter = 0;

/** Inserts an image row directly (no R2 object), with a controllable id and tags. */
export async function seedImage(o: {
  site: string;
  filename?: string;
  alt?: string | null;
  tags?: string[];
  deleted?: boolean;
  at?: number; // ms; drives the ULID, so ordering is deterministic
}) {
  counter++;
  const at = o.at ?? 1_700_000_000_000 + counter * 1000;
  const id = ulid(at);
  await db.insert(images).values({
    id,
    siteId: o.site,
    r2Key: `${o.site}/2023/${id}.png`,
    originalFilename: o.filename ?? `file-${counter}.png`,
    contentType: "image/png",
    sizeBytes: 100,
    width: 10,
    height: 10,
    sha256: `${id}`.toLowerCase().padEnd(64, "0"),
    altText: o.alt ?? null,
    createdAt: Math.floor(at / 1000),
    updatedAt: 1, // old on purpose, so tests can see it move
    deletedAt: o.deleted ? 1_700_000_500 : null,
  });
  for (const name of o.tags ?? []) {
    await db.insert(tags).values({ id: ulid(), siteId: o.site, name }).onConflictDoNothing();
    const tag = await db.query.tags.findFirst({
      where: (t, { and, eq }) => and(eq(t.siteId, o.site), eq(t.name, name)),
    });
    if (tag) await db.insert(imageTags).values({ imageId: id, tagId: tag.id });
  }
  return id;
}
