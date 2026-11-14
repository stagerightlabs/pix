# pix

A personal image host that runs entirely on Cloudflare. Originals live in R2, metadata in D1, and a Hono API on Workers manages everything. The `pix` CLI comes first and a web UI comes later. The design lives in `~/Markdown/cloudflare-image-service-plan.md`, which is the source of truth.

| Hostname                     | Purpose                                  |
| ---------------------------- | ---------------------------------------- |
| `pix.stagerightlabs.com`     | Public image serving and transformations |
| `pix-api.stagerightlabs.com` | Management API (bearer tokens)           |

Both names are Worker vars (`PUBLIC_HOST`, `API_HOST`), not hard-coded.

## Requirements

- Node 22+ and pnpm 12
- A Cloudflare account with Workers, R2 and D1 enabled

## Local development

```sh
pnpm install
pnpm --filter @pix/api types   # generate worker-configuration.d.ts (rerun after editing wrangler.jsonc)
pnpm dev                       # http://localhost:8787/health
pnpm test                      # Vitest inside the Workers runtime (local R2 and D1)
pnpm typecheck
pnpm lint                      # Biome; `pnpm format` applies fixes
```

Local secrets go in `apps/api/.dev.vars` (git-ignored; copy `.dev.vars.example`). `ADMIN_TOKEN` is required.

### Database

Drizzle generates SQL migrations and Wrangler applies them to D1:

```sh
cd apps/api
pnpm db:generate         # after editing src/db/schema.ts
pnpm db:migrate:local    # apply to the local simulated D1 used by `pnpm dev`
pnpm db:migrate:remote   # apply to the real pix-db (review the migration first)
```

Tests apply the migrations to an in-memory D1 automatically.

### Auth

All routes under `/v1` need `Authorization: Bearer <token>`. `/health` is public.

- `ADMIN_TOKEN` (Worker secret) is the bootstrap admin token. Use it to create the first tokens.
- Tokens are random `pix_...` strings. Only their SHA-256 hash is stored in `api_tokens`; the plaintext is shown once at creation.
- A token with no `site_id` is an admin token. A token with a `site_id` can only touch that site's images.
- Revoked tokens are rejected with `token_revoked`.

## Images

Routes (all under `/v1`, bearer token required; the base path is `/v1` and not `/api/v1` because the `stagerightlabs.com` zone blocks any URL containing `/api/` before it reaches the Worker) are declared with `createRoute` from `@hono/zod-openapi`, and their Zod schemas live in `packages/schema`, so the OpenAPI document and the types the CLI uses come from one source.

| Method | Path                  | Notes                                                                                                                                                                          |
| ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/images`             | Multipart: `file`, `site`, optional `tags[]` (repeat the field) and `alt_text`. `201` for a new image, `200` with `"duplicate": true` for a file already stored for that site. |
| GET    | `/images/:id`         | Record, tags and public URL. Includes soft-deleted images (see `deleted_at`).                                                                                                  |
| DELETE | `/images/:id`         | Soft delete. `?hard=true` removes the R2 object and the row (`204`).                                                                                                           |
| POST   | `/images/:id/restore` | Clears `deleted_at`.                                                                                                                                                           |
| GET    | `/images`             | List, newest first. Filters: `site`, `tag`, `q` (filename or alt text), `deleted=exclude\|include\|only`. Paginate with `limit` (1 to 100, default 50) and `cursor`.           |
| PATCH  | `/images/:id`         | JSON: `alt_text` (`null` clears), `add_tags`, `remove_tags`.                                                                                                                   |
| GET    | `/sites`              | A site-scoped token sees only its own site.                                                                                                                                    |
| POST   | `/sites`              | Admin only. `id` is a slug (lowercase letters, digits, hyphens). `409` if it exists.                                                                                           |
| GET    | `/tokens`             | Admin only. Never includes hashes or secrets.                                                                                                                                  |
| POST   | `/tokens`             | Admin only. Returns the plaintext `secret` once. Omit `site_id` for an admin token.                                                                                            |
| DELETE | `/tokens/:id`         | Admin only. Revokes; idempotent.                                                                                                                                               |
| GET    | `/openapi.json`       | OpenAPI 3.1 spec. Public, served at the root like `/health` (not under `/v1`).                                                                                                 |

Behaviours worth knowing:

- **Type detection** uses magic bytes only (JPEG, PNG, WebP, AVIF, GIF). The client's `Content-Type` and filename are ignored, and SVG is rejected (`415`). The R2 key's extension comes from the detected type: `{site}/{yyyy}/{ulid}.{ext}`.
- **Size limit** is the `MAX_UPLOAD_BYTES` var (default 25 MB). It is checked against `Content-Length` first and enforced again while the body is read, so a missing or false `Content-Length` cannot get past it (`413`).
- **Hashing and memory:** multipart parsing buffers the file in memory, so the SHA-256 is computed from that buffer rather than while streaming to R2. At 25 MB that is well inside the Worker memory limit. R2 also verifies the upload against the hash.
- **Dedupe** is per site, on SHA-256. Uploading a file that matches a _soft-deleted_ image restores it and returns it as a duplicate.
- **Dimensions** are read from the file header (no dependency). EXIF rotation is not applied, and AVIF reads the largest `ispe` box, so `width` and `height` can be `null` if a header is unreadable.
- **Cross-site access** by a site-scoped token returns `403`. For listing, a site token is pinned to its own site, and naming another site is `403`.
- **Pagination** is on the image id (a ULID, so it follows creation order). `next_cursor` is `null` on the last page. The page size is capped at 100 because D1 allows at most 100 bound parameters per query.
- **Search** (`q`) matches the filename or alt text case-insensitively, and `%` and `_` in the term match literally.
- **Tags** are per site, lowercase, created on first use, and kept when no image uses them any more.
- **First site and token:** use the bootstrap `ADMIN_TOKEN` to `POST /sites`, then `POST /tokens` with that site's id.
- **Failures** after the R2 write remove the object again, so a failed insert leaves no orphan.

## Public serving and hostnames

One Worker serves two hostnames and keeps them apart (`src/index.ts`): `pix.stagerightlabs.com` serves images only, `pix-api.stagerightlabs.com` serves the API only, and any other host (including a stray `workers.dev` URL, which is disabled) gets a 404. Both names are the `PUBLIC_HOST` and `API_HOST` vars, and the custom domains in `wrangler.jsonc` `routes` must match them.

- **Originals:** `https://pix.stagerightlabs.com/{site}/{yyyy}/{ulid}.{ext}`, with `Cache-Control: public, max-age=31536000, immutable`, `ETag` and conditional requests (`304`), `Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy: cross-origin`, `X-Content-Type-Options: nosniff`, and no cookies. Only GET, HEAD and OPTIONS are allowed.
- **Resized or converted:** `https://pix.stagerightlabs.com/cdn-cgi/image/width=800,quality=80,format=auto/{key}`. Build these with `transformUrl()` from `@pix/schema`, which keeps option order fixed (so equal requests share one cache entry) and never emits `width=auto` (each distinct width is billed as its own transformation).
- **Format caveat:** Cloudflare serves `format=webp` or `format=avif` only when the request's `Accept` header says the client supports it (otherwise you get the original format). Browsers do, so it works in practice; plain `curl` does not unless you send `-H 'Accept: image/webp'`. `format=auto` picks the best supported format, and `format=jpeg` or `png` are always honored.
- **Client sites** need `img-src https://pix.stagerightlabs.com` in their CSP, and should store keys or relative paths rather than full URLs.

### Why a Worker custom domain, not an R2 custom domain

A Worker lets the public host check D1 before serving, which soft delete needs ("soft-deleted images return 404"). A bucket's custom domain serves whatever is in the bucket and cannot make that check. The Worker also sets the cross-origin and cache headers in code instead of in dashboard rules, and only serves keys that have a live database row (an orphaned R2 object is never exposed). The cost is one Worker invocation, one D1 read and one R2 read per uncached request, which is negligible at this traffic. The Worker never handles `/cdn-cgi/`: Cloudflare processes those URLs in front of it and the Worker only sees the source-image request, so it cannot loop on itself (a Worker that re-fetches its own `/cdn-cgi/image/` URL is what causes Cloudflare's error 9403).

### Soft delete and caching: what it does and does not hide

Soft delete is checked on every request that reaches the Worker, so it hides the **original URL** immediately (confirmed on the live domain: the original returns `404`, and `POST .../restore` brings it back).

It does **not** hide `/cdn-cgi/image/...` variants. Cloudflare's image resizer keeps its own cached copy of the source image, so after a soft delete it still builds and serves variants, including widths nobody has requested before, without asking the Worker. Browsers also keep `immutable` originals for up to a year. So soft delete means "hidden from the original URL and recoverable", not a takedown.

For a real takedown, hard-delete the image (`DELETE /v1/images/:id?hard=true`) and purge its URLs in the Cloudflare dashboard (Caching, Configuration, Purge Cache, Custom purge by URL), including any `/cdn-cgi/image/...` variants you used. Automating that purge on delete is a possible Phase 7 addition and would need a Cache Purge API token.

### Local development

`pnpm dev` runs with `--infer-origin-from-routes=false`, so the Worker sees the real local host. Use `localhost:8787` as the API host and `127.0.0.1:8787` as the public host; `.dev.vars.example` sets `API_HOST` and `PUBLIC_HOST` to match. (Tests pin the production hostnames in `vitest.config.ts`, so `.dev.vars` does not affect them.)

```sh
curl -H "Authorization: Bearer $ADMIN_TOKEN" -F file=@photo.png -F site=blog localhost:8787/v1/images
curl -i 127.0.0.1:8787/blog/2026/<ulid>.png
```

## Deploying

Run from `apps/api`. Nothing here is automatic: each step changes the real account.

1. **Check the secret exists, or set it.** The deploy fails without `ADMIN_TOKEN`. Generate one and keep the printed value somewhere safe:
   `openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' | tee /dev/stderr | pnpm exec wrangler secret put ADMIN_TOKEN`
   (Wrangler offers to create the Worker on the first secret.)
2. **Migrate the real database:** `pnpm db:migrate:remote`
3. **Deploy:** `pnpm run deploy` (plain `pnpm deploy` is a different, built-in pnpm command). This creates the DNS records and certificates for both custom domains. The certificates can take a few minutes; until then the hostnames may return TLS errors.
4. **Check the separation:**
   `curl -s https://pix-api.stagerightlabs.com/health` returns `{"status":"ok"}`, while `curl -s -o /dev/null -w '%{http_code}\n' https://pix.stagerightlabs.com/health` returns `404`.
5. **Create a site and upload** (use the secret from step 1):

   ```sh
   export ADMIN_TOKEN=...   # the value printed in step 1
   curl -s -X POST https://pix-api.stagerightlabs.com/v1/sites \
     -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
     -d '{"id":"blog","name":"Blog"}'
   curl -s https://pix-api.stagerightlabs.com/v1/images \
     -H "Authorization: Bearer $ADMIN_TOKEN" -F file=@photo.jpg -F site=blog
   ```
6. **Load the original and a resized WebP** using the `url` from step 5's response:

   ```sh
   curl -sI "https://pix.stagerightlabs.com/blog/2026/<ulid>.jpg"
   curl -sI -H 'Accept: image/webp' "https://pix.stagerightlabs.com/cdn-cgi/image/width=400,format=webp/blog/2026/<ulid>.jpg"
   ```

   The second should return `content-type: image/webp` and a `cf-resized` header. If it returns `cf-not-resized` or an error, see the troubleshooting notes below.
7. **Check soft delete:** `DELETE /v1/images/<id>` makes the original return `404`; `POST /v1/images/<id>/restore` brings it back.

### Known gap: no Cross-Origin-Resource-Policy on resized images

Originals carry `Cross-Origin-Resource-Policy: cross-origin`, but Cloudflare's resizer drops it from `/cdn-cgi/image/...` responses (it keeps `Access-Control-Allow-Origin`). That only matters for client sites that send `Cross-Origin-Embedder-Policy: require-corp`.

**Tried and unresolved:** a Response Header Transform Rule (Rules, Overview, Create rule, Response Header Transform Rule; when `http.host eq "pix.stagerightlabs.com"`, set static `Cross-Origin-Resource-Policy: cross-origin`) was deployed and the header still did not appear on resized responses, even for a never-requested variant. Cloudflare's docs do not say whether these rules apply to `/cdn-cgi/image/` responses. The Worker's own responses already carry the header, so the rule's effect cannot be seen on them. Cloudflare Trace (Rules, Trace) can show whether the rule fires for a resized URL.

**Workaround, and the likely end state:** on a `require-corp` page, add `crossorigin="anonymous"` to the `<img>` tag (the `Access-Control-Allow-Origin: *` header on resized images then satisfies the policy), or use `Cross-Origin-Embedder-Policy: credentialless`. Pages without that policy are unaffected.

### Deployment notes

- The zone blocks any URL containing `/api/` at the edge, which is why the API lives under `/v1`.
- If your machine cannot resolve `pix-api.stagerightlabs.com` right after the first deploy, it is probably caching the earlier "no such name" answer. Wait a few minutes, or test with `curl --resolve pix-api.stagerightlabs.com:443:<ip from dig @1.1.1.1>`.

### If transformations do not work

- `cf-not-resized` with an `err` value: the header names the reason (for example, transformations not enabled for the zone in Images, Transformations).
- Error `9403`: Cloudflare detected a request loop. The Worker must not fetch its own `/cdn-cgi/image/` URL, and does not.
- `404` on the transformed URL only: the source-image request is being refused, so first confirm the original URL loads.

## Operations

**Logs and request ids.** Every API response carries `X-Request-Id`, and the Worker logs one JSON line per request (`requestId`, `method`, `path`, `status`, `ms`, `tokenId`). A 500 body also includes `request_id`, and its error detail is logged under the same id. Watch live with `pnpm --filter @pix/api exec wrangler tail pix-api --format json`.

**Rate limit.** `/v1` allows 300 requests per minute per client IP (the `RATE_LIMITER` binding in `wrangler.jsonc`); beyond that the API answers `429 rate_limited` with `Retry-After: 60`. Public image serving is not limited. Change `limit` in `wrangler.jsonc` and redeploy.

**Backup.** Two things hold state:

```sh
# D1 (records, tags, token hashes)
pnpm --filter @pix/api exec wrangler d1 export pix-db --remote --output pix-db-$(date +%F).sql
# R2 (the image files): any S3-compatible sync tool works, for example rclone with an R2 API token
rclone sync r2:pix-images ./pix-images-backup
```

Keep the D1 export private: it contains token hashes. Restoring is `wrangler d1 execute pix-db --remote --file <export>.sql` into an empty database.

**Restoring a soft-deleted image.** `pix list --deleted only` finds it, `pix restore <id>` brings it back. Soft delete only hides the original URL; it never removes the file.

**Rotating tokens.** `pix tokens create <name> [--site <slug>]` (run it with `!` in Claude Code so the secret stays out of the chat), switch the client over, then `pix tokens revoke <id>`. `pix tokens list` shows `last used`, which tells you whether a token is still in use. To rotate the bootstrap admin secret: `pnpm --filter @pix/api exec wrangler secret put ADMIN_TOKEN`, then `pix login` with the new value.

## The `pix` CLI

`apps/cli` builds to one self-contained file, `dist/pix.js`, that bundles its dependencies.

**Install** (once, then again only if the path changes):

```sh
pnpm install
pnpm --filter @pix/cli build
pnpm add --global link:$PWD/apps/cli
pix --version
```

This symlinks `pix` into pnpm's global bin directory (`~/.local/share/pnpm/bin`), which the dotfiles already put on `PATH` (`profile.d/207-path-node.sh`). After changing the CLI, run `pnpm --filter @pix/cli build` and the command is updated. (`pnpm link --global` no longer exists in pnpm 12; plain `pnpm link` only links a package into another project.)

**Log in** once, with a prompt that does not echo the token:

```sh
pix login          # API URL (default https://pix-api.stagerightlabs.com), then the token
```

It checks the credentials against the API, then saves `~/.config/pix/config.json` with mode `0600` (`$XDG_CONFIG_HOME/pix/config.json` if set). `PIX_API_URL` and `PIX_TOKEN` override the file one by one. Day to day, prefer a site-scoped token over the admin one: `pix tokens create blog-laptop --site blog`, then `pix login` with the secret it prints.

| Command                                                                                                   | What it does                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pix upload <files...> --site <site> [--tag a,b] [--alt "..."] [--concurrency n]`                         | Uploads files (quote globs so pix expands them), 3 at a time by default, and prints one URL per file on stdout. Progress, duplicates and failures go to stderr. |
| `pix list [--site] [--tag] [--q] [--limit] [--cursor] [--deleted exclude\|include\|only] [--all]`         | Lists images, newest first.                                                                                                                                     |
| `pix info <id>`                                                                                           | Shows one image's details.                                                                                                                                      |
| `pix tag <id> --add a,b --remove c`                                                                       | Adds and removes tags.                                                                                                                                          |
| `pix alt <id> "text"` or `pix alt <id> --clear`                                                           | Sets or clears alt text.                                                                                                                                        |
| `pix rm <id> [--hard]` / `pix restore <id>`                                                               | Soft delete (recoverable) or permanent delete, and undo a soft delete.                                                                                          |
| `pix url <id> [--width N] [--height N] [--fit mode] [--quality N] [--format auto\|webp\|avif\|jpeg\|png]` | Prints the image URL, resized or converted if you ask.                                                                                                          |
| `pix sites list` / `pix sites create <id> [--name]`                                                       | Lists sites; creates one (admin).                                                                                                                               |
| `pix tokens list` / `create <name> [--site]` / `revoke <id>`                                              | Manages tokens (admin). The secret is shown once.                                                                                                               |

Every command takes `--json` (after or before the command name). Exit codes: `0` success, `1` error (including a partial upload failure), `2` usage error. Errors read `Error: <message> (<api error code>)`; with `--json` they are `{"error":{"code","message"}}` on stderr, so stdout is always clean JSON or nothing.

Notes:

- `pix url` builds the URL from the image record, so the public host always comes from the server's configuration. The resized form needs the browser's `Accept` header to get WebP or AVIF (see "Format caveat" above); `--format auto` is the usual choice.
- Failed `GET` requests are retried twice (a single transient `500` was seen once on the live API); writes are never retried.
- Uploading a file that already exists for the site reports `duplicate` and prints the existing URL.
- The client parses every response with the shared Zod schemas in `@pix/schema`, so an API change the CLI has not caught up with fails with `bad_response` instead of printing wrong data.

## Cloudflare setup (one time)

Already done for the Stage Right Labs account. To repeat it elsewhere:

1. `wrangler login`. With several accounts, set `account_id` in `apps/api/wrangler.jsonc` or `CLOUDFLARE_ACCOUNT_ID`.
2. Create the bucket: `wrangler r2 bucket create pix-images`
3. Create the database: `wrangler d1 create pix-db`, then put its `database_id` in `wrangler.jsonc`.
4. Enable Image Transformations on the zone (dashboard: Images, Transformations).
5. Generate and set the admin secret: `openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' | tee /dev/stderr | wrangler secret put ADMIN_TOKEN` (note the printed value somewhere safe). The Worker deploy fails if the secret is missing.
6. Apply migrations to the remote database: `pnpm --filter @pix/api db:migrate:remote`
7. The custom domains for `pix` and `pix-api` are declared in `wrangler.jsonc` and created on deploy. See Deploying, above.

Bindings: `IMAGES` (R2 bucket `pix-images`) and `DB` (D1 database `pix-db`).

## Layout

- `apps/api`: Hono Worker
- `packages/schema`: shared Zod schemas
- `apps/cli`: the `pix` CLI
- `apps/ui`: web UI (Phase 8, not started)

## Tooling notes

- pnpm blocks dependency build scripts by default. `pnpm-workspace.yaml` allows `esbuild` and `workerd`, which Wrangler needs.
- Tests use `@cloudflare/vitest-plugin`. Its predecessor, `@cloudflare/vitest-pool-workers`, is deprecated and its bundled runtime lags behind current compatibility dates.

## Releases and changelog

Releases are automated with [release-please](https://github.com/googleapis/release-please). The whole repo has one version (root `package.json`) and one `CHANGELOG.md`.

1. Merge PRs to `main` with Conventional Commit titles (the squash commit message is the PR title).
2. release-please keeps a "chore(main): release x.y.z" PR open that bumps the version and updates `CHANGELOG.md`. `feat` bumps the minor version, `fix` and `perf` bump the patch version, and `!` or a `BREAKING CHANGE:` footer bumps the major version (while below 1.0.0, breaking changes bump the minor version instead).
3. Merging that PR creates the `vx.y.z` tag and GitHub Release. Deploying is still manual (`pnpm run deploy`).

The workflow authenticates with the `RELEASE_PLEASE_TOKEN` repository secret, a fine-grained PAT with Contents and Pull requests read/write on this repo. It is a PAT rather than `GITHUB_TOKEN` so the release PR triggers the required `check-title` check. If the token expires, release PRs stop updating.

## Commit Messages

This project uses [Conventional Commits (with scope)](https://www.conventionalcommits.org/en/v1.0.0/#commit-message-with-scope)
for commit messages and pull request titles. This clarifies the work done in each commit and allows changelogs to be generated for releases.

The format is `type(scope): description`. For example:

```bash
feat(lambda): add new lambda function to handle data processing
```

For the type of work please use one of the following:

- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation only changes
- `style`: Changes that do not affect the meaning of the code (white-space, formatting, missing semi-colons, etc)
- `refactor`: A code change that neither fixes a bug nor adds a feature
- `perf`: A code change that improves performance
- `test`: Adding missing tests or correcting existing tests
- `chore`: Changes to the build process or auxiliary tools and libraries
