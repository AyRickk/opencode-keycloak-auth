/**
 * Error types with user-facing, actionable messages.
 *
 * The goal (per the brief): a failed refresh should gracefully restart the
 * login flow, and network / Keycloak-unavailable situations must produce clear
 * messages rather than opaque stack traces.
 */

/**
 * The plugin configuration is incomplete or invalid (e.g. missing issuer or
 * clientId). Carries the list of missing/invalid fields so callers can log a
 * precise, actionable message instead of a generic failure.
 */
export class ConfigError extends Error {
  /** Names of the required settings that are missing or invalid. */
  readonly missing: readonly string[];

  constructor(message: string, missing: readonly string[] = []) {
    super(message);
    this.name = "ConfigError";
    this.missing = missing;
  }
}

/** Keycloak returned a structured OAuth error (RFC 6749 §5.2). */
export class KeycloakOAuthError extends Error {
  readonly error: string;
  readonly description: string | undefined;
  readonly status: number;

  constructor(status: number, error: string, description?: string) {
    super(description ? `${error}: ${description}` : error);
    this.name = "KeycloakOAuthError";
    this.status = status;
    this.error = error;
    this.description = description;
  }
}

/** The Keycloak server could not be reached (DNS, TLS, connection refused…). */
export class KeycloakNetworkError extends Error {
  constructor(endpoint: string, cause: unknown) {
    super(
      `Could not reach Keycloak at ${endpoint}. ` +
        `Check the issuer URL, network connectivity and TLS trust. Cause: ${describe(cause)}`,
    );
    this.name = "KeycloakNetworkError";
    this.cause = cause;
  }
}

/** A refresh attempt failed; the caller should fall back to an interactive login. */
export class RefreshFailedError extends Error {
  constructor(cause: unknown) {
    super(RefreshFailedError.message(cause));
    this.name = "RefreshFailedError";
    this.cause = cause;
  }

  /**
   * `invalid_grant` on a refresh means the refresh token is no longer accepted —
   * almost always because the Keycloak SSO session expired (idle/max lifespan)
   * while OpenCode was idle overnight. That is a re-login, not a bug, so we say
   * so plainly and point at the durable fix (offline tokens).
   */
  private static message(cause: unknown): string {
    if (cause instanceof KeycloakOAuthError && cause.error === "invalid_grant") {
      return (
        `Keycloak session expired (invalid_grant): the refresh token is no longer valid, ` +
        `typically because the SSO session hit its idle/max lifespan. ` +
        `Log in again with: opencode auth login. ` +
        `To avoid this recurring, request an offline token (scope "offline_access", enabled by default).`
      );
    }
    return `Token refresh failed (${describe(cause)}). Please log in again with: opencode auth login.`;
  }
}

export function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

/**
 * The message shown when a login method is selected while the configuration is
 * incomplete. Shared by the v1 and v2 entry points.
 */
export function notConfiguredMessage(reason: string): string {
  return (
    `Keycloak auth plugin is not configured. ${reason} ` +
    `Set the "issuer" and "clientId" plugin options in opencode.json (or the ` +
    `OPENCODE_KC_ISSUER / OPENCODE_KC_CLIENT_ID environment variables).`
  );
}

/** The `warn` line logged when the plugin loads in ERROR mode. */
export function incompleteConfigWarning(providerId: string, cause: unknown): string {
  const reason = cause instanceof Error ? cause.message : String(cause);
  const missing = cause instanceof ConfigError ? cause.missing : [];
  return (
    `configuration incomplete — provider ${JSON.stringify(providerId)} registered in ERROR mode` +
    (missing.length ? ` (missing: ${missing.join(", ")})` : "") +
    `; auth will fail until fixed. ${reason}`
  );
}
