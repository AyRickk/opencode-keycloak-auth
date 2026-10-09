/**
 * Device Authorization Grant polling loop (RFC 8628 §3.4–3.5), shared by the
 * OpenCode v1 and v2 entry points. The caller injects `sleep`/`now` so the loop
 * stays testable without real timers.
 */
import type { KeycloakConfig } from "../config.js";
import { pollDeviceToken, type DeviceAuthorization, type TokenSet } from "../keycloak.js";

export interface DevicePollDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Thrown when the device flow ends without tokens (denied, expired, timed out). */
export class DeviceFlowError extends Error {
  readonly reason: "denied" | "expired" | "timeout";

  constructor(reason: "denied" | "expired" | "timeout") {
    super(
      reason === "denied"
        ? "Device login was denied in the browser."
        : reason === "expired"
          ? "The device code expired before it was approved. Start the login again."
          : "Device login timed out waiting for approval. Start the login again.",
    );
    this.name = "DeviceFlowError";
    this.reason = reason;
  }
}

/** Poll the token endpoint until the user approves the device code. */
export async function waitForDeviceTokens(
  config: KeycloakConfig,
  device: DeviceAuthorization,
  deps: DevicePollDeps = {},
): Promise<TokenSet> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  let intervalMs = device.intervalMs;
  while (now() < device.expiresAt) {
    await sleep(intervalMs);
    const result = await pollDeviceToken(config, device.deviceCode, deps, device.codeVerifier);
    switch (result.status) {
      case "complete":
        return result.tokens;
      case "slow_down":
        // RFC 8628 §3.5: increase the interval by 5s on slow_down.
        intervalMs += 5000;
        break;
      case "pending":
        break;
      case "denied":
        throw new DeviceFlowError("denied");
      case "expired":
        throw new DeviceFlowError("expired");
    }
  }
  throw new DeviceFlowError("timeout");
}
