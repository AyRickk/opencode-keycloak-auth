import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  // No runtime dependencies are bundled: the plugin relies only on Node built-ins
  // (node:crypto, node:http) and the global fetch, so install works fully offline.
  external: ["@opencode-ai/plugin", "@opencode-ai/sdk"],
});
