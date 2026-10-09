import { describe, expect, it, vi } from "vitest";
import { createRefresher, toCredential, type OAuthCredential } from "../src/v2/credential.js";
import { jsonFetch, testConfig } from "./helpers.js";

const stored = (over: Partial<OAuthCredential> = {}): OAuthCredential =>
  ({
    type: "oauth",
    methodID: "device",
    access: "OLD-AT",
    refresh: "RT-0",
    expires: 1_000,
    ...over,
  }) as OAuthCredential;

describe("toCredential", () => {
  it("maps a token set to Credential.OAuth with an absolute ms expiry and the method id", () => {
    expect(toCredential({ access: "AT", refresh: "RT", expiresAt: 1_700_000_000_000 }, "oauth")).toEqual({
      type: "oauth",
      methodID: "oauth",
      access: "AT",
      refresh: "RT",
      expires: 1_700_000_000_000,
    });
  });
});

describe("createRefresher", () => {
  it("redeems the refresh token as a public client and returns the rotated credential", async () => {
    const fetchImpl = jsonFetch([
      { body: { access_token: "NEW-AT", refresh_token: "RT-1", expires_in: 300 } },
    ]);
    const refresher = createRefresher(testConfig(), { fetchImpl, now: () => 50_000 });

    const next = await refresher.refresh(stored());

    expect(next).toEqual({
      type: "oauth",
      methodID: "device", // kept: the host finds `refresh` through it
      access: "NEW-AT",
      refresh: "RT-1",
      expires: 350_000,
    });
    const sent = fetchImpl.calls[0]!.params;
    expect(fetchImpl.calls[0]!.url).toBe(
      "https://kc.example.com/realms/agents/protocol/openid-connect/token",
    );
    expect(sent.get("grant_type")).toBe("refresh_token");
    expect(sent.get("refresh_token")).toBe("RT-0");
    expect(sent.get("client_id")).toBe("opencode-cli");
    expect(sent.get("client_secret")).toBeNull();
  });

  it("keeps the credential metadata across a refresh", async () => {
    const fetchImpl = jsonFetch([{ body: { access_token: "A", refresh_token: "R", expires_in: 60 } }]);
    const refresher = createRefresher(testConfig(), { fetchImpl, now: () => 0 });

    const next = await refresher.refresh(stored({ metadata: { imported: true } }));

    expect(next.metadata).toEqual({ imported: true });
  });

  it("turns invalid_grant into an actionable reconnect message without leaking the token", async () => {
    const fetchImpl = jsonFetch([
      { status: 400, body: { error: "invalid_grant", error_description: "Token is not active" } },
    ]);
    const refresher = createRefresher(testConfig(), { fetchImpl, now: () => 0 });

    const error = (await refresher.refresh(stored({ refresh: "SECRET-RT" })).then(
      () => undefined,
      (e: unknown) => e,
    )) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/invalid_grant/);
    expect(error.message).toMatch(/opencode auth login keycloak/);
    expect(error.message).toMatch(/\/connect/);
    expect(error.message).not.toContain("SECRET-RT");
  });

  it("shares one Keycloak call between concurrent refreshes of the same token", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = jsonFetch([{ body: { access_token: "A1", refresh_token: "RT-1", expires_in: 60 } }]);
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      await gate;
      return inner(url, init);
    }) as unknown as typeof fetch;
    const refresher = createRefresher(testConfig(), { fetchImpl, now: () => 0 });

    const first = refresher.refresh(stored());
    const second = refresher.refresh(stored());
    release();

    expect(await second).toEqual(await first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("answers a late caller holding the already-rotated token from cache instead of re-redeeming it", async () => {
    const fetchImpl = jsonFetch([{ body: { access_token: "A1", refresh_token: "RT-1", expires_in: 60 } }]);
    let clock = 0;
    const refresher = createRefresher(testConfig(), { fetchImpl, now: () => clock });

    const first = await refresher.refresh(stored());
    clock = 5_000;
    const late = await refresher.refresh(stored());

    expect(late).toEqual(first);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it("forgets a rotated token after the grace period", async () => {
    const fetchImpl = jsonFetch([
      { body: { access_token: "A1", refresh_token: "RT-1", expires_in: 60 } },
      { body: { access_token: "A2", refresh_token: "RT-2", expires_in: 60 } },
    ]);
    let clock = 0;
    const refresher = createRefresher(testConfig(), { fetchImpl, now: () => clock });

    await refresher.refresh(stored());
    clock = 120_000;
    await refresher.refresh(stored());

    expect(fetchImpl.calls).toHaveLength(2);
  });

  it("does not cache failures: the next call tries again", async () => {
    const fetchImpl = jsonFetch([
      { status: 503, body: { error: "temporarily_unavailable" } },
      { body: { access_token: "A1", refresh_token: "RT-1", expires_in: 60 } },
    ]);
    const refresher = createRefresher(testConfig(), { fetchImpl, now: () => 0 });

    await expect(refresher.refresh(stored())).rejects.toThrow();
    await expect(refresher.refresh(stored())).resolves.toMatchObject({ access: "A1" });
  });
});
