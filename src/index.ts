import { createMcpHandler } from "agents/mcp";
import type { Env } from "./env";
import { createMcpServer } from "./server";
import { createWorker } from "./worker";

/**
 * Cloudflare Worker entry point.
 * - GET /health          : unauthenticated liveness check
 * - /mcp (POST/GET/DELETE): MCP over Streamable HTTP, requires `Authorization: Bearer <MCP_BEARER_TOKEN>`
 */
export default createWorker((request, env, ctx) => {
  const handler = createMcpHandler(createMcpServer(env), { route: "/mcp" });
  return handler(request, env, ctx);
}) satisfies ExportedHandler<Env>;
