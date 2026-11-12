/**
 * HTTP routing + bearer auth, independent of the MCP SDK so it can be tested in isolation.
 */
import { isAuthorized } from "./auth";
import { missingSecrets, type Env } from "./env";

export type McpFetchHandler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });

export function createWorker(mcpHandler: McpFetchHandler) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname === "/" || url.pathname === "/health") {
        // No secrets or config details are exposed here.
        return json({ name: "apphub-mcp", status: "ok", mcpEndpoint: "/mcp" });
      }

      if (url.pathname !== "/mcp" && !url.pathname.startsWith("/mcp/")) {
        return json({ error: "not_found" }, 404);
      }

      const missing = missingSecrets(env);
      if (missing.includes("MCP_BEARER_TOKEN")) {
        // Fail closed: never serve MCP without an access token configured.
        return json({ error: "server_misconfigured", message: "MCP_BEARER_TOKEN is not set." }, 503);
      }

      if (!(await isAuthorized(request, env.MCP_BEARER_TOKEN))) {
        return json({ error: "unauthorized" }, 401, {
          "WWW-Authenticate": 'Bearer realm="apphub-mcp"',
        });
      }

      if (missing.length) {
        return json(
          { error: "server_misconfigured", message: `Missing secrets: ${missing.join(", ")}` },
          503,
        );
      }

      return mcpHandler(request, env, ctx);
    },
  };
}
