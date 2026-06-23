/**
 * Device Authorization Grant (RFC 8628) login flow — the headless / SSH /
 * container fallback. Implemented as a `method: "auto"` oauth method: we start
 * the device authorization, show the user code, and the callback polls the token
 * endpoint until the user finishes (or it times out).
 */
import type { AuthOAuthResult } from "@opencode-ai/plugin";
import type { KeycloakConfig } from "../config.js";
import { pollDeviceToken, startDeviceAuthorization } from "../keycloak.js";
import { toSuccess } from "./shared.js";

export interface DeviceFlowDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Build the device-code login method. */
export async function deviceMethod(
  config: KeycloakConfig,
  deps: DeviceFlowDeps = {},
): Promise<AuthOAuthResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const device = await startDeviceAuthorization(config, deps);

  const verificationUrl = device.verificationUriComplete ?? device.verificationUri;

  return {
    url: verificationUrl,
    instructions:
      `To sign in, open this URL on any device:\n  ${device.verificationUri}\n` +
      `and enter the code:\n  ${device.userCode}\n` +
      (device.verificationUriComplete
        ? `(or open ${device.verificationUriComplete}, which pre-fills the code)\n`
        : "") +
      `Waiting for you to approve …`,
    method: "auto",
    callback: async () => {
      let intervalMs = device.intervalMs;
      while (now() < device.expiresAt) {
        await sleep(intervalMs);
        const result = await pollDeviceToken(config, device.deviceCode, deps);
        switch (result.status) {
          case "complete":
            return toSuccess(result.tokens);
          case "slow_down":
            // RFC 8628 §3.5: increase the interval by 5s on slow_down.
            intervalMs += 5000;
            break;
          case "pending":
            break;
          case "denied":
          case "expired":
            return { type: "failed" };
        }
      }
      return { type: "failed" };
    },
  };
}
