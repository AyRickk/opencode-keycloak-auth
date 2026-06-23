/**
 * opencode-oauth-keycloak
 *
 * An OpenCode auth plugin that authenticates against Keycloak via OAuth2/OIDC
 * (Authorization Code + PKCE S256, with a Device Authorization Grant fallback)
 * and feeds short-lived, auto-refreshed access tokens to an OpenAI-compatible
 * AgentGateway provider.
 *
 * The Keycloak access token IS the JWT AgentGateway validates (JWKS + CEL
 * policies), so nothing changes on the gateway side.
 */
import type { AuthHook, Plugin, PluginOptions } from "@opencode-ai/plugin";
import { resolveConfig, type KeycloakConfig, type KeycloakPluginOptions } from "./config.js";
import { hasLocalBrowser } from "./browser.js";
import { browserAutoMethod, browserCodeMethod } from "./flows/authcode.js";
import { deviceMethod } from "./flows/device.js";
import { createLoader } from "./loader.js";

export type { KeycloakPluginOptions, KeycloakConfig } from "./config.js";

function buildMethods(config: KeycloakConfig, preferDevice: boolean): AuthHook["methods"] {
  const browserAuto = {
    type: "oauth" as const,
    label: `Keycloak · Browser (PKCE, auto-capture)${preferDevice ? "" : " — recommended"}`,
    authorize: () => browserAutoMethod(config),
  };
  const browserPaste = {
    type: "oauth" as const,
    label: "Keycloak · Browser (paste the code)",
    authorize: async () => browserCodeMethod(config),
  };
  const device = {
    type: "oauth" as const,
    label: `Keycloak · Device code (headless / SSH)${preferDevice ? " — recommended" : ""}`,
    authorize: () => deviceMethod(config),
  };

  // In headless environments lead with the device flow; otherwise lead with the
  // zero-friction browser capture. All methods stay available either way.
  return preferDevice ? [device, browserPaste, browserAuto] : [browserAuto, browserPaste, device];
}

export const KeycloakAuthPlugin: Plugin = async (input, options?: PluginOptions) => {
  const config = resolveConfig((options ?? {}) as KeycloakPluginOptions);
  const preferDevice = !hasLocalBrowser();

  const auth: AuthHook = {
    provider: config.providerId,
    loader: createLoader(config, { client: input.client }),
    methods: buildMethods(config, preferDevice),
  };

  return { auth };
};

export default KeycloakAuthPlugin;
