// OpenCode v2 resolves a plugin folder referenced by path in opencode.json as
// `<folder>/server` (then `<folder>/index`), not via package.json "main". This
// shim makes an extracted package folder loadable by path, offline.
export { default } from "./dist/index.js";
