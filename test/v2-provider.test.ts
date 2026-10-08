import { describe, expect, it } from "vitest";
import { linkProvider, type ProviderEditor } from "../src/v2/provider.js";
import { testConfig } from "./helpers.js";

type Info = Record<string, unknown>;

/** In-memory stand-in for the host's provider editor (same contract as `ProviderEditor`). */
function fakeEditor(existing: Record<string, Info> = {}) {
  const providers = new Map<string, Info>(Object.entries(existing));
  const added: Array<{ info: Info; models: readonly unknown[] }> = [];
  const editor = {
    list: () => [...providers.values()].map((provider) => ({ provider, models: new Map() })),
    get: (id: string) => {
      const provider = providers.get(id);
      return provider ? { provider, models: new Map() } : undefined;
    },
    add: (input: { info: Info; models: readonly unknown[] }) => {
      added.push(input);
      providers.set(input.info["id"] as string, input.info);
    },
    update: (id: string, fn: (p: Info) => void) => {
      const current = providers.get(id);
      if (current) fn(current);
    },
    remove: (id: string) => providers.delete(id),
    models: { set() {}, update() {}, remove() {} },
  };
  return { editor: editor as unknown as ProviderEditor, providers, added };
}

describe("linkProvider", () => {
  it("adds an openai-compatible provider bound to the integration when a baseUrl is configured", () => {
    const { editor, added } = fakeEditor();

    linkProvider(editor, testConfig({ providerId: "keycloak", baseUrl: "https://uap.example.com/v1" }));

    expect(added).toEqual([
      {
        info: {
          id: "keycloak",
          name: "Keycloak",
          activation: "auto",
          package: "@opencode/ai/providers/openai-compatible",
          integrationID: "keycloak",
          settings: { baseURL: "https://uap.example.com/v1" },
        },
        // opencode.json `providers.<id>.models` (and settings/headers) are overlaid by the host.
        models: [],
      },
    ]);
  });

  it("only binds the integration on an already-known provider, keeping its settings and name", () => {
    const original = {
      id: "keycloak",
      name: "My Gateway",
      activation: "enabled",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: "https://user.example.com/v1" },
      headers: { "X-Client": "opencode" },
    };
    const { editor, providers, added } = fakeEditor({ keycloak: { ...original } });

    linkProvider(editor, testConfig({ providerId: "keycloak", baseUrl: "https://other.example.com/v1" }));

    expect(added).toEqual([]);
    expect(providers.get("keycloak")).toEqual({ ...original, integrationID: "keycloak" });
  });

  it("leaves the provider to opencode.json when no baseUrl is configured (bound implicitly by id)", () => {
    const { editor, providers, added } = fakeEditor();

    linkProvider(editor, testConfig({ providerId: "keycloak", baseUrl: undefined }));

    expect(added).toEqual([]);
    expect(providers.size).toBe(0);
  });
});
