import { describe, expect, it, vi } from "vitest";
import { pollDeviceToken, startDeviceAuthorization } from "../src/keycloak.js";
import { deviceMethod } from "../src/flows/device.js";
import { jsonFetch, testConfig } from "./helpers.js";

describe("device authorization grant", () => {
  it("parses the device authorization response", async () => {
    const config = testConfig();
    const fetchImpl = jsonFetch([
      {
        body: {
          device_code: "DEV",
          user_code: "WDJB-MJHT",
          verification_uri: "https://kc.example.com/device",
          verification_uri_complete: "https://kc.example.com/device?user_code=WDJB-MJHT",
          expires_in: 600,
          interval: 5,
        },
      },
    ]);

    const device = await startDeviceAuthorization(config, { fetchImpl, now: () => 0 });

    expect(device.deviceCode).toBe("DEV");
    expect(device.userCode).toBe("WDJB-MJHT");
    expect(device.verificationUri).toBe("https://kc.example.com/device");
    expect(device.verificationUriComplete).toBe(
      "https://kc.example.com/device?user_code=WDJB-MJHT",
    );
    expect(device.expiresAt).toBe(600_000);
    expect(device.intervalMs).toBe(5000);
    expect(fetchImpl.calls[0]?.params.get("client_id")).toBe("opencode-cli");
    expect(fetchImpl.calls[0]?.params.get("scope")).toBe("openid");
  });

  it("maps token-endpoint statuses correctly", async () => {
    const config = testConfig();
    const pending = jsonFetch([{ status: 400, body: { error: "authorization_pending" } }]);
    const slow = jsonFetch([{ status: 400, body: { error: "slow_down" } }]);
    const denied = jsonFetch([{ status: 400, body: { error: "access_denied" } }]);
    const expired = jsonFetch([{ status: 400, body: { error: "expired_token" } }]);
    const done = jsonFetch([{ body: { access_token: "AT", refresh_token: "RT", expires_in: 60 } }]);

    expect((await pollDeviceToken(config, "DEV", { fetchImpl: pending })).status).toBe("pending");
    expect((await pollDeviceToken(config, "DEV", { fetchImpl: slow })).status).toBe("slow_down");
    expect((await pollDeviceToken(config, "DEV", { fetchImpl: denied })).status).toBe("denied");
    expect((await pollDeviceToken(config, "DEV", { fetchImpl: expired })).status).toBe("expired");

    const ok = await pollDeviceToken(config, "DEV", { fetchImpl: done, now: () => 5_000 });
    expect(ok.status).toBe("complete");
    if (ok.status === "complete") {
      expect(ok.tokens).toEqual({ access: "AT", refresh: "RT", expiresAt: 65_000 });
    }
  });

  it("polls until completion and returns a success result", async () => {
    const config = testConfig();
    const fetchImpl = jsonFetch([
      // 1: start device authorization
      { body: { device_code: "DEV", user_code: "AAAA", verification_uri: "https://kc/d", expires_in: 600, interval: 1 } },
      // 2: first poll -> pending
      { status: 400, body: { error: "authorization_pending" } },
      // 3: second poll -> complete
      { body: { access_token: "AT", refresh_token: "RT", expires_in: 120 } },
    ]);
    const sleep = vi.fn(async () => {});
    let clock = 0;

    const method = await deviceMethod(config, { fetchImpl, sleep, now: () => clock });
    expect(method.method).toBe("auto");

    if (method.method !== "auto") throw new Error("expected auto method");
    const result = await method.callback();

    expect(sleep).toHaveBeenCalled();
    expect(result.type).toBe("success");
    if (result.type === "success" && "access" in result) {
      expect(result.access).toBe("AT");
      expect(result.refresh).toBe("RT");
    }
  });
});
