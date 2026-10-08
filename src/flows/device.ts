/**
 * Device Authorization Grant (RFC 8628) login flow — the headless / SSH /
 * container fallback. Implemented as a `method: "auto"` oauth method: we start
 * the device authorization, show the user code, and the callback polls the token
 * endpoint until the user finishes (or it times out).
 */
import type { AuthOAuthResult } from "@opencode-ai/plugin";
import type { KeycloakConfig } from "../config.js";
import { startDeviceAuthorization } from "../keycloak.js";
import { DeviceFlowError, waitForDeviceTokens, type DevicePollDeps } from "./device-poll.js";
import { log } from "../log.js";
import { deviceInstructions, toSuccess } from "./shared.js";

export type DeviceFlowDeps = DevicePollDeps;

/** Build the device-code login method. */
export async function deviceMethod(
  config: KeycloakConfig,
  deps: DeviceFlowDeps = {},
): Promise<AuthOAuthResult> {
  const device = await startDeviceAuthorization(config, deps);

  const verificationUrl = device.verificationUriComplete ?? device.verificationUri;

  return {
    url: verificationUrl,
    instructions: deviceInstructions(device),
    method: "auto",
    callback: async () => {
      try {
        const tokens = await waitForDeviceTokens(config, device, deps);
        log.info(`device login succeeded for ${config.providerId}`);
        return toSuccess(tokens);
      } catch (err) {
        if (err instanceof DeviceFlowError && err.reason === "denied") {
          log.error(`device login denied by the user for ${config.providerId}`);
        } else if (err instanceof DeviceFlowError && err.reason === "expired") {
          log.error(`device code expired before approval for ${config.providerId}`);
        } else if (err instanceof DeviceFlowError) {
          log.error(`device login timed out waiting for approval for ${config.providerId}`);
        } else {
          throw err;
        }
        return { type: "failed" };
      }
    },
  };
}
