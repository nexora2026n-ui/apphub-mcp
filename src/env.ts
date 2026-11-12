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

/** Alternative names accepted for the Apple credentials (e.g. APPLE_ISSUER_ID set in the dashboard). */
export const ENV_ALIASES = {
  ASC_ISSUER_ID: ["APPLE_ISSUER_ID"],
  ASC_KEY_ID: ["APPLE_KEY_ID"],
  ASC_PRIVATE_KEY: ["APPLE_PRIVATE_KEY"],
  ASC_ALLOWED_APP_IDS: ["APPLE_ALLOWED_APP_IDS"],
} as const;

/** Returns an Env where ASC_* falls back to the APPLE_* alias when empty. Does not mutate the input. */
export function normalizeEnv<T extends object>(raw: T): T & Env {
  const env = { ...(raw as Record<string, unknown>) };
  for (const [name, aliases] of Object.entries(ENV_ALIASES)) {
    const current = env[name];
    if (typeof current === "string" && current.trim() !== "") continue;
    for (const alias of aliases) {
      const v = env[alias];
      if (typeof v === "string" && v.trim() !== "") {
        env[name] = v;
        break;
      }
    }
  }
  return env as T & Env;
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
