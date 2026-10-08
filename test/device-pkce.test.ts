import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { pollDeviceToken, startDeviceAuthorization } from "../src/keycloak.js";
import { waitForDeviceTokens } from "../src/flows/device-poll.js";
import { jsonFetch, testConfig } from "./helpers.js";

// A client with "PKCE: S256" (the shared workstation client) makes Keycloak 26
// require PKCE on the device grant too: without code_challenge the device
// authorization fails with "Missing parameter: code_challenge".
const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

const deviceResponse = {
  body: {
    device_code: "DEV",
    user_code: "AAAA",
    verification_uri: "https://kc/d",
    expires_in: 600,
    interval: 1,
  },
};

describe("device grant with PKCE", () => {
  it("sends an S256 code_challenge and keeps the matching verifier", async () => {
    const fetchImpl = jsonFetch([deviceResponse]);

    const device = await startDeviceAuthorization(testConfig(), { fetchImpl, now: () => 0 });

    const sent = fetchImpl.calls[0]!.params;
    expect(sent.get("code_challenge_method")).toBe("S256");
    expect(sent.get("code_challenge")).toBe(s256(device.codeVerifier));
  });

  it("sends the code_verifier when polling the token endpoint", async () => {
    const fetchImpl = jsonFetch([{ status: 400, body: { error: "authorization_pending" } }]);

    await pollDeviceToken(testConfig(), "DEV", { fetchImpl }, "the-verifier");

    expect(fetchImpl.calls[0]!.params.get("code_verifier")).toBe("the-verifier");
  });

  it("polls with the verifier issued at authorization time", async () => {
    const fetchImpl = jsonFetch([
      deviceResponse,
      { body: { access_token: "AT", refresh_token: "RT", expires_in: 60 } },
    ]);
    const config = testConfig();
    const device = await startDeviceAuthorization(config, { fetchImpl, now: () => 0 });

    await waitForDeviceTokens(config, device, { fetchImpl, now: () => 0, sleep: async () => {} });

    expect(fetchImpl.calls[1]!.params.get("code_verifier")).toBe(device.codeVerifier);
  });
});
