/** Worker bindings. Secrets are set with `wrangler secret put` and never committed. */
export interface Env {
  /** App Store Connect API Issuer ID (secret). */
  ASC_ISSUER_ID: string;
  /** App Store Connect API Key ID (secret). */
  ASC_KEY_ID: string;
  /** Contents of the AuthKey_XXXX.p8 file, PEM / PKCS#8 (secret). */
  ASC_PRIVATE_KEY: string;
  /** Bearer token(s) MCP clients must send. Comma-separated to allow rotation (secret). */
  MCP_BEARER_TOKEN: string;
  /** Optional comma-separated allowlist of App Store Connect app IDs (var). */
  ASC_ALLOWED_APP_IDS?: string;
}

export const REQUIRED_SECRETS = [
  "ASC_ISSUER_ID",
  "ASC_KEY_ID",
  "ASC_PRIVATE_KEY",
  "MCP_BEARER_TOKEN",
] as const;

/** Returns the names of required secrets that are missing or empty. */
export function missingSecrets(env: Partial<Env>): string[] {
  return REQUIRED_SECRETS.filter((k) => !env[k] || String(env[k]).trim() === "");
}

export function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
