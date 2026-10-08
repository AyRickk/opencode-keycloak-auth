import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  // One self-contained file: the release ships dist/index.js alone as
  // opencode-keycloak-auth.js. Without splitting, esbuild inlines the lazy
  // `import("./v2/index.js")` as a deferred module initializer, so the v2 code
  // is still only evaluated when OpenCode v2 calls setup().
  splitting: false,
  // No runtime dependencies are bundled: the plugin relies only on Node built-ins
  // (node:crypto, node:http) and the global fetch, so install works fully offline.
  external: ["@opencode-ai/plugin", "@opencode-ai/sdk", "@opencode/plugin"],
});
