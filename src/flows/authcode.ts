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
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuthOAuthResult } from "@opencode-ai/plugin";
import { redirectUri, type KeycloakConfig } from "../config.js";
import { exchangeCode } from "../keycloak.js";
import { generatePkce, randomState } from "../pkce.js";
import { describe } from "../errors.js";
import { buildAuthorizeUrl, toSuccess } from "./shared.js";

const SUCCESS_PAGE =
  "<!doctype html><html><head><meta charset=utf-8><title>OpenCode</title></head>" +
  "<body style='font-family:system-ui;padding:3rem;text-align:center'>" +
  "<h2>✓ Authentication complete</h2><p>You can close this tab and return to OpenCode.</p></body></html>";

interface CallbackServer {
  /** Resolves with the authorization code, or rejects on error/timeout. */
  waitForCode(timeoutMs: number): Promise<string>;
  close(): void;
}

/**
 * Start a one-shot localhost HTTP server that waits for the OAuth redirect.
 * Rejects with a clear message if the port cannot be bound (e.g. in use).
 */
function startCallbackServer(config: KeycloakConfig, expectedState: string): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let resolveCode: (code: string) => void;
    let rejectCode: (err: Error) => void;
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${config.callbackHost}:${config.callbackPort}`);
      if (url.pathname !== config.redirectPath) {
        res.writeHead(404).end("Not found");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end(`Authentication failed: ${error}`);
        rejectCode(new Error(`Keycloak returned error: ${error}`));
        return;
      }
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end("Missing authorization code");
        rejectCode(new Error("Callback did not include an authorization code."));
        return;
      }
      if (state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end("State mismatch");
        rejectCode(new Error("OAuth state mismatch — possible CSRF, aborting."));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" }).end(SUCCESS_PAGE);
      resolveCode(code);
    });

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Callback port ${config.callbackPort} is already in use. ` +
              `Set OPENCODE_KC_CALLBACK_PORT to a free port, use the "paste the code" method, ` +
              `or log in with the device flow.`,
          ),
        );
      } else {
        reject(new Error(`Could not start callback server: ${describe(err)}`));
      }
    });

    server.listen(config.callbackPort, config.callbackHost, () => {
      const address = server.address() as AddressInfo | null;
      // If the user asked for an ephemeral port (0), reflect the chosen one so
      // the redirect_uri the user reads matches reality.
      if (address && config.callbackPort === 0) config.callbackPort = address.port;

      resolve({
        waitForCode(timeoutMs: number) {
          const timeout = setTimeout(() => {
            rejectCode(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser callback.`));
          }, timeoutMs);
          timeout.unref?.();
          return codePromise.finally(() => clearTimeout(timeout));
        },
        close() {
          server.close();
        },
      });
    });
  });
}

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
        return toSuccess(tokens);
      } catch {
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
        return toSuccess(tokens);
      } catch {
        return { type: "failed" };
      }
    },
  };
}
