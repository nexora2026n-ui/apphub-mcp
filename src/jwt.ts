/**
 * ES256 JWT generation for the App Store Connect API using WebCrypto.
 * https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests
 */

export interface AscCredentials {
  issuerId: string;
  keyId: string;
  /** PKCS#8 PEM (contents of AuthKey_XXXX.p8). Literal "\n" sequences are accepted. */
  privateKey: string;
}

/** Apple rejects tokens that live longer than 20 minutes. */
export const MAX_TOKEN_LIFETIME_SECONDS = 20 * 60;
const DEFAULT_LIFETIME_SECONDS = 15 * 60;
const REFRESH_MARGIN_SECONDS = 60;

const encoder = new TextEncoder();

export function base64UrlEncode(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Normalises a PEM that may have been pasted with escaped newlines or surrounding quotes. */
export function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const normalised = pem
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\n/g, "\n");
  if (/BEGIN EC PRIVATE KEY/.test(normalised)) {
    throw new Error(
      "ASC_PRIVATE_KEY is in SEC1 format. Use the original .p8 file from App Store Connect (PKCS#8, 'BEGIN PRIVATE KEY').",
    );
  }
  const body = normalised
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (!body) throw new Error("ASC_PRIVATE_KEY is empty or not a PEM key.");
  let binary: string;
  try {
    binary = atob(body);
  } catch {
    throw new Error("ASC_PRIVATE_KEY is not valid base64 PEM.");
  }
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return der;
}

export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      pemToDer(pem),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("ASC_PRIVATE_KEY")) throw err;
    throw new Error("ASC_PRIVATE_KEY could not be imported as an ES256 (P-256) PKCS#8 key.");
  }
}

/** Signs a JWT. WebCrypto ECDSA output is already raw r||s (JWS format), no DER conversion needed. */
export async function signAscJwt(
  key: CryptoKey,
  creds: Pick<AscCredentials, "issuerId" | "keyId">,
  nowSeconds: number,
  lifetimeSeconds = DEFAULT_LIFETIME_SECONDS,
): Promise<string> {
  const lifetime = Math.min(lifetimeSeconds, MAX_TOKEN_LIFETIME_SECONDS);
  const header = { alg: "ES256", kid: creds.keyId, typ: "JWT" };
  const payload = {
    iss: creds.issuerId,
    iat: nowSeconds,
    exp: nowSeconds + lifetime,
    aud: "appstoreconnect-v1",
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Caches the imported key and a token, refreshing shortly before expiry. */
export class AscTokenProvider {
  private keyPromise?: Promise<CryptoKey>;
  private cached?: { token: string; exp: number };

  constructor(
    private readonly creds: AscCredentials,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly lifetimeSeconds = DEFAULT_LIFETIME_SECONDS,
  ) {}

  async getToken(): Promise<string> {
    const now = this.now();
    if (this.cached && this.cached.exp - REFRESH_MARGIN_SECONDS > now) return this.cached.token;
    this.keyPromise ??= importPrivateKey(this.creds.privateKey);
    let key: CryptoKey;
    try {
      key = await this.keyPromise;
    } catch (err) {
      this.keyPromise = undefined;
      throw err;
    }
    const token = await signAscJwt(key, this.creds, now, this.lifetimeSeconds);
    this.cached = { token, exp: now + Math.min(this.lifetimeSeconds, MAX_TOKEN_LIFETIME_SECONDS) };
    return token;
  }

  /** Drop the cached token (e.g. after a 401 from Apple). */
  invalidate(): void {
    this.cached = undefined;
  }
}
