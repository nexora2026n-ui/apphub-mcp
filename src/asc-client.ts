import type { AscTokenProvider } from "./jwt";

export const ASC_BASE_URL = "https://api.appstoreconnect.apple.com";

export type Query = Record<string, string | number | boolean | undefined>;

export interface JsonApiResource {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { type: string; id: string } | { type: string; id: string }[] | null }>;
}

export interface JsonApiDocument<T = JsonApiResource | JsonApiResource[]> {
  data: T;
  included?: JsonApiResource[];
  links?: { self?: string; next?: string };
  meta?: { paging?: { total?: number; limit?: number } };
}

export class AscApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: unknown[] = [],
  ) {
    super(message);
    this.name = "AscApiError";
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Minimal read-only App Store Connect API client.
 * Only GET is implemented on purpose: this server must not mutate anything.
 */
export class AscClient {
  constructor(
    private readonly tokens: Pick<AscTokenProvider, "getToken" | "invalidate">,
    private readonly fetchFn: FetchFn = (input, init) => fetch(input, init),
    private readonly baseUrl = ASC_BASE_URL,
  ) {}

  buildUrl(path: string, query: Query = {}): string {
    if (!/^\/v[1-9]\//.test(path)) throw new Error(`Invalid App Store Connect path: ${path}`);
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async get<T = JsonApiResource | JsonApiResource[]>(path: string, query: Query = {}): Promise<JsonApiDocument<T>> {
    return this.getUrl<T>(this.buildUrl(path, query));
  }

  /** Follows `links.next` until `maxItems` resources are collected. */
  async getAll(path: string, query: Query = {}, maxItems = 200): Promise<JsonApiDocument<JsonApiResource[]>> {
    const data: JsonApiResource[] = [];
    const included: JsonApiResource[] = [];
    let url: string | undefined = this.buildUrl(path, query);
    let total: number | undefined;
    while (url && data.length < maxItems) {
      const page: JsonApiDocument<JsonApiResource[]> = await this.getUrl<JsonApiResource[]>(url);
      data.push(...page.data);
      if (page.included) included.push(...page.included);
      total ??= page.meta?.paging?.total;
      url = page.links?.next;
    }
    return {
      data: data.slice(0, maxItems),
      included: dedupe(included),
      meta: { paging: { total } },
      links: url ? { next: url } : undefined,
    };
  }

  private async getUrl<T>(url: string, retried = false): Promise<JsonApiDocument<T>> {
    if (!url.startsWith(this.baseUrl + "/")) throw new Error("Refusing to call a non App Store Connect URL");
    const token = await this.tokens.getToken();
    const res = await this.fetchFn(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (res.status === 401 && !retried) {
      this.tokens.invalidate();
      return this.getUrl<T>(url, true);
    }
    if (!res.ok) throw await toError(res);
    return (await res.json()) as JsonApiDocument<T>;
  }
}

function dedupe(items: JsonApiResource[]): JsonApiResource[] {
  const seen = new Map<string, JsonApiResource>();
  for (const item of items) seen.set(`${item.type}:${item.id}`, item);
  return [...seen.values()];
}

async function toError(res: Response): Promise<AscApiError> {
  let details: unknown[] = [];
  let message = `App Store Connect API error ${res.status}`;
  try {
    const body = (await res.json()) as { errors?: { title?: string; detail?: string; code?: string }[] };
    if (Array.isArray(body.errors) && body.errors.length) {
      details = body.errors;
      const first = body.errors[0]!;
      message += `: ${[first.code, first.title, first.detail].filter(Boolean).join(" - ")}`;
    }
  } catch {
    // non-JSON body
  }
  if (res.status === 429) message += " (rate limited; retry later)";
  return new AscApiError(res.status, message, details);
}
