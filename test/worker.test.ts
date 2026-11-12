import assert from "node:assert/strict";
import { test } from "node:test";
import { extractBearer, isAuthorized, timingSafeEqual } from "../src/auth";
import type { Env } from "../src/env";
import { createWorker } from "../src/worker";

const env: Env = {
  ASC_ISSUER_ID: "issuer",
  ASC_KEY_ID: "key",
  ASC_PRIVATE_KEY: "pem",
  MCP_BEARER_TOKEN: "secret-token, rotated-token",
};
const ctx = {} as ExecutionContext;

let calls = 0;
const worker = createWorker(async () => {
  calls++;
  return new Response("mcp-ok");
});

const req = (path: string, token?: string) =>
  new Request(`https://example.workers.dev${path}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

test("timingSafeEqual and bearer parsing", async () => {
  assert.ok(await timingSafeEqual("abc", "abc"));
  assert.ok(!(await timingSafeEqual("abc", "abcd")));
  assert.equal(extractBearer(req("/mcp", "x y")), "x y");
  assert.equal(extractBearer(new Request("https://a", { headers: { Authorization: "Basic abc" } })), null);
  assert.ok(await isAuthorized(req("/mcp", "rotated-token"), env.MCP_BEARER_TOKEN));
  assert.ok(!(await isAuthorized(req("/mcp", "nope"), env.MCP_BEARER_TOKEN)));
  assert.ok(!(await isAuthorized(req("/mcp", "anything"), "")));
});

test("health endpoint is public and leaks nothing", async () => {
  const res = await worker.fetch(new Request("https://x/health"), env, ctx);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(!body.includes("secret") && !body.includes("issuer"));
});

test("/mcp requires a valid bearer token", async () => {
  calls = 0;
  const noAuth = await worker.fetch(req("/mcp"), env, ctx);
  assert.equal(noAuth.status, 401);
  assert.match(noAuth.headers.get("WWW-Authenticate") ?? "", /Bearer/);
  assert.equal((await worker.fetch(req("/mcp", "wrong"), env, ctx)).status, 401);
  assert.equal(calls, 0);
  const ok = await worker.fetch(req("/mcp", "secret-token"), env, ctx);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "mcp-ok");
  assert.equal(calls, 1);
});

test("fails closed when the bearer token is not configured", async () => {
  const res = await worker.fetch(req("/mcp", "anything"), { ...env, MCP_BEARER_TOKEN: "" }, ctx);
  assert.equal(res.status, 503);
});

test("reports missing Apple secrets only to authorised callers", async () => {
  const partial = { ...env, ASC_PRIVATE_KEY: "" };
  assert.equal((await worker.fetch(req("/mcp"), partial, ctx)).status, 401);
  const res = await worker.fetch(req("/mcp", "secret-token"), partial, ctx);
  assert.equal(res.status, 503);
  assert.match(await res.text(), /ASC_PRIVATE_KEY/);
});

test("unknown paths return 404", async () => {
  assert.equal((await worker.fetch(req("/admin", "secret-token"), env, ctx)).status, 404);
});
