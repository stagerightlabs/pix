import { and, eq, isNull, lt, or } from "drizzle-orm";
import { ulid } from "ulid";
import type { Db } from "../db/client";
import { apiTokens } from "../db/schema";
import { ApiError } from "./errors";
import { safeEqual, sha256Hex } from "./hash";

export type AuthContext =
  | { kind: "admin"; tokenId: string | null } // tokenId null = bootstrap secret
  | { kind: "site"; siteId: string; tokenId: string };

const TOKEN_PREFIX = "pix_";

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function generateToken(): string {
  return TOKEN_PREFIX + base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}

/** Creates a token. The plaintext is returned once and never stored. */
export async function createToken(db: Db, opts: { name: string; siteId: string | null }) {
  const token = generateToken();
  const record = {
    id: ulid(),
    name: opts.name,
    tokenHash: await hashToken(token),
    siteId: opts.siteId,
    createdAt: Math.floor(Date.now() / 1000),
  };
  await db.insert(apiTokens).values(record);
  return { token, record };
}

function parseBearer(header: string | undefined): string {
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  if (!match?.[1]) {
    throw new ApiError(401, "unauthorized", "Missing or malformed Authorization header");
  }
  return match[1];
}

export async function authenticate(
  db: Db,
  adminSecret: string | undefined,
  header: string | undefined,
): Promise<AuthContext> {
  const token = parseBearer(header);

  if (adminSecret && (await safeEqual(token, adminSecret))) {
    return { kind: "admin", tokenId: null };
  }

  const row = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, await hashToken(token)))
    .get();
  if (!row) throw new ApiError(401, "unauthorized", "Invalid token");
  if (row.revokedAt !== null) throw new ApiError(401, "token_revoked", "Token has been revoked");

  return row.siteId === null
    ? { kind: "admin", tokenId: row.id }
    : { kind: "site", siteId: row.siteId, tokenId: row.id };
}

export function requireAdmin(auth: AuthContext): void {
  if (auth.kind !== "admin") throw new ApiError(403, "forbidden", "Admin token required");
}

export function assertSiteAccess(auth: AuthContext, siteId: string): void {
  if (auth.kind === "site" && auth.siteId !== siteId) {
    throw new ApiError(403, "forbidden", "Token is not allowed to access this site");
  }
}

/** Records token use, at most once per interval so reads do not turn into D1 writes. Never throws. */
export const LAST_USED_INTERVAL_SECONDS = 300;

export async function touchLastUsed(db: Db, tokenId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await db
      .update(apiTokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(apiTokens.id, tokenId),
          or(
            isNull(apiTokens.lastUsedAt),
            lt(apiTokens.lastUsedAt, now - LAST_USED_INTERVAL_SECONDS),
          ),
        ),
      );
  } catch (err) {
    console.error("last_used_at update failed", err);
  }
}
