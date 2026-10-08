/**
 * One-shot localhost HTTP server that captures the OAuth redirect of the
 * Authorization Code flow. Shared by the OpenCode v1 and v2 entry points.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { KeycloakConfig } from "../config.js";
import { describe } from "../errors.js";

const SUCCESS_PAGE =
  "<!doctype html><html><head><meta charset=utf-8><title>OpenCode</title></head>" +
  "<body style='font-family:system-ui;padding:3rem;text-align:center'>" +
  "<h2>✓ Authentication complete</h2><p>You can close this tab and return to OpenCode.</p></body></html>";

export interface CallbackServer {
  /** Resolves with the authorization code, or rejects on error/timeout. */
  waitForCode(timeoutMs: number): Promise<string>;
  close(): void;
}

/**
 * Start a one-shot localhost HTTP server that waits for the OAuth redirect.
 * Rejects with a clear message if the port cannot be bound (e.g. in use).
 */
export function startCallbackServer(config: KeycloakConfig, expectedState: string): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let resolveCode: (code: string) => void;
    let rejectCode: (err: Error) => void;
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    // The redirect can arrive (and fail) before anyone awaits `waitForCode`;
    // mark the promise handled so that is not an unhandled rejection. The error
    // still reaches `waitForCode` callers.
    codePromise.catch(() => {});

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
            rejectCode(
              new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser callback.`),
            );
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
