import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const sites = sqliteTable("sites", {
  id: text("id").primaryKey(), // slug, e.g. "blog"
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const images = sqliteTable(
  "images",
  {
    id: text("id").primaryKey(), // ULID
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    r2Key: text("r2_key").notNull().unique(),
    originalFilename: text("original_filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    width: integer("width"),
    height: integer("height"),
    sha256: text("sha256").notNull(),
    altText: text("alt_text"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    index("images_site_id_idx").on(t.siteId),
    index("images_sha256_idx").on(t.sha256),
    uniqueIndex("images_site_sha256_uniq").on(t.siteId, t.sha256),
  ],
);

export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    name: text("name").notNull(),
  },
  (t) => [uniqueIndex("tags_site_name_uniq").on(t.siteId, t.name)],
);

export const imageTags = sqliteTable(
  "image_tags",
  {
    imageId: text("image_id")
      .notNull()
      .references(() => images.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.imageId, t.tagId] })],
);

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(), // ULID
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(), // SHA-256 hex; never store plaintext
    siteId: text("site_id").references(() => sites.id), // null = admin / all sites
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [index("api_tokens_site_id_idx").on(t.siteId)],
);
