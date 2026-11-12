import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AscApiError, AscClient } from "./asc-client";
import { parseList, type Env } from "./env";
import { AscTokenProvider } from "./jwt";
import * as tools from "./tools";

export const SERVER_INFO = { name: "apphub-mcp", version: "0.1.0" } as const;

// Token provider lives at module scope so the signed JWT is reused across requests in an isolate.
let tokenCache: { fingerprint: string; provider: AscTokenProvider } | undefined;

function getTokenProvider(env: Env): AscTokenProvider {
  const fingerprint = `${env.ASC_ISSUER_ID}:${env.ASC_KEY_ID}:${env.ASC_PRIVATE_KEY.length}`;
  if (!tokenCache || tokenCache.fingerprint !== fingerprint) {
    tokenCache = {
      fingerprint,
      provider: new AscTokenProvider({
        issuerId: env.ASC_ISSUER_ID.trim(),
        keyId: env.ASC_KEY_ID.trim(),
        privateKey: env.ASC_PRIVATE_KEY,
      }),
    };
  }
  return tokenCache.provider;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const appArg = z.string().min(1).describe("App Store Connect app ID (numeric) or bundle ID, e.g. com.example.app");
const limitArg = (max: number) => z.number().int().min(1).max(max).optional().describe(`Max items (1-${max})`);

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

async function run(fn: () => Promise<unknown>): Promise<Result> {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    const message =
      err instanceof AscApiError || err instanceof tools.ToolInputError || err instanceof Error
        ? err.message
        : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

/** Builds a fresh McpServer per request (required for stateless Streamable HTTP with the current SDK). */
export function createMcpServer(env: Env): McpServer {
  const ctx: tools.ToolContext = {
    asc: new AscClient(getTokenProvider(env)),
    allowedAppIds: parseList(env.ASC_ALLOWED_APP_IDS),
  };
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "list_apps",
    {
      title: "List apps",
      description: "List App Store Connect apps (ID, name, bundle ID, SKU). Respects ASC_ALLOWED_APP_IDS.",
      inputSchema: { limit: limitArg(200) },
      annotations: READ_ONLY,
    },
    async (args) => run(() => tools.listApps(ctx, args)),
  );

  server.registerTool(
    "get_app",
    {
      title: "Get app details",
      description: "Get details of one app plus its most recent App Store versions.",
      inputSchema: { app: appArg },
      annotations: READ_ONLY,
    },
    async (args) => run(() => tools.getApp(ctx, args)),
  );

  server.registerTool(
    "list_app_store_versions",
    {
      title: "List App Store versions",
      description: "List App Store versions of an app with their state (e.g. READY_FOR_SALE, IN_REVIEW).",
      inputSchema: {
        app: appArg,
        platform: z.enum(tools.PLATFORMS).optional(),
        versionString: z.string().optional().describe("Exact marketing version, e.g. 1.2.0"),
        limit: limitArg(200),
      },
      annotations: READ_ONLY,
    },
    async (args) => run(() => tools.listAppStoreVersions(ctx, args)),
  );

  server.registerTool(
    "list_builds",
    {
      title: "List builds",
      description: "List uploaded builds of an app, newest first, with processing and TestFlight state.",
      inputSchema: {
        app: appArg,
        version: z.string().optional().describe("Marketing version (pre-release version), e.g. 1.2.0"),
        buildNumber: z.string().optional().describe("Build number (CFBundleVersion)"),
        processingState: z.enum(["PROCESSING", "FAILED", "INVALID", "VALID"]).optional(),
        limit: limitArg(200),
      },
      annotations: READ_ONLY,
    },
    async (args) => run(() => tools.listBuilds(ctx, args)),
  );

  server.registerTool(
    "get_build",
    {
      title: "Get build",
      description: "Get one build by ID, including its TestFlight (beta) build state.",
      inputSchema: { buildId: z.string().min(1) },
      annotations: READ_ONLY,
    },
    async (args) => run(() => tools.getBuild(ctx, args)),
  );

  server.registerTool(
    "get_testflight_info",
    {
      title: "Get TestFlight info",
      description: "List TestFlight beta groups (internal/external, public link). Optionally include testers (contains emails).",
      inputSchema: { app: appArg, includeTesters: z.boolean().optional() },
      annotations: READ_ONLY,
    },
    async (args) => run(() => tools.getTestFlightInfo(ctx, args)),
  );

  server.registerTool(
    "list_subscriptions",
    {
      title: "List subscriptions",
      description: "List auto-renewable subscription groups and subscriptions (product ID, period, state).",
      inputSchema: { app: appArg },
      annotations: READ_ONLY,
    },
    async (args) => run(() => tools.listSubscriptions(ctx, args)),
  );

  server.registerTool(
    "get_subscription_prices",
    {
      title: "Get subscription prices",
      description: "Get price schedule (customer price, proceeds) of a subscription, optionally for one territory.",
      inputSchema: {
        app: appArg,
        subscriptionId: z.string().min(1),
        territory: z.string().length(3).optional().describe("ISO 3166 alpha-3 code, e.g. JPN, USA"),
      },
      annotations: READ_ONLY,
    },
    async (args) => run(() => tools.getSubscriptionPrices(ctx, args)),
  );

  return server;
}
