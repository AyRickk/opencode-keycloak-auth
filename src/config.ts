/**
 * Configuration resolution for the Keycloak auth plugin.
 *
 * Every value is configurable via environment variables (prefix `OPENCODE_KC_`)
 * and/or plugin options declared in `opencode.json` (the `options` of a
 * `"plugins"` entry on OpenCode v2, `"plugin": [[path, { ... }]]` on v1). Plugin
 * options take precedence over environment variables; both fall back to sane
 * defaults.
 *
 * No secrets are read or stored here: the Keycloak client is a PUBLIC client
 * and PKCE is mandatory, so there is deliberately no `clientSecret` option.
 */
import { ConfigError } from "./errors.js";
import { log } from "./log.js";

export interface KeycloakPluginOptions {
  /** Provider id this plugin attaches its auth hook to. Default: `keycloak`. */
  providerId?: string;
  /** Keycloak realm issuer URL, e.g. `https://kc.example.com/realms/my-realm`. */
  issuer?: string;
  /** Public OAuth client id registered in Keycloak. */
  clientId?: string;
  /** Scopes requested. Accepts an array or a space/comma separated string. */
  scopes?: string[] | string;
  /**
   * Request an OFFLINE refresh token (adds the `offline_access` scope). Offline
   * tokens survive SSO Session Idle/Max expiry, so a single login keeps working
   * across days instead of dying overnight. Default: `true`. Set to `false` for
   * realms that do not grant the `offline_access` client scope.
   */
  offlineAccess?: boolean;
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
  offlineAccess: true,
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

function toScopes(value: readonly string[] | string, offlineAccess: boolean): string[] {
  const list = typeof value === "string" ? value.split(/[\s,]+/) : value;
  const seen = new Set<string>();
  for (const raw of list) {
    const scope = raw.trim();
    if (scope) seen.add(scope);
  }
  // `openid` is required for OIDC; ensure it is always present.
  seen.add("openid");
  // `offline_access` yields a long-lived offline refresh token that does not die
  // with the SSO session — the difference between "log in once" and "log in
  // every morning". Requested by default; harmless if the realm ignores it.
  if (offlineAccess) seen.add("offline_access");
  return [...seen];
}

function toBool(value: string | boolean, label: string): boolean {
  if (typeof value === "boolean") return value;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`${label} must be a boolean (true/false), got "${value}".`);
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

  // Collect every missing required setting so the error names all of them at
  // once (instead of surfacing them one restart at a time).
  if (!issuerRaw || !clientId) {
    const missing: string[] = [];
    if (!issuerRaw) missing.push("issuer");
    if (!clientId) missing.push("clientId");
    const hints: Record<string, string> = {
      issuer: `${ENV_PREFIX}ISSUER (e.g. https://kc.example.com/realms/my-realm) or the "issuer" plugin option`,
      clientId: `${ENV_PREFIX}CLIENT_ID or the "clientId" plugin option`,
    };
    throw new ConfigError(
      `Missing required Keycloak setting(s): ${missing.join(", ")}. ` +
        `Set ${missing.map((m) => hints[m]).join("; and ")} in opencode.json.`,
      missing,
    );
  }

  const issuer = normalizeIssuer(issuerRaw);
  // Soft validation: a Keycloak issuer is always `.../realms/<realm>`. Warn (do
  // not fail) so an obviously wrong issuer is caught before it 404s at login.
  if (!/\/realms\/[^/]+$/.test(issuer)) {
    log.warn(
      `issuer ${JSON.stringify(issuer)} does not look like a Keycloak realm URL ` +
        `(expected it to end with /realms/<realm>); the token/authorize endpoints will likely 404.`,
    );
  }

  const scopesRaw = options.scopes ?? env("SCOPES", source) ?? DEFAULTS.scopes;
  const offlineAccessRaw = options.offlineAccess ?? env("OFFLINE_ACCESS", source) ?? DEFAULTS.offlineAccess;
  const callbackPortRaw = options.callbackPort ?? env("CALLBACK_PORT", source) ?? DEFAULTS.callbackPort;
  const refreshLeewayRaw =
    options.refreshLeewaySeconds ?? env("REFRESH_LEEWAY", source) ?? DEFAULTS.refreshLeewaySeconds;
  const browserTimeoutRaw =
    options.browserTimeoutSeconds ?? env("BROWSER_TIMEOUT", source) ?? DEFAULTS.browserTimeoutSeconds;

  const resolved: KeycloakConfig = {
    providerId: options.providerId ?? env("PROVIDER_ID", source) ?? DEFAULTS.providerId,
    issuer,
    clientId,
    scopes: toScopes(scopesRaw, toBool(offlineAccessRaw, `${ENV_PREFIX}OFFLINE_ACCESS`)),
    callbackHost: options.callbackHost ?? env("CALLBACK_HOST", source) ?? DEFAULTS.callbackHost,
    callbackPort: toPort(callbackPortRaw, `${ENV_PREFIX}CALLBACK_PORT`),
    redirectPath: ensureLeadingSlash(
      options.redirectPath ?? env("REDIRECT_PATH", source) ?? DEFAULTS.redirectPath,
    ),
    baseUrl: options.baseUrl ?? env("BASE_URL", source),
    refreshLeewaySeconds: toNonNegativeInt(refreshLeewayRaw, `${ENV_PREFIX}REFRESH_LEEWAY`),
    browserTimeoutSeconds: toNonNegativeInt(browserTimeoutRaw, `${ENV_PREFIX}BROWSER_TIMEOUT`),
  };

  log.debug(
    `resolved config: providerId=${resolved.providerId} issuer=${resolved.issuer} ` +
      `clientId=${resolved.clientId} scopes=[${resolved.scopes.join(" ")}] ` +
      `refreshLeeway=${resolved.refreshLeewaySeconds}s`,
  );
  return resolved;
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
