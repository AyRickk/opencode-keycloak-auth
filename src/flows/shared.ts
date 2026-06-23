import type { AuthOAuthResult } from "@opencode-ai/plugin";
import { endpoints, redirectUri, type KeycloakConfig } from "../config.js";
import type { Pkce } from "../pkce.js";
import type { TokenSet } from "../keycloak.js";

/** A successful OAuth callback result carrying tokens for OpenCode to persist. */
export type OAuthSuccess = Extract<
  Awaited<ReturnType<Extract<AuthOAuthResult, { method: "auto" }>["callback"]>>,
  { type: "success" }
>;

/** Convert our normalized token set into the success shape OpenCode expects. */
export function toSuccess(tokens: TokenSet): OAuthSuccess {
  return {
    type: "success",
    access: tokens.access,
    refresh: tokens.refresh,
    // OpenCode stores `expires` as an absolute ms timestamp.
    expires: tokens.expiresAt,
  };
}

/** Build the Keycloak authorization-code URL with PKCE S256. */
export function buildAuthorizeUrl(config: KeycloakConfig, pkce: Pkce, state: string): string {
  const url = new URL(endpoints(config).authorization);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri(config));
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", pkce.method);
  return url.toString();
}
