// Post-build guard for the self-contained artifact (dist/index.js, shipped as
// opencode-keycloak-auth.js): one file, no runtime import outside Node built-ins, and a
// default export that both OpenCode v1 (server) and v2 (id + setup) accept.
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { pathToFileURL } from "node:url";

const fail = (msg) => {
  console.error(`check-bundle: ${msg}`);
  process.exit(1);
};

const js = readdirSync("dist").filter((f) => f.endsWith(".js"));
if (js.join() !== "index.js") fail(`expected a single dist/index.js, found: ${js.join(", ")}`);

const source = readFileSync("dist/index.js", "utf8");
const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1]);
const foreign = specifiers.filter((s) => !s.startsWith("node:") && !builtinModules.includes(s));
if (foreign.length) fail(`runtime imports outside Node built-ins — ${[...new Set(foreign)].join(", ")}`);

const plugin = (await import(pathToFileURL("dist/index.js").href)).default;
if (plugin?.id !== "opencode-keycloak-auth") fail(`default.id is ${JSON.stringify(plugin?.id)}`);
if (typeof plugin.setup !== "function") fail("default.setup is not a function");
if (typeof plugin.server !== "function") fail("default.server is not a function");

console.log(
  `check-bundle: OK (${(source.length / 1024).toFixed(1)} KiB, imports: ${[...new Set(specifiers)].join(", ")})`,
);
