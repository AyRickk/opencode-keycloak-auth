import { describe, expect, it, vi } from "vitest";
import { waitForDeviceTokens } from "../src/flows/device-poll.js";
import type { DeviceAuthorization } from "../src/keycloak.js";
import { jsonFetch, testConfig } from "./helpers.js";

const device = (over: Partial<DeviceAuthorization> = {}): DeviceAuthorization => ({
  deviceCode: "DEV",
  userCode: "AAAA-BBBB",
  verificationUri: "https://kc/device",
  verificationUriComplete: undefined,
  expiresAt: 600_000,
  intervalMs: 5_000,
  codeVerifier: "VERIFIER",
  ...over,
});

describe("waitForDeviceTokens", () => {
  it("polls past authorization_pending and resolves with the token set", async () => {
    const fetchImpl = jsonFetch([
      { status: 400, body: { error: "authorization_pending" } },
      { body: { access_token: "AT", refresh_token: "RT", expires_in: 120 } },
    ]);
    const sleep = vi.fn(async () => {});

    const tokens = await waitForDeviceTokens(testConfig(), device(), { fetchImpl, sleep, now: () => 1_000 });

    expect(tokens).toEqual({ access: "AT", refresh: "RT", expiresAt: 121_000 });
    expect(fetchImpl.calls.map((c) => c.params.get("device_code"))).toEqual(["DEV", "DEV"]);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("adds 5s to the interval on slow_down (RFC 8628 §3.5)", async () => {
    const fetchImpl = jsonFetch([
      { status: 400, body: { error: "slow_down" } },
      { body: { access_token: "AT", refresh_token: "RT", expires_in: 60 } },
    ]);
    const sleep = vi.fn(async (_ms: number) => {});

    await waitForDeviceTokens(testConfig(), device({ intervalMs: 5_000 }), {
      fetchImpl,
      sleep,
      now: () => 0,
    });

    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5_000, 10_000]);
  });

  it("rejects with a clear message when the user denies the request", async () => {
    const fetchImpl = jsonFetch([{ status: 400, body: { error: "access_denied" } }]);
    await expect(
      waitForDeviceTokens(testConfig(), device(), { fetchImpl, sleep: async () => {}, now: () => 0 }),
    ).rejects.toThrow(/denied/i);
  });

  it("rejects when Keycloak reports the device code expired", async () => {
    const fetchImpl = jsonFetch([{ status: 400, body: { error: "expired_token" } }]);
    await expect(
      waitForDeviceTokens(testConfig(), device(), { fetchImpl, sleep: async () => {}, now: () => 0 }),
    ).rejects.toThrow(/expired/i);
  });

  it("stops polling once the local clock passes the device-code expiry", async () => {
    const fetchImpl = jsonFetch([{ status: 400, body: { error: "authorization_pending" } }]);
    let clock = 0;
    const sleep = async (ms: number) => {
      clock += ms;
    };

    await expect(
      waitForDeviceTokens(testConfig(), device({ expiresAt: 12_000, intervalMs: 5_000 }), {
        fetchImpl,
        sleep,
        now: () => clock,
      }),
    ).rejects.toThrow(/timed out/i);
    // The expiry is checked before each wait (same loop as v1): polls at 5s, 10s
    // and 15s, then the 15s clock is past the 12s expiry and it gives up.
    expect(fetchImpl.calls).toHaveLength(3);
  });
});
