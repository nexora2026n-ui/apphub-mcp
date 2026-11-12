/**
 * Read-only App Store Connect tool handlers.
 * Kept free of the MCP SDK / zod so they can be unit-tested directly.
 */
import type { AscClient, JsonApiResource } from "./asc-client";

export interface ToolContext {
  asc: Pick<AscClient, "get" | "getAll">;
  /** Empty = all apps visible to the API key are allowed. */
  allowedAppIds: string[];
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export const PLATFORMS = ["IOS", "MAC_OS", "TV_OS", "VISION_OS"] as const;
export type Platform = (typeof PLATFORMS)[number];

// ---------- helpers ----------

/** Turns a JSON:API resource into `{ id, ...attributes }`. */
export function flatten(resource: JsonApiResource): Record<string, unknown> {
  return { id: resource.id, ...(resource.attributes ?? {}) };
}

function relatedIds(resource: JsonApiResource, name: string): string[] {
  const data = resource.relationships?.[name]?.data;
  if (!data) return [];
  return (Array.isArray(data) ? data : [data]).map((d) => d.id);
}

function findIncluded(included: JsonApiResource[] | undefined, type: string, id: string) {
  return included?.find((r) => r.type === type && r.id === id);
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(limit)));
}

function assertAllowed(ctx: ToolContext, appId: string): void {
  if (ctx.allowedAppIds.length && !ctx.allowedAppIds.includes(appId)) {
    throw new ToolInputError(`App ${appId} is not in ASC_ALLOWED_APP_IDS.`);
  }
}

/** Accepts a numeric App Store Connect app ID or a bundle ID and returns the app ID. */
export async function resolveAppId(ctx: ToolContext, app: string): Promise<string> {
  const value = app.trim();
  if (!value) throw new ToolInputError("`app` is required (App ID or bundle ID).");
  if (/^\d+$/.test(value)) {
    assertAllowed(ctx, value);
    return value;
  }
  const res = await ctx.asc.get<JsonApiResource[]>("/v1/apps", { "filter[bundleId]": value, limit: 50 });
  const match = res.data.find((a) => a.attributes?.bundleId === value);
  if (!match) throw new ToolInputError(`No app found with bundle ID "${value}".`);
  assertAllowed(ctx, match.id);
  return match.id;
}

// ---------- tools ----------

export async function listApps(ctx: ToolContext, args: { limit?: number }) {
  const limit = clampLimit(args.limit, 50, 200);
  const res = await ctx.asc.getAll("/v1/apps", { limit: Math.min(limit, 200), sort: "name" }, limit);
  const apps = res.data
    .filter((a) => !ctx.allowedAppIds.length || ctx.allowedAppIds.includes(a.id))
    .map((a) => {
      const f = flatten(a);
      return { id: f.id, name: f.name, bundleId: f.bundleId, sku: f.sku, primaryLocale: f.primaryLocale };
    });
  return { count: apps.length, apps };
}

export async function getApp(ctx: ToolContext, args: { app: string }) {
  const appId = await resolveAppId(ctx, args.app);
  const res = await ctx.asc.get<JsonApiResource>(`/v1/apps/${appId}`, {
    include: "appStoreVersions",
    "limit[appStoreVersions]": 5,
  });
  const versions = relatedIds(res.data, "appStoreVersions")
    .map((id) => findIncluded(res.included, "appStoreVersions", id))
    .filter((v): v is JsonApiResource => !!v)
    .map(summariseVersion);
  return { app: flatten(res.data), recentAppStoreVersions: versions };
}

function summariseVersion(v: JsonApiResource) {
  const a = v.attributes ?? {};
  return {
    id: v.id,
    versionString: a.versionString,
    platform: a.platform,
    appVersionState: a.appVersionState ?? a.appStoreState,
    appStoreState: a.appStoreState,
    releaseType: a.releaseType,
    earliestReleaseDate: a.earliestReleaseDate,
    createdDate: a.createdDate,
  };
}

export async function listAppStoreVersions(
  ctx: ToolContext,
  args: { app: string; platform?: Platform; versionString?: string; limit?: number },
) {
  const appId = await resolveAppId(ctx, args.app);
  const limit = clampLimit(args.limit, 20, 200);
  const res = await ctx.asc.getAll(
    `/v1/apps/${appId}/appStoreVersions`,
    { "filter[platform]": args.platform, "filter[versionString]": args.versionString, limit },
    limit,
  );
  return { appId, count: res.data.length, versions: res.data.map(summariseVersion) };
}

export async function listBuilds(
  ctx: ToolContext,
  args: { app: string; version?: string; buildNumber?: string; processingState?: string; limit?: number },
) {
  const appId = await resolveAppId(ctx, args.app);
  const limit = clampLimit(args.limit, 20, 200);
  const res = await ctx.asc.getAll(
    "/v1/builds",
    {
      "filter[app]": appId,
      "filter[preReleaseVersion.version]": args.version,
      "filter[version]": args.buildNumber,
      "filter[processingState]": args.processingState,
      sort: "-uploadedDate",
      include: "preReleaseVersion,buildBetaDetail",
      limit,
    },
    limit,
  );
  const builds = res.data.map((b) => summariseBuild(b, res.included));
  return { appId, count: builds.length, builds };
}

function summariseBuild(b: JsonApiResource, included: JsonApiResource[] | undefined) {
  const a = b.attributes ?? {};
  const pre = relatedIds(b, "preReleaseVersion")[0];
  const preRes = pre ? findIncluded(included, "preReleaseVersions", pre) : undefined;
  const beta = relatedIds(b, "buildBetaDetail")[0];
  const betaRes = beta ? findIncluded(included, "buildBetaDetails", beta) : undefined;
  return {
    id: b.id,
    buildNumber: a.version,
    marketingVersion: preRes?.attributes?.version,
    platform: preRes?.attributes?.platform,
    processingState: a.processingState,
    uploadedDate: a.uploadedDate,
    expirationDate: a.expirationDate,
    expired: a.expired,
    minOsVersion: a.minOsVersion,
    testFlight: betaRes
      ? {
          internalBuildState: betaRes.attributes?.internalBuildState,
          externalBuildState: betaRes.attributes?.externalBuildState,
          autoNotifyEnabled: betaRes.attributes?.autoNotifyEnabled,
        }
      : undefined,
  };
}

export async function getBuild(ctx: ToolContext, args: { buildId: string }) {
  const buildId = args.buildId.trim();
  if (!/^[\w-]+$/.test(buildId)) throw new ToolInputError("Invalid buildId.");
  const res = await ctx.asc.get<JsonApiResource>(`/v1/builds/${buildId}`, {
    include: "app,preReleaseVersion,buildBetaDetail",
  });
  const appId = relatedIds(res.data, "app")[0];
  if (appId) assertAllowed(ctx, appId);
  return { appId, build: summariseBuild(res.data, res.included) };
}

export async function getTestFlightInfo(ctx: ToolContext, args: { app: string; includeTesters?: boolean }) {
  const appId = await resolveAppId(ctx, args.app);
  const groups = await ctx.asc.getAll(`/v1/apps/${appId}/betaGroups`, { limit: 100 }, 100);
  const result = [];
  for (const g of groups.data) {
    const a = g.attributes ?? {};
    const group: Record<string, unknown> = {
      id: g.id,
      name: a.name,
      isInternalGroup: a.isInternalGroup,
      publicLinkEnabled: a.publicLinkEnabled,
      publicLink: a.publicLink,
      publicLinkLimit: a.publicLinkLimit,
      createdDate: a.createdDate,
    };
    if (args.includeTesters) {
      const testers = await ctx.asc.getAll(`/v1/betaGroups/${g.id}/betaTesters`, { limit: 200 }, 200);
      group.testers = testers.data.map((t) => {
        const ta = t.attributes ?? {};
        return { id: t.id, firstName: ta.firstName, lastName: ta.lastName, email: ta.email, inviteType: ta.inviteType, state: ta.state };
      });
    }
    result.push(group);
  }
  return { appId, betaGroupCount: result.length, betaGroups: result };
}

export async function listSubscriptions(ctx: ToolContext, args: { app: string }) {
  const appId = await resolveAppId(ctx, args.app);
  const res = await ctx.asc.getAll(
    `/v1/apps/${appId}/subscriptionGroups`,
    { include: "subscriptions", "limit[subscriptions]": 50, limit: 50 },
    200,
  );
  const groups = res.data.map((g) => ({
    id: g.id,
    referenceName: g.attributes?.referenceName,
    subscriptions: relatedIds(g, "subscriptions")
      .map((id) => findIncluded(res.included, "subscriptions", id))
      .filter((s): s is JsonApiResource => !!s)
      .map((s) => {
        const a = s.attributes ?? {};
        return {
          id: s.id,
          name: a.name,
          productId: a.productId,
          state: a.state,
          subscriptionPeriod: a.subscriptionPeriod,
          groupLevel: a.groupLevel,
          familySharable: a.familySharable,
        };
      }),
  }));
  return { appId, groupCount: groups.length, subscriptionGroups: groups };
}

export async function getSubscriptionPrices(
  ctx: ToolContext,
  args: { app: string; subscriptionId: string; territory?: string },
) {
  const { subscriptionGroups } = await listSubscriptions(ctx, { app: args.app });
  const owned = subscriptionGroups.some((g) => g.subscriptions.some((s) => s.id === args.subscriptionId));
  if (!owned) throw new ToolInputError(`Subscription ${args.subscriptionId} does not belong to app ${args.app}.`);
  const territory = args.territory?.trim().toUpperCase();
  if (territory && !/^[A-Z]{3}$/.test(territory)) throw new ToolInputError("territory must be an ISO alpha-3 code such as JPN or USA.");
  const res = await ctx.asc.getAll(
    `/v1/subscriptions/${args.subscriptionId}/prices`,
    { "filter[territory]": territory, include: "subscriptionPricePoint,territory", limit: 200 },
    territory ? 50 : 200,
  );
  const prices = res.data.map((p) => {
    const ppId = relatedIds(p, "subscriptionPricePoint")[0];
    const pp = ppId ? findIncluded(res.included, "subscriptionPricePoints", ppId) : undefined;
    const terrId = relatedIds(p, "territory")[0];
    const terr = terrId ? findIncluded(res.included, "territories", terrId) : undefined;
    return {
      id: p.id,
      territory: terrId,
      currency: terr?.attributes?.currency,
      customerPrice: pp?.attributes?.customerPrice,
      proceeds: pp?.attributes?.proceeds,
      startDate: p.attributes?.startDate,
      preserved: p.attributes?.preserved,
    };
  });
  return { subscriptionId: args.subscriptionId, count: prices.length, prices };
}
