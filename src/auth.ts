import { parseList } from "./env";

const encoder = new TextEncoder();

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/** Constant-time comparison (hashing first makes lengths equal). */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i]! ^ db[i]!;
  return diff === 0;
}

export function extractBearer(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

/** True if the request carries one of the configured bearer tokens. */
export async function isAuthorized(request: Request, configuredTokens: string): Promise<boolean> {
  const presented = extractBearer(request);
  const tokens = parseList(configuredTokens);
  if (!presented || tokens.length === 0) return false;
  let ok = false;
  // Check every token (no early exit) to avoid leaking which one matched.
  for (const token of tokens) {
    if (await timingSafeEqual(presented, token)) ok = true;
  }
  return ok;
}
