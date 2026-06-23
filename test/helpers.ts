import { vi } from "vitest";
import { resolveConfig, type KeycloakConfig } from "../src/config.js";

export function testConfig(overrides: Partial<KeycloakConfig> = {}): KeycloakConfig {
  const base = resolveConfig(
    {
      issuer: "https://kc.example.com/realms/agents",
      clientId: "opencode-cli",
      providerId: "agentgateway",
      callbackPort: 49170,
    },
    {},
  );
  return { ...base, ...overrides };
}

/** Build a `fetch` mock that returns the given JSON bodies in sequence. */
export function jsonFetch(
  responses: Array<{ status?: number; body: unknown }>,
): typeof fetch & { calls: Array<{ url: string; params: URLSearchParams }> } {
  const calls: Array<{ url: string; params: URLSearchParams }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    calls.push({ url: String(url), params: new URLSearchParams(body) });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(JSON.stringify(next?.body ?? {}), {
      status: next?.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return Object.assign(fn as unknown as typeof fetch, { calls });
}
