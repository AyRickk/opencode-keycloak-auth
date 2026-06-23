/**
 * The `loader` is called by OpenCode before each request to the provider. It:
 *   1. reads the stored OAuth credentials,
 *   2. refreshes the access token if it expires within the configured leeway,
 *   3. persists the refreshed tokens via the OpenCode client (auth.json, 0600),
 *   4. returns `{ apiKey }`, which OpenCode injects as `Authorization: Bearer`
 *      towards AgentGateway.
 *
 * On refresh failure it throws {@link RefreshFailedError}, prompting the user to
 * log in again — we never silently send an expired token.
 */
import type { AuthHook, PluginInput } from "@opencode-ai/plugin";
import { refreshTokens } from "./keycloak.js";
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
      next = await refreshTokens(config, current.refresh, {
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        now,
      });
    } catch (cause) {
      throw new RefreshFailedError(cause);
    }

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

    return { apiKey: next.access };
  };
}
