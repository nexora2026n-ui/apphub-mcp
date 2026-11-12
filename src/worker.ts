/**
 * HTTP routing + auth, independent of the MCP SDK so it can be tested in isolation.
 *
 * /mcp accepts either:
 *  - the static MCP_BEARER_TOKEN (CLI / mcp-remote / Inspector), or
 *  - an OAuth access token issued by this Worker (Claude custom connectors).
 */
import { extractBearer, isAuthorized } from "./auth";
import { missingSecrets, parseList, type Env } from "./env";
import * as oauth from "./oauth";

export type McpFetchHandler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });

const MCP_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
};

let signerCache: { secret: string; signer: oauth.OAuthSigner } | undefined;
function getSigner(env: Env): oauth.OAuthSigner {
  const secret = parseList(env.MCP_BEARER_TOKEN)[0] ?? "";
  if (!signerCache || signerCache.secret !== secret) signerCache = { secret, signer: new oauth.OAuthSigner(secret) };
  return signerCache.signer;
}

export function createWorker(mcpHandler: McpFetchHandler, signerFactory: (env: Env) => oauth.OAuthSigner = getSigner) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/" || path === "/health") {
        // No secrets or config details are exposed here.
        return json({ name: "apphub-mcp", status: "ok", mcpEndpoint: `${url.origin}/mcp` });
      }

      const missing = missingSecrets(env);
      const tokenMissing = missing.includes("MCP_BEARER_TOKEN");

      // ----- OAuth discovery + endpoints (for Claude custom connectors) -----
      if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
        return oauth.protectedResourceMetadata(request);
      }
      if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/mcp") {
        return oauth.authorizationServerMetadata(request);
      }
      if (path === "/register" || path === "/authorize" || path === "/token") {
        if (tokenMissing) return json({ error: "server_misconfigured", message: "MCP_BEARER_TOKEN is not set." }, 503);
        const signer = signerFactory(env);
        if (path === "/register") return oauth.register(request, signer);
        if (path === "/authorize") return oauth.authorize(request, signer, env.MCP_BEARER_TOKEN);
        return oauth.token(request, signer);
      }

      // ----- MCP -----
      if (path !== "/mcp" && !path.startsWith("/mcp/")) {
        return json({ error: "not_found" }, 404);
      }

      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: MCP_CORS });

      if (tokenMissing) {
        // Fail closed: never serve MCP without an access token configured.
        return json({ error: "server_misconfigured", message: "MCP_BEARER_TOKEN is not set." }, 503, MCP_CORS);
      }

      const presented = extractBearer(request);
      const authorized =
        !!presented &&
        ((await isAuthorized(request, env.MCP_BEARER_TOKEN)) ||
          (await oauth.verifyAccessToken(signerFactory(env), presented)));
      if (!authorized) {
        return json({ error: "unauthorized" }, 401, {
          ...MCP_CORS,
          "WWW-Authenticate": `Bearer realm="apphub-mcp", resource_metadata="${oauth.protectedResourceMetadataUrl(request)}"`,
        });
      }

      if (missing.length) {
        return json({ error: "server_misconfigured", message: `Missing secrets: ${missing.join(", ")}` }, 503, MCP_CORS);
      }

      // Normalise /mcp/ to /mcp for the SDK handler (registered on route "/mcp").
      const mcpRequest = url.pathname === "/mcp" ? request : new Request(new URL("/mcp" + url.search, url), request);
      const res = await mcpHandler(mcpRequest, env, ctx);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(MCP_CORS)) if (!headers.has(k)) headers.set(k, v);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    },
  };
}
