import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startCallbackServer, type CallbackServer } from "../src/flows/callback-server.js";
import { testConfig } from "./helpers.js";

// These tests bind a real loopback server on an ephemeral port (127.0.0.1:0):
// no external network is involved.
let open: CallbackServer | undefined;
let blocker: Server | undefined;
afterEach(() => {
  open?.close();
  blocker?.close();
  open = undefined;
  blocker = undefined;
});

async function start(state = "expected-state") {
  const config = testConfig({ callbackPort: 0 });
  open = await startCallbackServer(config, state);
  return { config, server: open };
}

describe("startCallbackServer", () => {
  it("reflects the ephemeral port it bound so the redirect_uri matches reality", async () => {
    const { config } = await start();
    expect(config.callbackPort).toBeGreaterThan(0);
  });

  it("resolves with the code when the state matches", async () => {
    const { config, server } = await start("s1");
    const res = await fetch(`http://127.0.0.1:${config.callbackPort}/callback?code=the-code&state=s1`);

    expect(res.status).toBe(200);
    await expect(server.waitForCode(5_000)).resolves.toBe("the-code");
  });

  it("serves a success page that closes the tab by itself when the browser allows it", async () => {
    const { config } = await start("s1");
    const res = await fetch(`http://127.0.0.1:${config.callbackPort}/callback?code=c&state=s1`);
    const html = await res.text();

    // Browsers only let a page close a tab with a single history entry (e.g. SSO
    // already active); otherwise the text tells the user to close it.
    expect(html).toMatch(/<script>[^<]*window\.close\(\)/);
    expect(html).toMatch(/close this tab/i);
  });

  it("rejects on a state mismatch (CSRF guard)", async () => {
    const { config, server } = await start("s1");
    const rejected = expect(server.waitForCode(5_000)).rejects.toThrow(/state mismatch/i);
    const res = await fetch(`http://127.0.0.1:${config.callbackPort}/callback?code=c&state=forged`);

    expect(res.status).toBe(400);
    await rejected;
  });

  it("rejects with Keycloak's error when the redirect carries one", async () => {
    const { config, server } = await start("s1");
    const rejected = expect(server.waitForCode(5_000)).rejects.toThrow(/access_denied/);
    await fetch(`http://127.0.0.1:${config.callbackPort}/callback?error=access_denied&state=s1`);

    await rejected;
  });

  it("keeps a failed redirect for a later waitForCode (no unhandled rejection meanwhile)", async () => {
    const { config, server } = await start("s1");
    await fetch(`http://127.0.0.1:${config.callbackPort}/callback?error=access_denied&state=s1`);
    await new Promise((r) => setImmediate(r)); // let an unhandled rejection surface, if any

    await expect(server.waitForCode(5_000)).rejects.toThrow(/access_denied/);
  });

  it("answers 404 off the redirect path without settling the wait", async () => {
    const { config } = await start("s1");
    const res = await fetch(`http://127.0.0.1:${config.callbackPort}/favicon.ico`);
    expect(res.status).toBe(404);
  });

  it("fails with an actionable message when the port is already taken", async () => {
    blocker = createServer();
    await new Promise<void>((r) => blocker!.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as AddressInfo).port;

    await expect(startCallbackServer(testConfig({ callbackPort: port }), "s")).rejects.toThrow(
      /already in use.*device flow/s,
    );
  });
});
