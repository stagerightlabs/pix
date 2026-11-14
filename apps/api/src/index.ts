import { app } from "./app";
import { errorBody } from "./lib/errors";
import { handlePublic } from "./public";

/**
 * One Worker serves two hostnames and keeps them apart: the public host serves images only, the API
 * host serves the API only, and any other host (such as a stray workers.dev URL) gets a 404.
 */
export default {
  fetch(request, env, ctx) {
    const host = new URL(request.url).host;
    if (host === env.API_HOST.toLowerCase()) return app.fetch(request, env, ctx);
    if (host === env.PUBLIC_HOST.toLowerCase()) return handlePublic(request, env);
    return Response.json(errorBody("not_found", "Not found"), { status: 404 });
  },
} satisfies ExportedHandler<Env>;
