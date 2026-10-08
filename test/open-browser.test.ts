import { describe, expect, it, vi } from "vitest";
import { openBrowser } from "../src/browser.js";

const URL_WITH_QUERY = "https://kc.example.com/auth?a=1&b=2";

function fakeSpawn() {
  const unref = vi.fn();
  const on = vi.fn();
  const spawn = vi.fn(() => ({ unref, on }));
  return { spawn, unref, on };
}

describe("openBrowser", () => {
  it.each([
    ["darwin", "open", [URL_WITH_QUERY]],
    ["linux", "xdg-open", [URL_WITH_QUERY]],
    ["win32", "rundll32", ["url.dll,FileProtocolHandler", URL_WITH_QUERY]],
  ] as const)("on %s runs %s with the URL as one argument (no shell)", (platform, command, args) => {
    const { spawn, unref } = fakeSpawn();

    openBrowser(URL_WITH_QUERY, { platform, spawn: spawn as never });

    expect(spawn).toHaveBeenCalledWith(
      command,
      args,
      expect.objectContaining({ stdio: "ignore", detached: true }),
    );
    expect(unref).toHaveBeenCalled();
  });

  it("never throws when no opener is available — the URL is still printed by OpenCode", () => {
    const spawn = vi.fn(() => {
      throw new Error("spawn ENOENT");
    });

    expect(() => openBrowser(URL_WITH_QUERY, { platform: "linux", spawn: spawn as never })).not.toThrow();
  });

  it("swallows an asynchronous spawn error", () => {
    const { spawn, on } = fakeSpawn();

    openBrowser(URL_WITH_QUERY, { platform: "linux", spawn: spawn as never });

    const onError = on.mock.calls.find((c) => c[0] === "error")?.[1] as (e: Error) => void;
    expect(() => onError(new Error("ENOENT"))).not.toThrow();
  });
});
