import { defineConfig } from "drizzle-kit";

// Drizzle only generates SQL. Wrangler applies it (see the db:migrate:* scripts).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
