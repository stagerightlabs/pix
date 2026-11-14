import {
  type CreateSiteBody,
  type CreateTokenBody,
  createdTokenResponseSchema,
  errorSchema,
  type ImageResponse,
  imageResponseSchema,
  type ListQuery,
  type ListResponse,
  listResponseSchema,
  type PatchBody,
  siteResponseSchema,
  sitesResponseSchema,
  tokenResponseSchema,
  tokensResponseSchema,
  type UploadResponse,
  uploadResponseSchema,
} from "@pix/schema";
import { z } from "zod";
import { CliError } from "./errors";

/** An error response from the API, or a failure to reach it. */
export class ApiClientError extends CliError {
  constructor(
    message: string,
    code: string,
    readonly status: number,
  ) {
    super(message, code, 1);
  }
}

export type ClientOptions = {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  /** Pause before retrying a failed GET; tests set it to 0. */
  retryDelayMs?: number;
};

type Query = Record<string, string | number | undefined>;

/**
 * A typed client for the API. Request bodies and responses use the shared Zod schemas from
 * `@pix/schema`, and every response is parsed, so a change to the API that the CLI has not caught up
 * with fails loudly instead of printing wrong data.
 */
export function createClient(options: ClientOptions) {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;

  async function request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    init: { query?: Query; json?: unknown; form?: FormData } = {},
  ): Promise<T> {
    const url = new URL(`${base}/v1${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${options.token}` };
    if (init.json !== undefined) headers["Content-Type"] = "application/json";

    // Only GETs are repeated: they change nothing, so a retry can never do something twice.
    const attempts = method === "GET" ? 3 : 1;
    let res: Response | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        res = await doFetch(url, {
          method,
          headers,
          body: init.form ?? (init.json === undefined ? undefined : JSON.stringify(init.json)),
        });
        if (res.status < 500 || attempt === attempts) break;
      } catch (err) {
        if (attempt === attempts) {
          const reason = err instanceof Error ? (err.cause ?? err.message) : String(err);
          throw new ApiClientError(`Could not reach ${base}: ${reason}`, "network_error", 0);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 300 * attempt));
    }
    if (!res) throw new ApiClientError(`Could not reach ${base}`, "network_error", 0);

    if (res.status === 204) return schema.parse(undefined);
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }

    if (!res.ok) {
      const parsed = errorSchema.safeParse(data);
      if (parsed.success) {
        const { code, message } = parsed.data.error;
        throw new ApiClientError(message, code, res.status);
      }
      throw new ApiClientError(
        `HTTP ${res.status} from ${url.host}`,
        `http_${res.status}`,
        res.status,
      );
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new ApiClientError(
        `Unexpected response from the API for ${method} ${path}`,
        "bad_response",
        res.status,
      );
    }
    return parsed.data;
  }

  return {
    listImages: (query: Partial<ListQuery>): Promise<ListResponse> =>
      request("GET", "/images", listResponseSchema, { query }),
    getImage: (id: string): Promise<ImageResponse> =>
      request("GET", `/images/${id}`, imageResponseSchema),
    uploadImage(
      file: File,
      fields: { site: string; tags?: string[]; alt?: string },
    ): Promise<UploadResponse> {
      const form = new FormData();
      form.set("file", file);
      form.set("site", fields.site);
      for (const tag of fields.tags ?? []) form.append("tags[]", tag);
      if (fields.alt) form.set("alt_text", fields.alt);
      return request("POST", "/images", uploadResponseSchema, { form });
    },
    patchImage: (id: string, body: PatchBody): Promise<ImageResponse> =>
      request("PATCH", `/images/${id}`, imageResponseSchema, { json: body }),
    softDelete: (id: string): Promise<ImageResponse> =>
      request("DELETE", `/images/${id}`, imageResponseSchema),
    hardDelete: (id: string): Promise<undefined> =>
      request("DELETE", `/images/${id}`, z.undefined(), { query: { hard: "true" } }),
    restoreImage: (id: string): Promise<ImageResponse> =>
      request("POST", `/images/${id}/restore`, imageResponseSchema),
    listSites: () => request("GET", "/sites", sitesResponseSchema),
    createSite: (body: CreateSiteBody) =>
      request("POST", "/sites", siteResponseSchema, { json: body }),
    listTokens: () => request("GET", "/tokens", tokensResponseSchema),
    createToken: (body: CreateTokenBody) =>
      request("POST", "/tokens", createdTokenResponseSchema, { json: body }),
    revokeToken: (id: string) => request("DELETE", `/tokens/${id}`, tokenResponseSchema),
  };
}

export type Client = ReturnType<typeof createClient>;
