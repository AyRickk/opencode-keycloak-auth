/**
 * Authorization Code + PKCE (S256) login flows.
 *
 * Two variants are exposed because the OpenCode auth API only has `oauth`
 * methods discriminated by `method`:
 *
 *  - `method: "auto"`  → we spin up a localhost callback server that captures
 *                        the redirect automatically (best UX on a workstation).
 *  - `method: "code"`  → no server; the user is redirected to localhost, copies
 *                        the `code` query param from the address bar and pastes
 *                        it back into OpenCode (manual fallback when the port is
 *                        taken or a browser lives on another machine).
 */
import type { AuthOAuthResult } from "@opencode-ai/plugin";
import { redirectUri, type KeycloakConfig } from "../config.js";
import { exchangeCode } from "../keycloak.js";
import { generatePkce, randomState } from "../pkce.js";
import { describe } from "../errors.js";
import { log } from "../log.js";
import { buildAuthorizeUrl, toSuccess } from "./shared.js";
import { startCallbackServer } from "./callback-server.js";

/** Browser flow with automatic localhost capture (`method: "auto"`). */
export async function browserAutoMethod(config: KeycloakConfig): Promise<AuthOAuthResult> {
  const pkce = generatePkce();
  const state = randomState();
  // Bind the server BEFORE handing the URL back, so it is ready for the redirect.
  const server = await startCallbackServer(config, state);
  const url = buildAuthorizeUrl(config, pkce, state);

  return {
    url,
    instructions:
      `Opening your browser to sign in with Keycloak.\n` +
      `Waiting for the redirect to ${redirectUri(config)} …`,
    method: "auto",
    callback: async () => {
      try {
        const code = await server.waitForCode(config.browserTimeoutSeconds * 1000);
        const tokens = await exchangeCode(config, {
          code,
          verifier: pkce.verifier,
          redirectUri: redirectUri(config),
        });
        log.info(`browser (auto-capture) login succeeded for ${config.providerId}`);
        return toSuccess(tokens);
      } catch (err) {
        // Previously swallowed silently, leaving the user with an opaque "failed".
        log.error(`browser (auto-capture) login failed for ${config.providerId}: ${describe(err)}`);
        return { type: "failed" };
      } finally {
        server.close();
      }
    },
  };
}

/** Browser flow with manual code paste, no local server (`method: "code"`). */
export function browserCodeMethod(config: KeycloakConfig): AuthOAuthResult {
  const pkce = generatePkce();
  const state = randomState();
  const url = buildAuthorizeUrl(config, pkce, state);

  return {
    url,
    instructions:
      `Open the URL and sign in. You will be redirected to\n` +
      `${redirectUri(config)}?code=...&state=...\n` +
      `(the page itself may fail to load — that is expected). Copy the value of the ` +
      `\`code\` query parameter from your browser's address bar and paste it here.`,
    method: "code",
    callback: async (code: string) => {
      try {
        const tokens = await exchangeCode(config, {
          code: code.trim(),
          verifier: pkce.verifier,
          redirectUri: redirectUri(config),
        });
        log.info(`browser (paste-code) login succeeded for ${config.providerId}`);
        return toSuccess(tokens);
      } catch (err) {
        log.error(`browser (paste-code) login failed for ${config.providerId}: ${describe(err)}`);
        return { type: "failed" };
      }
    },
  };
}
