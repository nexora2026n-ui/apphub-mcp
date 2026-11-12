import assert from "node:assert/strict";
import { test } from "node:test";
import { AscApiError, AscClient, type JsonApiResource } from "../src/asc-client";
import * as tools from "../src/tools";

const BASE = "https://api.appstoreconnect.apple.com";

function fakeTokens() {
  let n = 0;
  return { getToken: async () => `tok${n}`, invalidate: () => void n++ };
}

type Route = (url: URL) => unknown;
function fakeFetch(routes: Record<string, Route>, log: { url: string; init?: RequestInit }[] = []) {
  return async (input: string, init?: RequestInit) => {
    log.push({ url: input, init });
    const url = new URL(input);
    const route = routes[url.pathname];
    if (!route) return new Response(JSON.stringify({ errors: [{ code: "NOT_FOUND", title: "nf" }] }), { status: 404 });
    const body = route(url);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

const app = (id: string, bundleId: string, name = bundleId): JsonApiResource => ({
  type: "apps",
  id,
  attributes: { name, bundleId, sku: `sku-${id}`, primaryLocale: "ja" },
});

test("client sends GET with bearer JWT and query params", async () => {
  const log: { url: string; init?: RequestInit }[] = [];
  const client = new AscClient(fakeTokens(), fakeFetch({ "/v1/apps": () => ({ data: [] }) }, log));
  await client.get("/v1/apps", { "filter[bundleId]": "com.a", limit: 5, skip: undefined });
  assert.equal(log.length, 1);
  const { url, init } = log[0]!;
  assert.equal(init?.method, "GET");
  assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer tok0");
  const u = new URL(url);
  assert.equal(u.searchParams.get("filter[bundleId]"), "com.a");
  assert.equal(u.searchParams.get("limit"), "5");
  assert.ok(!u.searchParams.has("skip"));
});

test("client rejects non-API paths and foreign next links", async () => {
  const client = new AscClient(
    fakeTokens(),
    fakeFetch({ "/v1/apps": () => ({ data: [app("1", "a")], links: { next: "https://evil.example/v1/apps" } }) }),
  );
  assert.throws(() => client.buildUrl("https://evil.example/x"), /Invalid/);
  assert.throws(() => client.buildUrl("/admin"), /Invalid/);
  await assert.rejects(client.getAll("/v1/apps", {}, 10), /non App Store Connect/);
});

test("client paginates up to maxItems", async () => {
  let page = 0;
  const client = new AscClient(
    fakeTokens(),
    fakeFetch({
      "/v1/apps": () => {
        page++;
        return {
          data: [app(`${page}a`, `b${page}a`), app(`${page}b`, `b${page}b`)],
          links: page < 5 ? { next: `${BASE}/v1/apps?cursor=${page}` } : {},
          meta: { paging: { total: 10 } },
        };
      },
    }),
  );
  const res = await client.getAll("/v1/apps", {}, 3);
  assert.equal(res.data.length, 3);
  assert.equal(page, 2);
  assert.equal(res.meta?.paging?.total, 10);
});

test("client maps Apple errors and retries once on 401 with a fresh token", async () => {
  const tokens = fakeTokens();
  const seen: string[] = [];
  const client = new AscClient(tokens, async (_url, init) => {
    seen.push((init?.headers as Record<string, string>).Authorization!);
    return new Response(
      JSON.stringify({ errors: [{ code: "NOT_AUTHORIZED", title: "Authentication credentials are missing or invalid." }] }),
      { status: 401 },
    );
  });
  const err = await client.get("/v1/apps").catch((e) => e);
  assert.ok(err instanceof AscApiError);
  assert.equal(err.status, 401);
  assert.match(err.message, /NOT_AUTHORIZED/);
  assert.deepEqual(seen, ["Bearer tok0", "Bearer tok1"]);

  const rl = new AscClient(fakeTokens(), async () => new Response("", { status: 429 }));
  await assert.rejects(rl.get("/v1/apps"), /rate limited/);
});

// ---------- tools ----------

function ctxWith(routes: Record<string, Route>, allowedAppIds: string[] = []): tools.ToolContext {
  return { asc: new AscClient(fakeTokens(), fakeFetch(routes)), allowedAppIds };
}

const appsRoute: Route = (url) => {
  const all = [app("111", "com.example.one", "One"), app("222", "com.example.two", "Two"), app("333", "com.example.one.widget")];
  const bundle = url.searchParams.get("filter[bundleId]");
  return { data: bundle ? all.filter((a) => String(a.attributes!.bundleId).startsWith(bundle)) : all };
};

test("list_apps supports multiple apps and the allowlist", async () => {
  const all = await tools.listApps(ctxWith({ "/v1/apps": appsRoute }), {});
  assert.equal(all.count, 3);
  assert.deepEqual(all.apps[0], { id: "111", name: "One", bundleId: "com.example.one", sku: "sku-111", primaryLocale: "ja" });
  const limited = await tools.listApps(ctxWith({ "/v1/apps": appsRoute }, ["222"]), {});
  assert.deepEqual(limited.apps.map((a) => a.id), ["222"]);
});

test("resolveAppId accepts app IDs and exact bundle IDs, enforcing the allowlist", async () => {
  const ctx = ctxWith({ "/v1/apps": appsRoute });
  assert.equal(await tools.resolveAppId(ctx, "222"), "222");
  assert.equal(await tools.resolveAppId(ctx, "com.example.one"), "111"); // exact match, not the widget
  await assert.rejects(tools.resolveAppId(ctx, "com.nope"), /No app found/);
  const restricted = ctxWith({ "/v1/apps": appsRoute }, ["222"]);
  await assert.rejects(tools.resolveAppId(restricted, "111"), /ASC_ALLOWED_APP_IDS/);
  await assert.rejects(tools.resolveAppId(restricted, "com.example.one"), /ASC_ALLOWED_APP_IDS/);
});

test("get_app returns app details and recent versions", async () => {
  const ctx = ctxWith({
    "/v1/apps/111": (url) => {
      assert.equal(url.searchParams.get("include"), "appStoreVersions");
      return {
        data: { ...app("111", "com.example.one", "One"), relationships: { appStoreVersions: { data: [{ type: "appStoreVersions", id: "v1" }] } } },
        included: [{ type: "appStoreVersions", id: "v1", attributes: { versionString: "1.0", platform: "IOS", appVersionState: "READY_FOR_DISTRIBUTION" } }],
      };
    },
  });
  const res = await tools.getApp(ctx, { app: "111" });
  assert.equal(res.app.name, "One");
  assert.equal(res.recentAppStoreVersions[0]?.versionString, "1.0");
  assert.equal(res.recentAppStoreVersions[0]?.appVersionState, "READY_FOR_DISTRIBUTION");
});

test("list_app_store_versions passes filters", async () => {
  const ctx = ctxWith({
    "/v1/apps/111/appStoreVersions": (url) => {
      assert.equal(url.searchParams.get("filter[platform]"), "IOS");
      return { data: [{ type: "appStoreVersions", id: "v2", attributes: { versionString: "2.0", appStoreState: "IN_REVIEW" } }] };
    },
  });
  const res = await tools.listAppStoreVersions(ctx, { app: "111", platform: "IOS" });
  assert.equal(res.versions[0]?.appVersionState, "IN_REVIEW");
});

const buildDoc = (id: string) => ({
  type: "builds",
  id,
  attributes: { version: "42", processingState: "VALID", uploadedDate: "2026-11-01T00:00:00Z", expired: false },
  relationships: {
    app: { data: { type: "apps", id: "111" } },
    preReleaseVersion: { data: { type: "preReleaseVersions", id: "pre1" } },
    buildBetaDetail: { data: { type: "buildBetaDetails", id: "bbd1" } },
  },
});
const buildIncluded = [
  { type: "preReleaseVersions", id: "pre1", attributes: { version: "1.2.0", platform: "IOS" } },
  { type: "buildBetaDetails", id: "bbd1", attributes: { internalBuildState: "IN_BETA_TESTING", externalBuildState: "READY_FOR_BETA_SUBMISSION" } },
];

test("list_builds joins pre-release version and TestFlight state", async () => {
  const ctx = ctxWith({
    "/v1/builds": (url) => {
      assert.equal(url.searchParams.get("filter[app]"), "111");
      assert.equal(url.searchParams.get("sort"), "-uploadedDate");
      return { data: [buildDoc("b1")], included: buildIncluded };
    },
  });
  const res = await tools.listBuilds(ctx, { app: "111" });
  assert.equal(res.builds[0]?.buildNumber, "42");
  assert.equal(res.builds[0]?.marketingVersion, "1.2.0");
  assert.equal(res.builds[0]?.testFlight?.internalBuildState, "IN_BETA_TESTING");
});

test("get_build enforces the allowlist via the build's app", async () => {
  const routes = { "/v1/builds/b1": () => ({ data: buildDoc("b1"), included: buildIncluded }) };
  const res = await tools.getBuild(ctxWith(routes), { buildId: "b1" });
  assert.equal(res.appId, "111");
  await assert.rejects(tools.getBuild(ctxWith(routes, ["222"]), { buildId: "b1" }), /ASC_ALLOWED_APP_IDS/);
  await assert.rejects(tools.getBuild(ctxWith(routes), { buildId: "../x" }), /Invalid buildId/);
});

test("get_testflight_info lists groups and optional testers", async () => {
  const ctx = ctxWith({
    "/v1/apps/111/betaGroups": () => ({ data: [{ type: "betaGroups", id: "g1", attributes: { name: "Internal", isInternalGroup: true } }] }),
    "/v1/betaGroups/g1/betaTesters": () => ({ data: [{ type: "betaTesters", id: "t1", attributes: { email: "a@example.com", state: "ACCEPTED" } }] }),
  });
  const noTesters = await tools.getTestFlightInfo(ctx, { app: "111" });
  assert.equal(noTesters.betaGroups[0]?.name, "Internal");
  assert.equal(noTesters.betaGroups[0]?.testers, undefined);
  const withTesters = await tools.getTestFlightInfo(ctx, { app: "111", includeTesters: true });
  assert.equal((withTesters.betaGroups[0]?.testers as { email: string }[])[0]?.email, "a@example.com");
});

const subsRoutes: Record<string, Route> = {
  "/v1/apps/111/subscriptionGroups": () => ({
    data: [{ type: "subscriptionGroups", id: "sg1", attributes: { referenceName: "Premium" }, relationships: { subscriptions: { data: [{ type: "subscriptions", id: "s1" }] } } }],
    included: [{ type: "subscriptions", id: "s1", attributes: { name: "Monthly", productId: "premium.monthly", subscriptionPeriod: "ONE_MONTH", state: "APPROVED" } }],
  }),
  "/v1/subscriptions/s1/prices": (url) => {
    assert.equal(url.searchParams.get("filter[territory]"), "JPN");
    return {
      data: [{ type: "subscriptionPrices", id: "p1", attributes: { startDate: null }, relationships: { subscriptionPricePoint: { data: { type: "subscriptionPricePoints", id: "pp1" } }, territory: { data: { type: "territories", id: "JPN" } } } }],
      included: [
        { type: "subscriptionPricePoints", id: "pp1", attributes: { customerPrice: "480", proceeds: "336" } },
        { type: "territories", id: "JPN", attributes: { currency: "JPY" } },
      ],
    };
  },
};

test("list_subscriptions returns groups with subscriptions", async () => {
  const res = await tools.listSubscriptions(ctxWith(subsRoutes), { app: "111" });
  assert.equal(res.subscriptionGroups[0]?.referenceName, "Premium");
  assert.equal(res.subscriptionGroups[0]?.subscriptions[0]?.productId, "premium.monthly");
});

test("get_subscription_prices checks ownership and joins price points", async () => {
  const ctx = ctxWith(subsRoutes);
  const res = await tools.getSubscriptionPrices(ctx, { app: "111", subscriptionId: "s1", territory: "jpn" });
  assert.deepEqual(res.prices[0], { id: "p1", territory: "JPN", currency: "JPY", customerPrice: "480", proceeds: "336", startDate: null, preserved: undefined });
  await assert.rejects(tools.getSubscriptionPrices(ctx, { app: "111", subscriptionId: "other" }), /does not belong/);
  await assert.rejects(tools.getSubscriptionPrices(ctx, { app: "111", subscriptionId: "s1", territory: "JP" }), /alpha-3/);
});
