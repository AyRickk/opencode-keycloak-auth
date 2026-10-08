/**
 * OpenCode v2 entry point (`setup(ctx)`), loaded lazily by the dual export in
 * `src/index.ts` so OpenCode v1 never evaluates it.
 *
 * Compared with v1 there is no loader / custom fetch: the host stores the
 * credential, refreshes it through our `refresh` ~5 min before expiry and sends
 * `Authorization: Bearer <access>` to the bound OpenAI-compatible provider.
 * See docs/v2-analysis.md.
 *
 * Only `import type` from `@opencode/plugin` is allowed (zero runtime deps;
 * guarded by test/v2-export.test.ts).
 */
import type { Plugin } from "@opencode/plugin";
import { hasLocalBrowser } from "../browser.js";
import {
  resolveConfig,
  resolveProviderId,
  type KeycloakConfig,
  type KeycloakPluginOptions,
} from "../config.js";
import { ConfigError, incompleteConfigWarning, notConfiguredMessage } from "../errors.js";
import { log } from "../log.js";
import { buildRegistrations, type OAuthRegistration } from "./methods.js";
import { linkProvider } from "./provider.js";

type SetupContext = Pick<Plugin.Context, "options" | "integration" | "provider">;
type Env = Record<string, string | undefined>;

export interface SetupDeps {
  env?: Env;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const INTEGRATION_NAME = "Keycloak";

export async function setupV2(ctx: SetupContext, deps: SetupDeps = {}): Promise<Plugin.Cleanup> {
  const env = deps.env ?? process.env;
  const options = (ctx.options ?? {}) as KeycloakPluginOptions;
  const preferDevice = !hasLocalBrowser(env, deps.platform ?? process.platform);

  let config: KeycloakConfig;
  try {
    config = resolveConfig(options, env);
  } catch (cause) {
    // Never throw from setup: register the integration anyway so it shows up in
    // `/connect` and explains exactly what is missing when selected.
    const providerId = resolveProviderId(options, env);
    log.warn(incompleteConfigWarning(providerId, cause));
    const reason = cause instanceof Error ? cause.message : String(cause);
    const missing = cause instanceof ConfigError ? cause.missing : [];
    const integration = await registerIntegration(ctx, providerId, [
      notConfigured(providerId, reason, missing),
    ]);
    return () => integration.dispose();
  }

  if (options.refreshLeewaySeconds !== undefined || env["OPENCODE_KC_REFRESH_LEEWAY"] !== undefined) {
    log.debug("refreshLeewaySeconds is ignored on OpenCode v2: the host refreshes ~5 min before expiry");
  }
  log.info(
    `configured (v2): provider=${config.providerId} issuer=${config.issuer} ` +
      `clientId=${config.clientId} scopes=[${config.scopes.join(" ")}] ` +
      `login=${preferDevice ? "device-first" : "browser-first"}`,
  );

  const integration = await registerIntegration(
    ctx,
    config.providerId,
    buildRegistrations(config, {
      preferDevice,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    }),
  );
  const provider = await ctx.provider.transform((editor) => linkProvider(editor, config));

  return async () => {
    await Promise.all([integration.dispose(), provider.dispose()]);
  };
}

function registerIntegration(ctx: SetupContext, id: string, registrations: OAuthRegistration[]) {
  return ctx.integration.transform((editor) => {
    editor.update(id, (integration) => {
      integration.name = INTEGRATION_NAME;
    });
    for (const registration of registrations) editor.method.update(registration);
  });
}

/**
 * Placeholder method used in ERROR mode. OpenCode 2.0.x answers an `authorize`
 * error with a bare HTTP 500 (the message only reaches opencode.log), so the
 * label itself names what is missing.
 */
function notConfigured(providerId: string, reason: string, missing: readonly string[]): OAuthRegistration {
  const detail = missing.length ? `missing: ${missing.join(", ")}` : "see opencode.log";
  return {
    integrationID: providerId,
    method: { id: "not-configured", type: "oauth", label: `Keycloak · ⚠ not configured (${detail})` },
    authorize: async () => {
      throw new Error(notConfiguredMessage(reason));
    },
  };
}
