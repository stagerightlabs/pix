import { defineConfig } from "tsup";

// Everything (workspace packages, zod, commander, tinyglobby) is a devDependency, so tsup bundles it
// all into one runnable file: dist/pix.js.
export default defineConfig({
  entry: { pix: "src/index.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
