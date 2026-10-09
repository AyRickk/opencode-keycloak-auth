/**
 * OpenCode v2 credential mapping and host-driven refresh.
 *
 * In v2 the host owns the refresh schedule: when it resolves a connection whose
 * access token expires within ~5 min, it calls the `refresh` of the method whose
 * id is stored in `credential.methodID`, then persists what we return. The host
 * does NOT de-duplicate concurrent resolves (two parallel model calls each
 * trigger a refresh with the same token), and Keycloak can rotate refresh tokens
 * (a token is then redeemable once). So the refresher is single-flight per
 * refresh token, and keeps the result for a short grace period to answer a late
 * caller that still holds the token we just redeemed.
 */
import type { Credential } from "@opencode/plugin";
import type { KeycloakConfig } from "../config.js";
import { describe, KeycloakOAuthError } from "../errors.js";
import { refreshTokens, type TokenSet } from "../keycloak.js";
import { log } from "../log.js";

export type OAuthCredential = Credential.OAuth;

/** How long a redeemed refresh token keeps answering from cache. */
const ROTATION_GRACE_MS = 60_000;

/** Map a Keycloak token set to the v2 `Credential.OAuth` shape (`expires` in ms). */
export function toCredential(tokens: TokenSet, methodID: string): OAuthCredential {
  return {
    type: "oauth",
    methodID: methodID as OAuthCredential["methodID"],
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expiresAt,
  };
}

export interface RefresherDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface Refresher {
  refresh(credential: OAuthCredential): Promise<OAuthCredential>;
}

export function createRefresher(config: KeycloakConfig, deps: RefresherDeps = {}): Refresher {
  const now = deps.now ?? Date.now;
  const inFlight = new Map<string, Promise<OAuthCredential>>();
  const redeemed = new Map<string, { result: OAuthCredential; until: number }>();

  const redeem = async (credential: OAuthCredential): Promise<OAuthCredential> => {
    try {
      const tokens = await refreshTokens(config, credential.refresh, {
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        now,
      });
      const next: OAuthCredential = {
        ...toCredential(tokens, credential.methodID),
        ...(credential.metadata ? { metadata: credential.metadata } : {}),
      };
      log.info(
        `refreshed access token for ${config.providerId} (valid ${Math.round((next.expires - now()) / 1000)}s)`,
      );
      return next;
    } catch (cause) {
      log.error(`token refresh failed for ${config.providerId}: ${describe(cause)}`);
      throw refreshError(cause);
    }
  };

  return {
    refresh(credential) {
      const key = credential.refresh;
      const cached = redeemed.get(key);
      if (cached && now() < cached.until) return Promise.resolve(cached.result);
      redeemed.delete(key);

      const pending = inFlight.get(key);
      if (pending) return pending;

      const attempt = redeem(credential)
        .then((result) => {
          redeemed.set(key, { result, until: now() + ROTATION_GRACE_MS });
          return result;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, attempt);
      return attempt;
    },
  };
}

function refreshError(cause: unknown): Error {
  const reconnect = "Reconnect with /connect in the TUI or `opencode auth login keycloak`.";
  if (cause instanceof KeycloakOAuthError && cause.error === "invalid_grant") {
    return new Error(
      `Keycloak session expired (invalid_grant): the refresh token is no longer valid, ` +
        `typically because the SSO session hit its idle/max lifespan. ${reconnect} ` +
        `To avoid this recurring, keep the "offline_access" scope (enabled by default).`,
      { cause },
    );
  }
  return new Error(`Token refresh failed (${describe(cause)}). ${reconnect}`, { cause });
}
