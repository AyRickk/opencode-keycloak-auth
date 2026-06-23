/**
 * Error types with user-facing, actionable messages.
 *
 * The goal (per the brief): a failed refresh should gracefully restart the
 * login flow, and network / Keycloak-unavailable situations must produce clear
 * messages rather than opaque stack traces.
 */

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
    super(`Token refresh failed (${describe(cause)}). ` + `Please log in again with: opencode auth login.`);
    this.name = "RefreshFailedError";
    this.cause = cause;
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
