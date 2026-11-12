/**
 * Minimal, stateless OAuth 2.1 authorization server for MCP clients such as Claude custom connectors.
 *
 * - No storage needed: client IDs, authorization codes and tokens are HMAC-signed blobs.
 * - The signing key is derived from MCP_BEARER_TOKEN, so no new secret is required.
 *   Rotating MCP_BEARER_TOKEN revokes every OAuth token.
 * - The owner approves a connection by entering MCP_BEARER_TOKEN on the /authorize page.
 * - PKCE (S256) is mandatory, as required by the MCP authorization spec.
 */
import { timingSafeEqual } from "./auth";
import { parseList } from "./env";

const encoder = new TextEncoder();
const ACCESS_TOKEN_TTL = 60 * 60; // 1 hour
const REFRESH_TOKEN_TTL = 60 * 60 * 24 * 30; // 30 days
const CODE_TTL = 5 * 60; // 5 minutes
export const SCOPE = "mcp";

type TokenKind = "client" | "code" | "access" | "refresh";

interface Signed {
  k: TokenKind;
  exp?: number;
  [key: string]: unknown;
}

// ---------- signing ----------

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  // Domain-separated so the raw bearer token is never used directly as the HMAC key.
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`apphub-mcp/oauth/v1:${secret}`));
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export class OAuthSigner {
  private keyPromise: Promise<CryptoKey>;
  constructor(
    secret: string,
    readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.keyPromise = hmacKey(secret);
  }

  async sign(payload: Signed): Promise<string> {
    const body = b64url(encoder.encode(JSON.stringify(payload)));
    const sig = await crypto.subtle.sign("HMAC", await this.keyPromise, encoder.encode(body));
    return `${body}.${b64url(new Uint8Array(sig))}`;
  }

  async verify<T extends Signed>(token: string | null | undefined, kind: TokenKind): Promise<T | null> {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [body, sig] = parts as [string, string];
    let ok = false;
    try {
      ok = await crypto.subtle.verify("HMAC", await this.keyPromise, b64urlDecode(sig), encoder.encode(body));
    } catch {
      return null;
    }
    if (!ok) return null;
    let payload: T;
    try {
      payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as T;
    } catch {
      return null;
    }
    if (payload.k !== kind) return null;
    if (payload.exp !== undefined && payload.exp < this.now()) return null;
    return payload;
  }
}

// ---------- helpers ----------

const jsonRes = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      ...extra,
    },
  });

const oauthError = (error: string, description: string, status = 400) =>
  jsonRes({ error, error_description: description }, status);

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function sha256b64url(value: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

/** Redirect URIs must be https, or http on loopback (for local MCP clients). */
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

export function origin(request: Request): string {
  return new URL(request.url).origin;
}

export function protectedResourceMetadataUrl(request: Request): string {
  return `${origin(request)}/.well-known/oauth-protected-resource/mcp`;
}

// ---------- endpoints ----------

export function protectedResourceMetadata(request: Request): Response {
  const base = origin(request);
  return jsonRes({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "AppHub MCP (App Store Connect)",
  });
}

export function authorizationServerMetadata(request: Request): Response {
  const base = origin(request);
  return jsonRes({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
  });
}

interface ClientPayload extends Signed {
  k: "client";
  ru: string[];
  n?: string;
}

/** RFC 7591 dynamic client registration. The client_id itself carries the signed redirect URIs. */
export async function register(request: Request, signer: OAuthSigner): Promise<Response> {
  if (request.method === "OPTIONS") return cors();
  if (request.method !== "POST") return oauthError("invalid_request", "POST required", 405);
  let body: { redirect_uris?: unknown; client_name?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return oauthError("invalid_client_metadata", "Body must be JSON");
  }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (!uris.length || uris.length > 10 || !uris.every(isAllowedRedirectUri)) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be https (or http://localhost) URLs");
  }
  const name = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : undefined;
  const clientId = await signer.sign({ k: "client", ru: uris, n: name } satisfies ClientPayload);
  return jsonRes(
    {
      client_id: clientId,
      client_id_issued_at: signer.now(),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201,
  );
}

interface AuthParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  resource: string;
}

function readAuthParams(get: (k: string) => string | null): AuthParams {
  return {
    clientId: get("client_id") ?? "",
    redirectUri: get("redirect_uri") ?? "",
    state: get("state") ?? "",
    codeChallenge: get("code_challenge") ?? "",
    codeChallengeMethod: get("code_challenge_method") ?? "",
    scope: get("scope") ?? SCOPE,
    resource: get("resource") ?? "",
  };
}

async function validateAuthParams(p: AuthParams, signer: OAuthSigner): Promise<{ client: ClientPayload } | { error: string }> {
  const client = await signer.verify<ClientPayload>(p.clientId, "client");
  if (!client) return { error: "Unknown client_id. Remove and re-add the connector." };
  if (!client.ru.includes(p.redirectUri)) return { error: "redirect_uri does not match the registered client." };
  if (p.codeChallengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(p.codeChallenge)) {
    return { error: "PKCE with code_challenge_method=S256 is required." };
  }
  return { client };
}

function redirectWith(redirectUri: string, params: Record<string, string>): Response {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: u.toString(), "Cache-Control": "no-store" } });
}

function page(title: string, inner: string, status = 200): Response {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:420px;margin:48px auto;padding:0 20px;color:#1d1d1f}
h1{font-size:22px}p{line-height:1.6;color:#444}input{width:100%;box-sizing:border-box;font-size:16px;padding:12px;border:1px solid #ccc;border-radius:10px;margin:8px 0 16px}
button{width:100%;font-size:16px;padding:12px;border:0;border-radius:10px;background:#0a84ff;color:#fff}.err{color:#c00}.muted{font-size:13px;color:#888}</style>
</head><body>${inner}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function approvalForm(p: AuthParams, clientName: string | undefined, error?: string): Response {
  const hidden = Object.entries({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: p.codeChallengeMethod,
    scope: p.scope,
    resource: p.resource,
  })
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join("");
  const host = (() => {
    try {
      return new URL(p.redirectUri).host;
    } catch {
      return "";
    }
  })();
  return page(
    "AppHub MCP に接続",
    `<h1>AppHub MCP に接続</h1>
<p><b>${escapeHtml(clientName ?? "MCP クライアント")}</b>（${escapeHtml(host)}）が App Store Connect の読み取りを求めています。</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/authorize">${hidden}
<label for="t">アクセストークン（Cloudflare に設定した MCP_BEARER_TOKEN）</label>
<input id="t" name="access_token" type="password" autocomplete="current-password" required autofocus>
<button type="submit">許可する</button></form>
<p class="muted">許可しない場合はこのページを閉じてください。</p>`,
    error ? 401 : 200,
  );
}

export async function authorize(request: Request, signer: OAuthSigner, bearerTokens: string): Promise<Response> {
  if (request.method === "GET") {
    const url = new URL(request.url);
    const p = readAuthParams((k) => url.searchParams.get(k));
    if (url.searchParams.get("response_type") !== "code") {
      return page("エラー", `<h1>エラー</h1><p>response_type=code が必要です。</p>`, 400);
    }
    const v = await validateAuthParams(p, signer);
    if ("error" in v) return page("エラー", `<h1>エラー</h1><p>${escapeHtml(v.error)}</p>`, 400);
    return approvalForm(p, v.client.n);
  }

  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const form = await request.formData();
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : null;
  };
  const p = readAuthParams(get);
  const v = await validateAuthParams(p, signer);
  if ("error" in v) return page("エラー", `<h1>エラー</h1><p>${escapeHtml(v.error)}</p>`, 400);

  const entered = (get("access_token") ?? "").trim();
  let ok = false;
  for (const t of parseList(bearerTokens)) if (entered && (await timingSafeEqual(entered, t))) ok = true;
  if (!ok) return approvalForm(p, v.client.n, "トークンが正しくありません。");

  const code = await signer.sign({
    k: "code",
    exp: signer.now() + CODE_TTL,
    cid: await sha256b64url(p.clientId),
    ru: p.redirectUri,
    cc: p.codeChallenge,
    sc: SCOPE,
  });
  return redirectWith(p.redirectUri, { code, state: p.state });
}

async function issueTokens(signer: OAuthSigner, clientIdHash: string): Promise<Response> {
  const now = signer.now();
  const access = await signer.sign({ k: "access", exp: now + ACCESS_TOKEN_TTL, cid: clientIdHash, sc: SCOPE });
  const refresh = await signer.sign({ k: "refresh", exp: now + REFRESH_TOKEN_TTL, cid: clientIdHash, sc: SCOPE });
  return jsonRes({
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: refresh,
    scope: SCOPE,
  });
}

export async function token(request: Request, signer: OAuthSigner): Promise<Response> {
  if (request.method === "OPTIONS") return cors();
  if (request.method !== "POST") return oauthError("invalid_request", "POST required", 405);
  let form: URLSearchParams;
  const type = request.headers.get("Content-Type") ?? "";
  if (type.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    form = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]));
  } else {
    form = new URLSearchParams(await request.text());
  }
  const grant = form.get("grant_type");
  const clientId = form.get("client_id") ?? "";

  if (grant === "authorization_code") {
    const code = await signer.verify<Signed & { cid: string; ru: string; cc: string }>(form.get("code"), "code");
    if (!code) return oauthError("invalid_grant", "Invalid or expired authorization code");
    if (clientId && (await sha256b64url(clientId)) !== code.cid) return oauthError("invalid_grant", "client_id mismatch");
    if (form.get("redirect_uri") && form.get("redirect_uri") !== code.ru) return oauthError("invalid_grant", "redirect_uri mismatch");
    const verifier = form.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || (await sha256b64url(verifier)) !== code.cc) {
      return oauthError("invalid_grant", "PKCE verification failed");
    }
    return issueTokens(signer, code.cid);
  }

  if (grant === "refresh_token") {
    const rt = await signer.verify<Signed & { cid: string }>(form.get("refresh_token"), "refresh");
    if (!rt) return oauthError("invalid_grant", "Invalid or expired refresh token");
    if (clientId && (await sha256b64url(clientId)) !== rt.cid) return oauthError("invalid_grant", "client_id mismatch");
    return issueTokens(signer, rt.cid);
  }

  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

export async function verifyAccessToken(signer: OAuthSigner, presented: string): Promise<boolean> {
  return (await signer.verify(presented, "access")) !== null;
}

function cors(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
      "Access-Control-Max-Age": "86400",
    },
  });
}
