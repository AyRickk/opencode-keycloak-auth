/**
 * Thin Keycloak OIDC client built on the global `fetch`.
 *
 * Covers exactly what the plugin needs: authorization-code exchange (with PKCE),
 * refresh-token grant, and the device authorization grant. No runtime deps.
 */
import { KeycloakNetworkError, KeycloakOAuthError } from "./errors.js";
import { endpoints, type KeycloakConfig } from "./config.js";

/** Normalized token set with an absolute expiry timestamp (ms since epoch). */
export interface TokenSet {
  access: string;
  refresh: string;
  /** Absolute expiry in milliseconds since the Unix epoch. */
  expiresAt: number;
}

/** Raw token endpoint response (subset we care about). */
interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/** Device authorization response (RFC 8628 §3.2). */
export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | undefined;
  /** Absolute expiry in ms since epoch. */
  expiresAt: number;
  /** Polling interval in milliseconds. */
  intervalMs: number;
}

const FORM_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
} as const;

/**
 * POST a form to a Keycloak endpoint and return parsed JSON.
 *
 * Throws {@link KeycloakNetworkError} when the host is unreachable and
 * {@link KeycloakOAuthError} when Keycloak returns a structured OAuth error.
 * The optional `tolerate` set lets callers (device polling) handle expected
 * error codes themselves instead of throwing.
 */
async function postForm(
  endpoint: string,
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: FORM_HEADERS,
      body: new URLSearchParams(params).toString(),
    });
  } catch (cause) {
    throw new KeycloakNetworkError(endpoint, cause);
  }

  const body = await safeJson(response);

  if (!response.ok) {
    const error = typeof body.error === "string" ? body.error : `http_${response.status}`;
    const description = typeof body.error_description === "string" ? body.error_description : undefined;
    throw new KeycloakOAuthError(response.status, error, description);
  }
  return body;
}

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Keycloak should return JSON; if it didn't, surface the raw payload.
    return { error: `non_json_response`, error_description: text.slice(0, 500) };
  }
}

function toTokenSet(raw: RawTokenResponse, now: number): TokenSet {
  if (typeof raw.access_token !== "string" || !raw.access_token) {
    throw new KeycloakOAuthError(200, "invalid_token_response", "missing access_token");
  }
  if (typeof raw.refresh_token !== "string" || !raw.refresh_token) {
    throw new KeycloakOAuthError(200, "invalid_token_response", "missing refresh_token");
  }
  const expiresIn = typeof raw.expires_in === "number" ? raw.expires_in : 60;
  return {
    access: raw.access_token,
    refresh: raw.refresh_token,
    expiresAt: now + expiresIn * 1000,
  };
}

/** Exchange an authorization code (with PKCE verifier) for tokens. */
export async function exchangeCode(
  config: KeycloakConfig,
  args: { code: string; verifier: string; redirectUri: string },
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<TokenSet> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const raw = await postForm(
    endpoints(config).token,
    {
      grant_type: "authorization_code",
      client_id: config.clientId,
      code: args.code,
      redirect_uri: args.redirectUri,
      code_verifier: args.verifier,
    },
    fetchImpl,
  );
  return toTokenSet(raw, now());
}

/** Exchange a refresh token for a fresh token set. */
export async function refreshTokens(
  config: KeycloakConfig,
  refreshToken: string,
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<TokenSet> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const raw = await postForm(
    endpoints(config).token,
    {
      grant_type: "refresh_token",
      client_id: config.clientId,
      refresh_token: refreshToken,
    },
    fetchImpl,
  );
  return toTokenSet(raw, now());
}

/** Start a device authorization grant (RFC 8628). */
export async function startDeviceAuthorization(
  config: KeycloakConfig,
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<DeviceAuthorization> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const raw = await postForm(
    endpoints(config).device,
    {
      client_id: config.clientId,
      scope: config.scopes.join(" "),
    },
    fetchImpl,
  );

  const deviceCode = raw["device_code"];
  const userCode = raw["user_code"];
  const verificationUri = raw["verification_uri"];
  if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string") {
    throw new KeycloakOAuthError(
      200,
      "invalid_device_response",
      "missing device_code/user_code/verification_uri",
    );
  }

  const expiresIn = typeof raw["expires_in"] === "number" ? (raw["expires_in"] as number) : 600;
  const intervalSec = typeof raw["interval"] === "number" ? (raw["interval"] as number) : 5;
  const complete = raw["verification_uri_complete"];

  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: typeof complete === "string" ? complete : undefined,
    expiresAt: now() + expiresIn * 1000,
    intervalMs: intervalSec * 1000,
  };
}

/** Result of a single device-token poll. */
export type DevicePollResult =
  | { status: "complete"; tokens: TokenSet }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "denied" }
  | { status: "expired" };

/**
 * Perform ONE poll of the token endpoint for a device code. The caller owns the
 * loop and the waiting (so it stays testable without real timers).
 */
export async function pollDeviceToken(
  config: KeycloakConfig,
  deviceCode: string,
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<DevicePollResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  try {
    const raw = await postForm(
      endpoints(config).token,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: config.clientId,
        device_code: deviceCode,
      },
      fetchImpl,
    );
    return { status: "complete", tokens: toTokenSet(raw, now()) };
  } catch (err) {
    if (err instanceof KeycloakOAuthError) {
      switch (err.error) {
        case "authorization_pending":
          return { status: "pending" };
        case "slow_down":
          return { status: "slow_down" };
        case "access_denied":
          return { status: "denied" };
        case "expired_token":
          return { status: "expired" };
        default:
          throw err;
      }
    }
    throw err;
  }
}
