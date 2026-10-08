import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { buildRegistrations, type OAuthRegistration } from "../src/v2/methods.js";
import { jsonFetch, testConfig } from "./helpers.js";

const byId = (regs: OAuthRegistration[], id: string): OAuthRegistration => {
  const reg = regs.find((r) => r.method.id === id);
  if (!reg) throw new Error(`no method ${id}`);
  return reg;
};

const s256 = (verifier: string) =>
  createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

describe("buildRegistrations", () => {
  it("registers oauth (auto-capture), code (paste) and device methods on the provider's integration", () => {
    const regs = buildRegistrations(testConfig({ providerId: "kc" }), { preferDevice: false });

    expect(regs.map((r) => r.method.id)).toEqual(["oauth", "code", "device"]);
    expect(regs.every((r) => r.integrationID === "kc" && r.method.type === "oauth")).toBe(true);
    expect(regs.every((r) => typeof r.refresh === "function")).toBe(true);
  });

  it("leads with the device flow when no local browser is available", () => {
    const regs = buildRegistrations(testConfig(), { preferDevice: true });

    expect(regs.map((r) => r.method.id)).toEqual(["device", "code", "oauth"]);
    expect(regs[0]!.method.label).toMatch(/recommended/);
  });

  it("refreshes through one shared single-flight refresher whatever the method", async () => {
    const fetchImpl = jsonFetch([{ body: { access_token: "A", refresh_token: "R1", expires_in: 60 } }]);
    const regs = buildRegistrations(testConfig(), { preferDevice: false, fetchImpl, now: () => 0 });
    const cred = { type: "oauth", methodID: "oauth", access: "x", refresh: "R0", expires: 0 } as never;

    await Promise.all([byId(regs, "oauth").refresh!(cred), byId(regs, "device").refresh!(cred)]);

    expect(fetchImpl.calls).toHaveLength(1);
  });
});

describe("code (paste) method", () => {
  it("returns a PKCE S256 authorize URL in code mode", async () => {
    const auth = await byId(buildRegistrations(testConfig(), { preferDevice: false }), "code").authorize({});

    expect(auth.mode).toBe("code");
    const url = new URL(auth.url);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:49170/callback");
    expect(auth.instructions).toMatch(/paste/i);
  });

  it("exchanges the pasted code with the matching verifier and stores methodID=code", async () => {
    const fetchImpl = jsonFetch([{ body: { access_token: "AT", refresh_token: "RT", expires_in: 300 } }]);
    const reg = byId(
      buildRegistrations(testConfig(), { preferDevice: false, fetchImpl, now: () => 1_000 }),
      "code",
    );
    const auth = await reg.authorize({});
    if (auth.mode !== "code") throw new Error("expected code mode");

    const credential = await auth.callback("  the-code \n");

    expect(credential).toEqual({
      type: "oauth",
      methodID: "code",
      access: "AT",
      refresh: "RT",
      expires: 301_000,
    });
    const sent = fetchImpl.calls[0]!.params;
    expect(sent.get("code")).toBe("the-code");
    expect(s256(sent.get("code_verifier")!)).toBe(new URL(auth.url).searchParams.get("code_challenge"));
  });

  it("rejects with Keycloak's reason when the code is refused", async () => {
    const fetchImpl = jsonFetch([
      { status: 400, body: { error: "invalid_grant", error_description: "Code not valid" } },
    ]);
    const auth = await byId(
      buildRegistrations(testConfig(), { preferDevice: false, fetchImpl }),
      "code",
    ).authorize({});
    if (auth.mode !== "code") throw new Error("expected code mode");

    await expect(auth.callback("bad")).rejects.toThrow(/Code not valid/);
  });
});

describe("device method", () => {
  const deviceStart = {
    body: {
      device_code: "DEV",
      user_code: "WDJB-MJHT",
      verification_uri: "https://kc.example.com/device",
      verification_uri_complete: "https://kc.example.com/device?user_code=WDJB-MJHT",
      expires_in: 600,
      interval: 5,
    },
  };

  it("shows the code and verification URL and expires with the device code", async () => {
    const fetchImpl = jsonFetch([
      deviceStart,
      { body: { access_token: "AT", refresh_token: "RT", expires_in: 60 } },
    ]);
    const reg = byId(
      buildRegistrations(testConfig(), {
        preferDevice: true,
        fetchImpl,
        now: () => 10_000,
        sleep: async () => {},
      }),
      "device",
    );

    const auth = await reg.authorize({});

    expect(auth.mode).toBe("auto");
    expect(auth.url).toBe("https://kc.example.com/device?user_code=WDJB-MJHT");
    expect(auth.instructions).toContain("WDJB-MJHT");
    expect(auth.instructions).toContain("https://kc.example.com/device");
    expect(auth.expiresAt).toBe(610_000);
    if (auth.mode !== "auto") throw new Error("expected auto mode");
    await expect(auth.callback).resolves.toEqual({
      type: "oauth",
      methodID: "device",
      access: "AT",
      refresh: "RT",
      expires: 70_000,
    });
  });

  it("rejects the attempt with a clear message when the user denies it", async () => {
    const fetchImpl = jsonFetch([deviceStart, { status: 400, body: { error: "access_denied" } }]);
    const reg = byId(
      buildRegistrations(testConfig(), {
        preferDevice: true,
        fetchImpl,
        now: () => 0,
        sleep: async () => {},
      }),
      "device",
    );

    const auth = await reg.authorize({});
    if (auth.mode !== "auto") throw new Error("expected auto mode");

    await expect(auth.callback).rejects.toThrow(/denied/i);
  });
});

describe("oauth (browser auto-capture) method", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => vi.unstubAllGlobals());

  it("captures the redirect on localhost and stores methodID=oauth", async () => {
    const fetchImpl = jsonFetch([{ body: { access_token: "AT", refresh_token: "RT", expires_in: 60 } }]);
    const config = testConfig({ callbackPort: 0, browserTimeoutSeconds: 120 });
    const reg = byId(
      buildRegistrations(config, { preferDevice: false, fetchImpl, now: () => 5_000 }),
      "oauth",
    );

    const auth = await reg.authorize({});
    if (auth.mode !== "auto") throw new Error("expected auto mode");
    expect(auth.expiresAt).toBe(125_000);

    // Play the browser: follow the redirect_uri with a code and the issued state.
    const url = new URL(auth.url);
    const redirect = new URL(url.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("code", "CODE");
    redirect.searchParams.set("state", url.searchParams.get("state")!);
    expect((await realFetch(redirect)).status).toBe(200);

    await expect(auth.callback).resolves.toMatchObject({ methodID: "oauth", access: "AT", refresh: "RT" });
    expect(fetchImpl.calls[0]!.params.get("redirect_uri")).toBe(url.searchParams.get("redirect_uri"));
  });

  it("frees the callback port of an abandoned attempt when a new one starts", async () => {
    const config = testConfig({ callbackPort: 0 });
    const reg = byId(buildRegistrations(config, { preferDevice: false }), "oauth");

    const abandoned = await reg.authorize({});
    if (abandoned.mode !== "auto") throw new Error("expected auto mode");
    const superseded = expect(abandoned.callback).rejects.toThrow(/newer/i);

    // Same port as the abandoned attempt (the first bind fixed it on `config`).
    const retry = await reg.authorize({});
    await superseded;

    if (retry.mode !== "auto") throw new Error("expected auto mode");
    retry.callback.catch(() => {});
    expect(new URL(retry.url).searchParams.get("redirect_uri")).toBe(
      `http://127.0.0.1:${config.callbackPort}/callback`,
    );
  });
});
