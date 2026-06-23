import { describe, expect, it } from "vitest";
import { exchangeCode } from "../src/keycloak.js";
import { buildAuthorizeUrl } from "../src/flows/shared.js";
import { generatePkce } from "../src/pkce.js";
import { KeycloakOAuthError } from "../src/errors.js";
import { jsonFetch, testConfig } from "./helpers.js";

describe("authorization code flow", () => {
  it("builds an authorize URL with PKCE S256 and the right params", () => {
    const config = testConfig();
    const pkce = generatePkce();
    const url = new URL(buildAuthorizeUrl(config, pkce, "state-123"));

    expect(url.origin + url.pathname).toBe(
      "https://kc.example.com/realms/agents/protocol/openid-connect/auth",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("opencode-cli");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:49170/callback");
    expect(url.searchParams.get("scope")).toBe("openid");
    expect(url.searchParams.get("code_challenge")).toBe(pkce.challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-123");
  });

  it("exchanges an authorization code for tokens with the verifier", async () => {
    const config = testConfig();
    const fetchImpl = jsonFetch([
      { body: { access_token: "AT", refresh_token: "RT", expires_in: 300 } },
    ]);

    const tokens = await exchangeCode(
      config,
      { code: "the-code", verifier: "the-verifier", redirectUri: "http://127.0.0.1:49170/callback" },
      { fetchImpl, now: () => 1_000_000 },
    );

    expect(tokens).toEqual({ access: "AT", refresh: "RT", expiresAt: 1_000_000 + 300_000 });
    expect(fetchImpl.calls[0]?.url).toBe(
      "https://kc.example.com/realms/agents/protocol/openid-connect/token",
    );
    const sent = fetchImpl.calls[0]!.params;
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code")).toBe("the-code");
    expect(sent.get("code_verifier")).toBe("the-verifier");
    expect(sent.get("client_id")).toBe("opencode-cli");
    expect(sent.get("client_secret")).toBeNull(); // public client, no secret
  });

  it("surfaces a structured Keycloak error on a bad code", async () => {
    const config = testConfig();
    const fetchImpl = jsonFetch([
      { status: 400, body: { error: "invalid_grant", error_description: "Code not valid" } },
    ]);

    await expect(
      exchangeCode(config, { code: "bad", verifier: "v", redirectUri: "r" }, { fetchImpl }),
    ).rejects.toBeInstanceOf(KeycloakOAuthError);
  });
});
