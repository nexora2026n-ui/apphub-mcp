import assert from "node:assert/strict";
import { test } from "node:test";
import { AscTokenProvider, base64UrlEncode, pemToDer, signAscJwt, importPrivateKey } from "../src/jwt";

async function makeKeyPair() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const b64 = btoa(String.fromCharCode(...pkcs8)).replace(/(.{64})/g, "$1\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

test("base64url has no padding or unsafe chars", () => {
  assert.equal(base64UrlEncode(new Uint8Array([251, 255, 254])), "-__-");
});

test("signs a verifiable ES256 JWT with Apple's required claims", async () => {
  const { pem, publicKey } = await makeKeyPair();
  const key = await importPrivateKey(pem);
  const jwt = await signAscJwt(key, { issuerId: "issuer-1", keyId: "KEY123" }, 1_700_000_000);
  const [h, p, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(b64urlDecode(h!))), { alg: "ES256", kid: "KEY123", typ: "JWT" });
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p!)));
  assert.equal(payload.iss, "issuer-1");
  assert.equal(payload.aud, "appstoreconnect-v1");
  assert.equal(payload.iat, 1_700_000_000);
  assert.ok(payload.exp - payload.iat <= 20 * 60);
  const sig = b64urlDecode(s!);
  assert.equal(sig.length, 64, "JWS ES256 signature must be raw 64-byte r||s");
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    sig,
    new TextEncoder().encode(`${h}.${p}`),
  );
  assert.ok(ok);
});

test("lifetime is capped at 20 minutes", async () => {
  const { pem } = await makeKeyPair();
  const key = await importPrivateKey(pem);
  const jwt = await signAscJwt(key, { issuerId: "i", keyId: "k" }, 0, 3600);
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(jwt.split(".")[1]!)));
  assert.equal(payload.exp, 1200);
});

test("accepts PEM with escaped newlines and quotes (as pasted into secrets)", async () => {
  const { pem } = await makeKeyPair();
  const escaped = `"${pem.trim().replace(/\n/g, "\\n")}"`;
  assert.deepEqual(pemToDer(escaped), pemToDer(pem));
  await importPrivateKey(escaped);
});

test("rejects invalid keys with a clear message", async () => {
  await assert.rejects(importPrivateKey("not a key!!"), /ASC_PRIVATE_KEY/);
  assert.throws(() => pemToDer("-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----"), /SEC1/);
});

test("token provider caches and refreshes before expiry", async () => {
  const { pem } = await makeKeyPair();
  let now = 1000;
  const provider = new AscTokenProvider({ issuerId: "i", keyId: "k", privateKey: pem }, () => now);
  const t1 = await provider.getToken();
  now += 60;
  assert.equal(await provider.getToken(), t1);
  now += 15 * 60; // past exp - margin
  assert.notEqual(await provider.getToken(), t1);
  const t3 = await provider.getToken();
  provider.invalidate();
  now += 1;
  assert.notEqual(await provider.getToken(), t3);
});
