import { describe, expect, it } from "vitest";
import { endpoints, redirectUri, resolveConfig } from "../src/config.js";

describe("config resolution", () => {
  it("reads from environment variables with the OPENCODE_KC_ prefix", () => {
    const config = resolveConfig(
      {},
      {
        OPENCODE_KC_ISSUER: "https://kc.example.com/realms/agents/",
        OPENCODE_KC_CLIENT_ID: "cli",
        OPENCODE_KC_SCOPES: "openid profile aud:api",
        OPENCODE_KC_CALLBACK_PORT: "55001",
      },
    );

    expect(config.issuer).toBe("https://kc.example.com/realms/agents"); // trailing slash trimmed
    expect(config.clientId).toBe("cli");
    expect(config.scopes).toEqual(["openid", "profile", "aud:api"]);
    expect(config.callbackPort).toBe(55001);
    expect(config.providerId).toBe("keycloak"); // default
  });

  it("lets plugin options override environment variables", () => {
    const config = resolveConfig(
      { clientId: "from-options", providerId: "kc" },
      { OPENCODE_KC_ISSUER: "https://kc/realms/r", OPENCODE_KC_CLIENT_ID: "from-env" },
    );
    expect(config.clientId).toBe("from-options");
    expect(config.providerId).toBe("kc");
  });

  it("always includes the openid scope", () => {
    const config = resolveConfig({ issuer: "https://kc/realms/r", clientId: "c", scopes: ["profile"] });
    expect(config.scopes).toContain("openid");
  });

  it("derives Keycloak endpoints and redirect URI", () => {
    const config = resolveConfig({
      issuer: "https://kc/realms/r",
      clientId: "c",
      callbackPort: 49170,
    });
    expect(endpoints(config)).toEqual({
      authorization: "https://kc/realms/r/protocol/openid-connect/auth",
      token: "https://kc/realms/r/protocol/openid-connect/token",
      device: "https://kc/realms/r/protocol/openid-connect/auth/device",
    });
    expect(redirectUri(config)).toBe("http://127.0.0.1:49170/callback");
  });

  it("throws a clear error when issuer or client id is missing", () => {
    expect(() => resolveConfig({}, {})).toThrow(/issuer/i);
    expect(() => resolveConfig({ issuer: "https://kc/realms/r" }, {})).toThrow(/client id/i);
  });
});
