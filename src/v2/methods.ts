/**
 * OpenCode v2 login methods for the Keycloak integration.
 *
 * Each method is an `oauth` method registration (`authorize` + `refresh`). The
 * v2 contract differs from v1 in three ways that matter here:
 *  - `authorize` returns `{ url, instructions, expiresAt?, mode, callback }`;
 *    in `auto` mode `callback` is a Promise (not a function), in `code` mode it is
 *    `(code) => Promise<Credential.OAuth>`.
 *  - The credential carries `methodID`; the host finds `refresh` through it, so
 *    every method must expose `refresh`.
 *  - A rejected callback becomes the attempt's `failed` message shown by the
 *    host, so failures are thrown as descriptive errors (never secrets).
 *
 * Method ids: `oauth` (browser auto-capture — also the id OpenCode's legacy
 * auth.json import assigns to custom OAuth providers), `code` (paste the code)
 * and `device` (RFC 8628).
 */
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/promise/integration";
import { redirectUri, type KeycloakConfig } from "../config.js";
import { describe } from "../errors.js";
import { exchangeCode, startDeviceAuthorization } from "../keycloak.js";
import { log } from "../log.js";
import { generatePkce, randomState } from "../pkce.js";
import { startCallbackServer } from "../flows/callback-server.js";
import { waitForDeviceTokens } from "../flows/device-poll.js";
import { buildAuthorizeUrl, deviceInstructions, pasteCodeInstructions } from "../flows/shared.js";
import { createRefresher, toCredential, type OAuthCredential } from "./credential.js";

export type OAuthRegistration = IntegrationOAuthMethodRegistration;
type Authorization = Awaited<ReturnType<OAuthRegistration["authorize"]>>;

export interface MethodDeps {
  /** Lead with the device flow (no local browser detected). */
  preferDevice: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function buildRegistrations(config: KeycloakConfig, deps: MethodDeps): OAuthRegistration[] {
  const now = deps.now ?? Date.now;
  const net = {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    now,
  };
  const refresher = createRefresher(config, net);
  const refresh = (credential: OAuthCredential) => refresher.refresh(credential);
  const recommended = (yes: boolean) => (yes ? " — recommended" : "");

  const register = (
    id: string,
    label: string,
    authorize: () => Promise<Authorization>,
  ): OAuthRegistration => ({
    integrationID: config.providerId,
    method: { id, type: "oauth", label },
    authorize,
    refresh,
  });

  // A failed login must reach the host as a rejection carrying the reason.
  const settle = async (flow: string, run: () => Promise<OAuthCredential>): Promise<OAuthCredential> => {
    try {
      const credential = await run();
      log.info(`${flow} login succeeded for ${config.providerId}`);
      return credential;
    } catch (err) {
      log.error(`${flow} login failed for ${config.providerId}: ${describe(err)}`);
      throw err;
    }
  };

  const browserAuto = register(
    "oauth",
    `Keycloak · Browser (PKCE, auto-capture)${recommended(!deps.preferDevice)}`,
    async () => {
      const pkce = generatePkce();
      const state = randomState();
      // Bind the server BEFORE handing the URL back, so it is ready for the redirect.
      const server = await startCallbackServer(config, state);
      const url = buildAuthorizeUrl(config, pkce, state);
      const timeoutMs = config.browserTimeoutSeconds * 1000;
      const callback = settle("browser (auto-capture)", async () => {
        try {
          const code = await server.waitForCode(timeoutMs);
          const tokens = await exchangeCode(
            config,
            { code, verifier: pkce.verifier, redirectUri: redirectUri(config) },
            net,
          );
          return toCredential(tokens, "oauth");
        } finally {
          server.close();
        }
      });
      // The host subscribes right after `authorize` resolves; never let an early
      // failure surface as an unhandled rejection in between.
      callback.catch(() => {});
      return {
        url,
        instructions:
          `Opening your browser to sign in with Keycloak.\n` +
          `Waiting for the redirect to ${redirectUri(config)} …`,
        expiresAt: now() + timeoutMs,
        mode: "auto",
        callback,
      };
    },
  );

  const browserPaste = register("code", "Keycloak · Browser (paste the code)", async () => {
    const pkce = generatePkce();
    const url = buildAuthorizeUrl(config, pkce, randomState());
    return {
      url,
      instructions: pasteCodeInstructions(config),
      mode: "code",
      callback: (code: string) =>
        settle("browser (paste-code)", async () => {
          const tokens = await exchangeCode(
            config,
            { code: code.trim(), verifier: pkce.verifier, redirectUri: redirectUri(config) },
            net,
          );
          return toCredential(tokens, "code");
        }),
    };
  });

  const device = register(
    "device",
    `Keycloak · Device code (headless / SSH)${recommended(deps.preferDevice)}`,
    async () => {
      const authorization = await startDeviceAuthorization(config, net);
      const callback = settle("device", async () =>
        toCredential(
          await waitForDeviceTokens(config, authorization, {
            ...net,
            ...(deps.sleep ? { sleep: deps.sleep } : {}),
          }),
          "device",
        ),
      );
      callback.catch(() => {});
      return {
        url: authorization.verificationUriComplete ?? authorization.verificationUri,
        instructions: deviceInstructions(authorization),
        expiresAt: authorization.expiresAt,
        mode: "auto",
        callback,
      };
    },
  );

  // Headless: lead with the device flow; all methods stay available either way.
  return deps.preferDevice ? [device, browserPaste, browserAuto] : [browserAuto, browserPaste, device];
}
