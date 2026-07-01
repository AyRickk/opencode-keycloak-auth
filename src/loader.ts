/**
 * The `loader` is called by OpenCode before each request to the provider. It:
 *   1. reads the stored OAuth credentials,
 *   2. refreshes the access token if it expires within the configured leeway,
 *   3. persists the refreshed tokens via the OpenCode client (auth.json, 0600),
 *   4. returns `{ apiKey }`, which OpenCode injects as `Authorization: Bearer`
 *      towards the provider.
 *
 * On refresh failure it throws {@link RefreshFailedError}, prompting the user to
 * log in again — we never silently send an expired token.
 *
 * Concurrent requests near expiry share a SINGLE refresh (single-flight). This
 * matters because Keycloak rotates refresh tokens: a refresh token can be
 * redeemed only once. Without deduplication, two in-flight requests would each
 * POST the same refresh token — the first rotates it, the second gets
 * `invalid_grant` and forces a spurious re-login. That is the intermittent
 * "unexpected server error on token expiry" failure this guards against.
 */
import type { AuthHook, PluginInput } from "@opencode-ai/plugin";
import { refreshTokens, type TokenSet } from "./keycloak.js";
import { RefreshFailedError } from "./errors.js";
import type { KeycloakConfig } from "./config.js";

type Loader = NonNullable<AuthHook["loader"]>;

export interface LoaderDeps {
  client: PluginInput["client"];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function createLoader(config: KeycloakConfig, deps: LoaderDeps): Loader {
  const now = deps.now ?? Date.now;

  // Shared across all concurrent invocations of this loader instance. Holds the
  // in-flight refresh so overlapping requests await one result instead of
  // racing to redeem the same (rotating) refresh token.
  let inFlight: Promise<TokenSet> | null = null;

  const refreshOnce = (refreshToken: string): Promise<TokenSet> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const next = await refreshTokens(config, refreshToken, {
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          now,
        });

        // Persist the rotated tokens so subsequent runs start fresh. Storage and
        // file permissions are owned by OpenCode (auth.json, mode 0600).
        try {
          await deps.client.auth.set({
            path: { id: config.providerId },
            body: {
              type: "oauth",
              access: next.access,
              refresh: next.refresh,
              expires: next.expiresAt,
            },
          });
        } catch {
          // Persisting failed (e.g. server transient) — the access token is still
          // valid for this run, so proceed rather than blocking the request.
        }

        return next;
      } finally {
        // Whether it resolved or rejected, the next expiry starts a fresh attempt.
        inFlight = null;
      }
    })();
    return inFlight;
  };

  return async (auth) => {
    const current = await auth();
    // Not authenticated through this OAuth provider — let OpenCode handle it.
    if (!current || current.type !== "oauth") return {};

    const leewayMs = config.refreshLeewaySeconds * 1000;
    const needsRefresh = current.expires - now() < leewayMs;

    if (!needsRefresh) {
      return { apiKey: current.access };
    }

    let next;
    try {
      next = await refreshOnce(current.refresh);
    } catch (cause) {
      throw new RefreshFailedError(cause);
    }

    return { apiKey: next.access };
  };
}
