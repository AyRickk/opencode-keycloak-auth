import { afterEach, describe, expect, it, vi } from "vitest";

// OpenCode v1's `opencode auth login` only prints "Go to: <url>" for plugin
// OAuth methods; v1 built-in plugins open the browser themselves. Check that the
// v1 entry point now does the same on a desktop, and never on a headless host.
const opened: string[] = [];
vi.mock("../src/browser.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/browser.js")>()),
  openBrowser: (url: string) => void opened.push(url),
}));

const { KeycloakAuthPlugin } = await import("../src/index.js");
const options = { issuer: "https://kc.example.com/realms/agents", clientId: "opencode-cli", callbackPort: 0 };

async function method(label: RegExp) {
  const { auth } = await KeycloakAuthPlugin({ client: {} } as never, options);
  const found = auth?.methods.find((m) => label.test(m.label));
  if (found?.type !== "oauth") throw new Error(`no oauth method ${label}`);
  return found;
}

afterEach(() => {
  opened.length = 0;
});

/** A graphical session on any platform, whatever the environment the tests run in (CI sets CI=true). */
function desktop() {
  for (const v of ["CI", "SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT", "KUBERNETES_SERVICE_HOST", "CONTAINER"])
    vi.stubEnv(v, "");
  vi.stubEnv("DISPLAY", ":0");
}

describe("v1 entry point opens the browser itself", () => {
  it("opens the authorize URL when the browser auto-capture method is picked on a desktop", async () => {
    desktop();
    const result = await (await method(/auto-capture/)).authorize();

    expect(opened).toEqual([result.url]);
    if (result.method === "auto") {
      // Let the login fail fast so the callback server is released.
      const redirect = new URL(new URL(result.url).searchParams.get("redirect_uri")!);
      redirect.searchParams.set("error", "access_denied");
      await fetch(redirect);
      await result.callback();
    }
  });

  it("opens the authorize URL for the paste-the-code method", async () => {
    desktop();
    const result = await (await method(/paste the code/)).authorize();

    expect(opened).toEqual([result.url]);
  });

  it("does not try to open a browser on a headless host (SSH, CI, container)", async () => {
    vi.stubEnv("SSH_CONNECTION", "10.0.0.1 22 10.0.0.2 22");
    await (await method(/paste the code/)).authorize();

    expect(opened).toEqual([]);
  });
});
