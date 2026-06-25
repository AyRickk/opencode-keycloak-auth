/**
 * opencode-oauth-keycloak
 *
 * An OpenCode auth plugin that authenticates against Keycloak via OAuth2/OIDC
 * (Authorization Code + PKCE S256, with a Device Authorization Grant fallback)
 * and feeds short-lived, auto-refreshed access tokens to an OpenAI-compatible
 * provider.
 *
 * The Keycloak access token IS the JWT the downstream provider validates (e.g.
 * JWKS + claim policies), so nothing changes on the provider side.
 */
import type { AuthHook, Plugin, PluginOptions } from "@opencode-ai/plugin";
import {
  resolveConfig,
  resolveProviderId,
  type KeycloakConfig,
  type KeycloakPluginOptions,
} from "./config.js";
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

/**
 * Build a single placeholder method used when the config is incomplete. It keeps
 * the provider visible in `opencode auth login` and reports the real, actionable
 * reason when the user selects it — instead of the whole plugin failing to load
 * (which OpenCode swallows, leaving the provider mysteriously absent).
 */
function buildErrorMethods(reason: string): AuthHook["methods"] {
  return [
    {
      type: "oauth" as const,
      label: "Keycloak · ⚠ not configured — see error",
      authorize: async (): Promise<never> => {
        throw new Error(
          `Keycloak auth plugin is not configured. ${reason} ` +
            `Set the "issuer" and "clientId" plugin options in opencode.json (or the ` +
            `OPENCODE_KC_ISSUER / OPENCODE_KC_CLIENT_ID environment variables).`,
        );
      },
    },
  ];
}

export const KeycloakAuthPlugin: Plugin = async (input, options?: PluginOptions) => {
  const opts = (options ?? {}) as KeycloakPluginOptions;
  const preferDevice = !hasLocalBrowser();

  let config: KeycloakConfig;
  try {
    config = resolveConfig(opts);
  } catch (cause) {
    // Never throw at load time: that makes OpenCode drop the plugin silently and
    // the provider never shows up in `opencode auth login`. Register the provider
    // anyway and surface the real error only when a login method is picked.
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      auth: { provider: resolveProviderId(opts), methods: buildErrorMethods(reason) },
    };
  }

  const auth: AuthHook = {
    provider: config.providerId,
    loader: createLoader(config, { client: input.client }),
    methods: buildMethods(config, preferDevice),
  };

  return { auth };
};

export default KeycloakAuthPlugin;
