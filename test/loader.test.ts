import { describe, expect, it, vi } from "vitest";
import { createLoader } from "../src/loader.js";
import { RefreshFailedError } from "../src/errors.js";
import { jsonFetch, testConfig } from "./helpers.js";

function fakeClient() {
  return { auth: { set: vi.fn(async () => ({})) } };
}

// Minimal Provider stand-in; the loader does not read it.
const provider = {} as never;

const oauth = (over: Partial<{ access: string; refresh: string; expires: number }> = {}) =>
  ({ type: "oauth", access: "OLD", refresh: "OLD_RT", expires: 1_000_000, ...over }) as const;

describe("loader", () => {
  it("returns the stored access token unchanged when it is still fresh", async () => {
    const config = testConfig();
    const client = fakeClient();
    const fetchImpl = jsonFetch([{ body: {} }]);
    const now = () => 900_000; // 100s before expiry > 30s leeway

    const loader = createLoader(config, { client: client as never, fetchImpl, now });
    const result = await loader(async () => oauth(), provider);

    expect(result).toEqual({ apiKey: "OLD" });
    expect(fetchImpl.calls).toHaveLength(0);
    expect(client.auth.set).not.toHaveBeenCalled();
  });

  it("refreshes when the token expires within 30s and persists the new tokens", async () => {
    const config = testConfig();
    const client = fakeClient();
    const fetchImpl = jsonFetch([
      { body: { access_token: "NEW", refresh_token: "NEW_RT", expires_in: 300 } },
    ]);
    const now = () => 980_000; // 20s before expiry < 30s leeway

    const loader = createLoader(config, { client: client as never, fetchImpl, now });
    const result = await loader(async () => oauth(), provider);

    expect(result).toEqual({ apiKey: "NEW" });
    expect(fetchImpl.calls[0]?.params.get("grant_type")).toBe("refresh_token");
    expect(fetchImpl.calls[0]?.params.get("refresh_token")).toBe("OLD_RT");
    expect(client.auth.set).toHaveBeenCalledWith({
      path: { id: "agentgateway" },
      body: { type: "oauth", access: "NEW", refresh: "NEW_RT", expires: 980_000 + 300_000 },
    });
  });

  it("throws RefreshFailedError so OpenCode restarts the login flow", async () => {
    const config = testConfig();
    const client = fakeClient();
    const fetchImpl = jsonFetch([
      { status: 400, body: { error: "invalid_grant", error_description: "token expired" } },
    ]);
    const now = () => 999_000;

    const loader = createLoader(config, { client: client as never, fetchImpl, now });
    await expect(loader(async () => oauth(), provider)).rejects.toBeInstanceOf(RefreshFailedError);
  });

  it("stays out of the way when not authenticated via this OAuth provider", async () => {
    const config = testConfig();
    const client = fakeClient();
    const loader = createLoader(config, { client: client as never });

    expect(await loader(async () => ({ type: "api", key: "k" }) as never, provider)).toEqual({});
    expect(await loader(async () => undefined as never, provider)).toEqual({});
  });
});
