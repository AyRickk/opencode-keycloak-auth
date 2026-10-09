import { describe, expect, it, vi } from "vitest";
import { setupV2 } from "../src/v2/index.js";

interface Method {
  id: string;
  type: string;
  label: string;
}
interface Registration {
  integrationID: string;
  method: Method;
  authorize: (answer: unknown) => Promise<unknown>;
  refresh?: unknown;
}

/** Minimal stand-in for the v2 plugin context: records what setup registers. */
function fakeContext(options: Record<string, unknown> = {}) {
  const integrations = new Map<string, { name: string; methods: Registration[] }>();
  const providersAdded: Array<{ info: Record<string, unknown> }> = [];
  const disposed: string[] = [];
  const integrationEditor = {
    list: () => [],
    get: (id: string) => integrations.get(id),
    update: (id: string, fn: (ref: { id: string; name: string }) => void) => {
      const entry = integrations.get(id) ?? { name: id, methods: [] };
      const ref = { id, name: entry.name };
      fn(ref);
      integrations.set(id, { ...entry, name: ref.name });
    },
    remove: () => {},
    method: {
      list: () => [],
      update: (reg: Registration) => {
        const entry = integrations.get(reg.integrationID) ?? { name: reg.integrationID, methods: [] };
        entry.methods.push(reg);
        integrations.set(reg.integrationID, entry);
      },
      remove: () => {},
    },
  };
  const providerEditor = {
    list: () => [],
    get: () => undefined,
    add: (input: { info: Record<string, unknown> }) => providersAdded.push(input),
    update: () => {},
    remove: () => {},
    models: { set() {}, update() {}, remove() {} },
  };
  const ctx = {
    options,
    integration: {
      transform: async (fn: (e: typeof integrationEditor) => void) => {
        fn(integrationEditor);
        return { dispose: async () => void disposed.push("integration") };
      },
    },
    provider: {
      transform: async (fn: (e: typeof providerEditor) => void) => {
        fn(providerEditor);
        return { dispose: async () => void disposed.push("provider") };
      },
    },
  };
  return { ctx: ctx as never, integrations, providersAdded, disposed };
}

const desktop = { env: {}, platform: "darwin" as const };
const configured = { issuer: "https://kc.example.com/realms/agents", clientId: "opencode-cli" };

describe("setupV2", () => {
  it("registers the Keycloak integration with its three login methods", async () => {
    const { ctx, integrations } = fakeContext(configured);

    await setupV2(ctx, desktop);

    const kc = integrations.get("keycloak");
    expect(kc?.name).toBe("Keycloak");
    expect(kc?.methods.map((m) => m.method.id)).toEqual(["oauth", "code", "device"]);
    expect(kc?.methods.every((m) => typeof m.refresh === "function")).toBe(true);
  });

  it("offers the device flow first on a headless host", async () => {
    const { ctx, integrations } = fakeContext(configured);

    await setupV2(ctx, { env: { SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" }, platform: "linux" });

    expect(integrations.get("keycloak")?.methods[0]?.method.id).toBe("device");
  });

  it("reads plugin options first, then OPENCODE_KC_* environment variables", async () => {
    const { ctx, integrations } = fakeContext({ ...configured, providerId: "from-options" });

    await setupV2(ctx, {
      env: { OPENCODE_KC_PROVIDER_ID: "from-env", OPENCODE_KC_ISSUER: "https://ignored/realms/x" },
      platform: "darwin",
    });

    expect([...integrations.keys()]).toEqual(["from-options"]);
  });

  it("falls back to OPENCODE_KC_* when no plugin options are given", async () => {
    const { ctx, integrations } = fakeContext({});

    await setupV2(ctx, {
      env: {
        OPENCODE_KC_ISSUER: "https://kc/realms/r",
        OPENCODE_KC_CLIENT_ID: "cli",
        OPENCODE_KC_PROVIDER_ID: "gw",
      },
      platform: "darwin",
    });

    expect(integrations.get("gw")?.methods).toHaveLength(3);
  });

  it("adds the provider when a baseUrl is configured", async () => {
    const { ctx, providersAdded } = fakeContext({ ...configured, baseUrl: "https://uap.example.com/v1" });

    await setupV2(ctx, desktop);

    expect(providersAdded.map((p) => p.info["id"])).toEqual(["keycloak"]);
  });

  it("accepts refreshLeewaySeconds without failing (the host owns the refresh schedule)", async () => {
    const { ctx, integrations } = fakeContext({ ...configured, refreshLeewaySeconds: 120 });

    await setupV2(ctx, desktop);

    expect(integrations.get("keycloak")?.methods).toHaveLength(3);
  });

  it("returns a cleanup that disposes what it registered", async () => {
    const { ctx, disposed } = fakeContext(configured);

    const cleanup = await setupV2(ctx, desktop);
    await cleanup?.();

    expect(disposed.sort()).toEqual(["integration", "provider"]);
  });

  describe("ERROR mode (incomplete configuration)", () => {
    it("still registers the integration with a single explanatory method", async () => {
      const { ctx, integrations } = fakeContext({ providerId: "keycloak" });

      await setupV2(ctx, desktop);

      const methods = integrations.get("keycloak")?.methods ?? [];
      expect(methods).toHaveLength(1);
      expect(methods[0]?.method.label).toMatch(/not configured/i);
    });

    it("names the missing settings in the method label (v2 hides authorize errors behind HTTP 500)", async () => {
      const { ctx, integrations } = fakeContext({ issuer: "https://kc/realms/r" });

      await setupV2(ctx, desktop);

      expect(integrations.get("keycloak")!.methods[0]!.method.label).toMatch(/missing: clientId\b/);
    });

    it("names exactly the missing values when the method is selected", async () => {
      const { ctx, integrations } = fakeContext({ clientId: "cli" });

      await setupV2(ctx, desktop);

      const method = integrations.get("keycloak")!.methods[0]!;
      await expect(method.authorize({})).rejects.toThrow(/Missing required Keycloak setting\(s\): issuer\./);
    });

    it("logs a warning naming the missing settings", async () => {
      vi.stubEnv("OPENCODE_KC_LOG", "warn");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { ctx } = fakeContext({});

      await setupV2(ctx, desktop);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/ERROR mode.*missing: issuer, clientId/);
    });
  });
});
