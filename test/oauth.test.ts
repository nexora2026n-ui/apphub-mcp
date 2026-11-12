import assert from "node:assert/strict";
import { test } from "node:test";
import type { Env } from "../src/env";
import { OAuthSigner, isAllowedRedirectUri } from "../src/oauth";
import { createWorker } from "../src/worker";

const BASE = "https://apphub-mcp.example.workers.dev";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const env: Env = { ASC_ISSUER_ID: "i", ASC_KEY_ID: "k", ASC_PRIVATE_KEY: "p", MCP_BEARER_TOKEN: "owner-secret" };
const ctx = {} as ExecutionContext;

let now = 1_800_000_000;
const signer = new OAuthSigner("owner-secret", () => now);
const worker = createWorker(async () => new Response("mcp-ok"), () => signer);

const call = (path: string, init?: RequestInit) => worker.fetch(new Request(BASE + path, init), env, ctx);

function b64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

async function registerClient() {
  const res = await call("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function authorize(clientId: string, challenge: string, password: string) {
  const form = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_token: password,
  });
  return call("/authorize", { method: "POST", body: form });
}

test("discovery: 401 points to protected resource metadata, which points to the auth server", async () => {
  const res = await call("/mcp", { method: "POST" });
  assert.equal(res.status, 401);
  const www = res.headers.get("WWW-Authenticate") ?? "";
  assert.match(www, new RegExp(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`));

  for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const prm = (await (await call(p)).json()) as { resource: string; authorization_servers: string[] };
    assert.equal(prm.resource, `${BASE}/mcp`);
    assert.deepEqual(prm.authorization_servers, [BASE]);
  }
  const as = (await (await call("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
  assert.equal(as.issuer, BASE);
  assert.equal(as.registration_endpoint, `${BASE}/register`);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
});

test("full flow: register -> authorize (owner token) -> token -> /mcp -> refresh", async () => {
  const clientId = await registerClient();
  const { verifier, challenge } = await pkce();

  const getRes = await call(
    `/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "xyz", code_challenge: challenge, code_challenge_method: "S256" })}`,
  );
  assert.equal(getRes.status, 200);
  const html = await getRes.text();
  assert.match(html, /<form method="post"/);
  assert.ok(!html.includes("owner-secret"));

  const wrong = await authorize(clientId, challenge, "nope");
  assert.equal(wrong.status, 401);

  const ok = await authorize(clientId, challenge, "owner-secret");
  assert.equal(ok.status, 302);
  const loc = new URL(ok.headers.get("Location")!);
  assert.equal(loc.origin + loc.pathname, REDIRECT);
  assert.equal(loc.searchParams.get("state"), "xyz");
  const code = loc.searchParams.get("code")!;

  const badPkce = await call("/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: "x".repeat(43) }),
  });
  assert.equal(badPkce.status, 400);

  const tok = await call("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }),
  });
  assert.equal(tok.status, 200);
  const tokens = (await tok.json()) as { access_token: string; refresh_token: string; token_type: string };
  assert.equal(tokens.token_type, "Bearer");

  const mcp = await call("/mcp", { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(mcp.status, 200);
  assert.equal(await mcp.text(), "mcp-ok");

  // refresh tokens and codes are not accepted as access tokens
  assert.equal((await call("/mcp", { method: "POST", headers: { Authorization: `Bearer ${tokens.refresh_token}` } })).status, 401);
  assert.equal((await call("/mcp", { method: "POST", headers: { Authorization: `Bearer ${code}` } })).status, 401);

  const refreshed = await call("/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }),
  });
  assert.equal(refreshed.status, 200);

  // access token expires
  now += 2 * 60 * 60;
  assert.equal((await call("/mcp", { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 401);
});

test("static bearer token still works for CLI clients", async () => {
  const res = await call("/mcp", { method: "POST", headers: { Authorization: "Bearer owner-secret" } });
  assert.equal(res.status, 200);
  const slash = await call("/mcp/", { method: "POST", headers: { Authorization: "Bearer owner-secret" } });
  assert.equal(slash.status, 200);
});

test("authorize rejects unregistered redirect URIs and missing PKCE", async () => {
  const clientId = await registerClient();
  const { challenge } = await pkce();
  const evil = await call(
    `/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://evil.example/cb", code_challenge: challenge, code_challenge_method: "S256" })}`,
  );
  assert.equal(evil.status, 400);
  const noPkce = await call(`/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT })}`);
  assert.equal(noPkce.status, 400);
  const forged = await call(
    `/authorize?${new URLSearchParams({ response_type: "code", client_id: "forged.client", redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" })}`,
  );
  assert.equal(forged.status, 400);
});

test("register validates redirect URIs", async () => {
  assert.ok(isAllowedRedirectUri(REDIRECT));
  assert.ok(isAllowedRedirectUri("http://localhost:6274/oauth/callback"));
  assert.ok(!isAllowedRedirectUri("http://claude.ai/cb"));
  assert.ok(!isAllowedRedirectUri("javascript:alert(1)"));
  const res = await call("/register", { method: "POST", body: JSON.stringify({ redirect_uris: ["http://evil.example"] }) });
  assert.equal(res.status, 400);
});

test("tokens signed with a different MCP_BEARER_TOKEN are rejected", async () => {
  const other = new OAuthSigner("rotated");
  const forged = await other.sign({ k: "access", exp: now + 100 });
  assert.equal((await call("/mcp", { method: "POST", headers: { Authorization: `Bearer ${forged}` } })).status, 401);
});
