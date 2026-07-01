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
      path: { id: "keycloak" },
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

  it("refreshes once the token is already past expiry", async () => {
    const config = testConfig();
    const client = fakeClient();
    const fetchImpl = jsonFetch([
      { body: { access_token: "NEW", refresh_token: "NEW_RT", expires_in: 300 } },
    ]);
    const now = () => 1_500_000; // well past the 1_000_000 expiry

    const loader = createLoader(config, { client: client as never, fetchImpl, now });
    const result = await loader(async () => oauth(), provider);

    expect(result).toEqual({ apiKey: "NEW" });
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it("does not refresh exactly at the leeway boundary, but does one ms inside it", async () => {
    const config = testConfig(); // refreshLeewaySeconds defaults to 30 -> 30_000ms
    const fresh = jsonFetch([{ body: {} }]);
    const stale = jsonFetch([{ body: { access_token: "NEW", refresh_token: "NEW_RT", expires_in: 300 } }]);

    // expires - now === leewayMs  -> NOT refreshed (condition is strictly `<`)
    const atBoundary = createLoader(config, {
      client: fakeClient() as never,
      fetchImpl: fresh,
      now: () => 1_000_000 - 30_000,
    });
    expect(await atBoundary(async () => oauth(), provider)).toEqual({ apiKey: "OLD" });
    expect(fresh.calls).toHaveLength(0);

    // one ms inside the leeway window -> refreshed
    const insideBoundary = createLoader(config, {
      client: fakeClient() as never,
      fetchImpl: stale,
      now: () => 1_000_000 - 30_000 + 1,
    });
    expect(await insideBoundary(async () => oauth(), provider)).toEqual({ apiKey: "NEW" });
    expect(stale.calls).toHaveLength(1);
  });

  it("dedupes concurrent refreshes (single-flight) so the rotating token is redeemed once", async () => {
    const config = testConfig();
    const client = fakeClient();
    const fetchImpl = jsonFetch([
      { body: { access_token: "NEW", refresh_token: "NEW_RT", expires_in: 300 } },
    ]);
    const now = () => 980_000; // within leeway

    const loader = createLoader(config, { client: client as never, fetchImpl, now });

    // Two requests hit the loader at the same time near expiry.
    const [a, b] = await Promise.all([
      loader(async () => oauth(), provider),
      loader(async () => oauth(), provider),
    ]);

    expect(a).toEqual({ apiKey: "NEW" });
    expect(b).toEqual({ apiKey: "NEW" });
    // The refresh token was posted exactly once — the crux of the fix. Two calls
    // here would rotate it once and get invalid_grant on the second, forcing a
    // spurious re-login.
    expect(fetchImpl.calls).toHaveLength(1);
    expect(client.auth.set).toHaveBeenCalledTimes(1);
  });

  it("redeems the rotated refresh token on the next expiry, not the original", async () => {
    const config = testConfig();
    const fetchImpl = jsonFetch([
      { body: { access_token: "NEW1", refresh_token: "RT1", expires_in: 300 } },
      { body: { access_token: "NEW2", refresh_token: "RT2", expires_in: 300 } },
    ]);

    // Simulate OpenCode's storage: persist writes it, the next read sees it.
    let stored = { type: "oauth", access: "OLD", refresh: "OLD_RT", expires: 1_000_000 };
    const client = {
      auth: {
        set: vi.fn(async ({ body }: { body: typeof stored }) => {
          stored = { ...body };
          return {};
        }),
      },
    };
    const clock = { t: 980_000 }; // within leeway of the initial token

    const loader = createLoader(config, {
      client: client as never,
      fetchImpl,
      now: () => clock.t,
    });

    const r1 = await loader(async () => stored as never, provider);
    expect(r1).toEqual({ apiKey: "NEW1" });
    expect(fetchImpl.calls[0]?.params.get("refresh_token")).toBe("OLD_RT");

    // Time moves on; the freshly stored token (expires = 980_000 + 300_000) nears expiry.
    clock.t = stored.expires - 10_000;
    const r2 = await loader(async () => stored as never, provider);
    expect(r2).toEqual({ apiKey: "NEW2" });
    // Must use the rotated token from the first refresh — not the stale OLD_RT.
    expect(fetchImpl.calls[1]?.params.get("refresh_token")).toBe("RT1");
  });

  it("clears the in-flight refresh after a failure so a later request can retry", async () => {
    const config = testConfig();
    const client = fakeClient();
    const fetchImpl = jsonFetch([
      { status: 400, body: { error: "invalid_grant", error_description: "expired" } },
      { body: { access_token: "NEW", refresh_token: "NEW_RT", expires_in: 300 } },
    ]);
    const now = () => 999_000;

    const loader = createLoader(config, { client: client as never, fetchImpl, now });

    await expect(loader(async () => oauth(), provider)).rejects.toBeInstanceOf(RefreshFailedError);

    // A later request (e.g. after the user re-logged in, rotating a fresh token
    // into storage) must not be stuck on the previously-rejected promise.
    const result = await loader(async () => oauth({ refresh: "FRESH_RT" }), provider);
    expect(result).toEqual({ apiKey: "NEW" });
    expect(fetchImpl.calls).toHaveLength(2);
    expect(fetchImpl.calls[1]?.params.get("refresh_token")).toBe("FRESH_RT");
  });
});
