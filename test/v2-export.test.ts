import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

afterEach(() => {
  vi.doUnmock("../src/v2/index.js");
  vi.resetModules();
});

describe("dual v1/v2 default export", () => {
  it("is a plain { id, setup, server } object (what v2 validates; v1 calls server())", async () => {
    const plugin = (await import("../src/index.js")).default;

    expect(plugin.id).toBe("opencode-keycloak-auth");
    expect(typeof plugin.setup).toBe("function");
    expect(typeof plugin.server).toBe("function");
  });

  it("server() is the unchanged v1 plugin", async () => {
    const plugin = (await import("../src/index.js")).default;

    const hooks = await plugin.server({ client: {} } as never, {
      issuer: "https://kc.example.com/realms/agents",
      clientId: "opencode-cli",
    });

    expect(hooks.auth?.provider).toBe("keycloak");
    expect(hooks.auth?.loader).toBeTypeOf("function");
    expect(hooks.auth?.methods).toHaveLength(3);
  });

  it("loads the v2 code only when setup() is called", async () => {
    let evaluated = 0;
    const setupV2 = vi.fn(async () => undefined);
    vi.doMock("../src/v2/index.js", () => {
      evaluated += 1;
      return { setupV2 };
    });

    const plugin = (await import("../src/index.js")).default;
    expect(evaluated).toBe(0);

    const ctx = { options: { issuer: "x" } } as never;
    await plugin.setup(ctx);

    expect(evaluated).toBe(1);
    expect(setupV2).toHaveBeenCalledWith(ctx);
  });
});

describe("zero runtime dependency guard", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
    });

  it("imports OpenCode packages with `import type` / `export type` only", () => {
    const offenders = files("src").flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => /from\s+["']@opencode(-ai)?\//.test(line))
        .filter((line) => !/^\s*(import|export)\s+type\s/.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );

    expect(offenders).toEqual([]);
  });

  it("declares no runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies?: object };
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
