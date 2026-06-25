/**
 * Configuration resolution for the Keycloak auth plugin.
 *
 * Every value is configurable via environment variables (prefix `OPENCODE_KC_`)
 * and/or plugin options declared in `opencode.json`
 * (`"plugin": [["opencode-oauth-keycloak", { ... }]]`). Plugin options take
 * precedence over environment variables; both fall back to sane defaults.
 *
 * No secrets are read or stored here: the Keycloak client is a PUBLIC client
 * and PKCE is mandatory, so there is deliberately no `clientSecret` option.
 */

export interface KeycloakPluginOptions {
  /** Provider id this plugin attaches its auth hook to. Default: `keycloak`. */
  providerId?: string;
  /** Keycloak realm issuer URL, e.g. `https://kc.example.com/realms/my-realm`. */
  issuer?: string;
  /** Public OAuth client id registered in Keycloak. */
  clientId?: string;
  /** Scopes requested. Accepts an array or a space/comma separated string. */
  scopes?: string[] | string;
  /** Host the localhost callback server binds to. Default: `127.0.0.1`. */
  callbackHost?: string;
  /** Port the localhost callback server binds to. Default: `49170`. */
  callbackPort?: number;
  /** Path of the redirect URI. Default: `/callback`. */
  redirectPath?: string;
  /** Informational provider base URL (used by the loader as a sanity hint). */
  baseUrl?: string;
  /**
   * Refresh access tokens this many seconds before they expire.
   * Default: 30 (matches the spec in the brief).
   */
  refreshLeewaySeconds?: number;
  /** Seconds to wait for the browser callback before giving up. Default: 300. */
  browserTimeoutSeconds?: number;
}

export interface KeycloakConfig {
  providerId: string;
  issuer: string;
  clientId: string;
  scopes: string[];
  callbackHost: string;
  callbackPort: number;
  redirectPath: string;
  baseUrl: string | undefined;
  refreshLeewaySeconds: number;
  browserTimeoutSeconds: number;
}

export interface KeycloakEndpoints {
  authorization: string;
  token: string;
  device: string;
}

const ENV_PREFIX = "OPENCODE_KC_";

const DEFAULTS = {
  providerId: "keycloak",
  scopes: ["openid"],
  callbackHost: "127.0.0.1",
  callbackPort: 49170,
  redirectPath: "/callback",
  refreshLeewaySeconds: 30,
  browserTimeoutSeconds: 300,
} as const;

type Env = Record<string, string | undefined>;

function env(name: string, source: Env): string | undefined {
  const value = source[ENV_PREFIX + name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function toScopes(value: readonly string[] | string): string[] {
  const list = typeof value === "string" ? value.split(/[\s,]+/) : value;
  const seen = new Set<string>();
  for (const raw of list) {
    const scope = raw.trim();
    if (scope) seen.add(scope);
  }
  // `openid` is required for OIDC; ensure it is always present.
  seen.add("openid");
  return [...seen];
}

function toPort(value: string | number, label: string): number {
  const port = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${label} must be an integer between 0 and 65535, got "${value}".`);
  }
  return port;
}

function normalizeIssuer(issuer: string): string {
  // Tolerate a trailing slash so endpoint URLs never end up with `//`.
  return issuer.replace(/\/+$/, "");
}

/**
 * Resolve the effective configuration from plugin options (highest priority),
 * then environment variables, then defaults. Throws a clear error if a required
 * value (issuer, clientId) is missing.
 */
export function resolveConfig(
  options: KeycloakPluginOptions = {},
  source: Env = process.env,
): KeycloakConfig {
  const issuerRaw = options.issuer ?? env("ISSUER", source);
  const clientId = options.clientId ?? env("CLIENT_ID", source);

  if (!issuerRaw) {
    throw new Error(
      `Missing Keycloak issuer. Set ${ENV_PREFIX}ISSUER (e.g. https://kc.example.com/realms/my-realm) ` +
        `or the "issuer" plugin option in opencode.json.`,
    );
  }
  if (!clientId) {
    throw new Error(
      `Missing Keycloak client id. Set ${ENV_PREFIX}CLIENT_ID or the "clientId" plugin option in opencode.json.`,
    );
  }

  const scopesRaw = options.scopes ?? env("SCOPES", source) ?? DEFAULTS.scopes;
  const callbackPortRaw = options.callbackPort ?? env("CALLBACK_PORT", source) ?? DEFAULTS.callbackPort;
  const refreshLeewayRaw =
    options.refreshLeewaySeconds ?? env("REFRESH_LEEWAY", source) ?? DEFAULTS.refreshLeewaySeconds;
  const browserTimeoutRaw =
    options.browserTimeoutSeconds ?? env("BROWSER_TIMEOUT", source) ?? DEFAULTS.browserTimeoutSeconds;

  return {
    providerId: options.providerId ?? env("PROVIDER_ID", source) ?? DEFAULTS.providerId,
    issuer: normalizeIssuer(issuerRaw),
    clientId,
    scopes: toScopes(scopesRaw),
    callbackHost: options.callbackHost ?? env("CALLBACK_HOST", source) ?? DEFAULTS.callbackHost,
    callbackPort: toPort(callbackPortRaw, `${ENV_PREFIX}CALLBACK_PORT`),
    redirectPath: ensureLeadingSlash(
      options.redirectPath ?? env("REDIRECT_PATH", source) ?? DEFAULTS.redirectPath,
    ),
    baseUrl: options.baseUrl ?? env("BASE_URL", source),
    refreshLeewaySeconds: toNonNegativeInt(refreshLeewayRaw, `${ENV_PREFIX}REFRESH_LEEWAY`),
    browserTimeoutSeconds: toNonNegativeInt(browserTimeoutRaw, `${ENV_PREFIX}BROWSER_TIMEOUT`),
  };
}

/**
 * Resolve only the provider id. Unlike {@link resolveConfig} this never throws,
 * so the plugin can still register its provider (and surface a clear error at
 * login time) even when the full config is incomplete — otherwise a missing
 * `issuer`/`clientId` would make the whole plugin fail to load and the provider
 * would silently never appear in `opencode auth login`.
 */
export function resolveProviderId(options: KeycloakPluginOptions = {}, source: Env = process.env): string {
  return options.providerId ?? env("PROVIDER_ID", source) ?? DEFAULTS.providerId;
}

function ensureLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function toNonNegativeInt(value: string | number, label: string): number {
  const n = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label} must be a non-negative integer, got "${value}".`);
  }
  return n;
}

/** Derive the standard Keycloak OIDC endpoints from the realm issuer. */
export function endpoints(config: KeycloakConfig): KeycloakEndpoints {
  const base = `${config.issuer}/protocol/openid-connect`;
  return {
    authorization: `${base}/auth`,
    token: `${base}/token`,
    device: `${base}/auth/device`,
  };
}

/** Full redirect URI used for the Authorization Code flow. */
export function redirectUri(config: KeycloakConfig): string {
  return `http://${config.callbackHost}:${config.callbackPort}${config.redirectPath}`;
}
