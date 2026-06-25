import { describe, expect, it } from "vitest";
import { KeycloakAuthPlugin } from "../src/index.js";

// The plugin factory only reads `input.client`; everything else is unused here.
const input = { client: {} } as never;

describe("plugin factory", () => {
  it("registers the provider with its real methods when fully configured", async () => {
    const { auth } = await KeycloakAuthPlugin(input, {
      issuer: "https://kc.example.com/realms/agents",
      clientId: "opencode-cli",
      providerId: "keycloak",
    });

    expect(auth?.provider).toBe("keycloak");
    expect(auth?.loader).toBeTypeOf("function");
    expect(auth?.methods).toHaveLength(3);
    expect(auth?.methods.every((m) => m.type === "oauth")).toBe(true);
  });

  it("still registers the provider (does not throw) when the config is incomplete", async () => {
    // Missing issuer/clientId would make resolveConfig throw; the plugin must not
    // fail to load, otherwise OpenCode drops it and the provider never appears.
    const { auth } = await KeycloakAuthPlugin(input, { providerId: "keycloak" });

    expect(auth?.provider).toBe("keycloak"); // honours configured id even when incomplete
    expect(auth?.loader).toBeUndefined();
    expect(auth?.methods).toHaveLength(1);
    expect(auth?.methods[0]?.label).toMatch(/not configured/i);
  });

  it("surfaces an actionable error only when the misconfigured method is selected", async () => {
    const { auth } = await KeycloakAuthPlugin(input, {});
    const method = auth?.methods[0];
    if (method?.type !== "oauth") throw new Error("expected an oauth method");

    await expect(method.authorize()).rejects.toThrow(/issuer/i);
  });

  it("falls back to the default provider id when none is configured", async () => {
    const { auth } = await KeycloakAuthPlugin(input, {});
    expect(auth?.provider).toBe("keycloak"); // DEFAULTS.providerId
  });
});
