# OpenCode v2 port — independent analysis (phase 0)

Target: **OpenCode 2.0.25** (`@opencode/cli` / `@opencode/plugin` 2.0.25, latest stable on
2026-10-08). Everything below was established from three primary sources, in this order of trust:

1. **Empirical runs** of the real `@opencode/cli@2.0.25` binary (darwin-arm64) in an isolated
   `HOME`/`XDG_*` sandbox, with throw-away spike plugins and a fake OpenAI-compatible server that
   logs the `Authorization` header (`opencode service start`, `opencode api …`, `opencode run …`).
2. **Published types** of `@opencode/plugin@2.0.25` (`node_modules/@opencode/plugin/dist/…`) and
   its schemas (`node_modules/@opencode/schema/dist/…`).
3. **Host source**: the JS bundle embedded in the compiled CLI binary (Bun). Minified, so it is
   cited by its tracing span / identifier names (e.g. `Integration.connection.resolve`), which are
   stable and greppable (`strings opencode | grep …`).

Third-party ports (Berget, Firecrawl, …) were deliberately **not** used as evidence.

## 1. Confirmed

| Claim from the brief                                                            | Evidence                                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package is `@opencode/plugin`; entry `Plugin.define({ id, setup })` is identity | `plugin/dist/promise/plugin.d.ts:55-59`, `plugin.js` (`return plugin`)                                                                                                                                  |
| A plain default-exported `{ id, setup }` object is enough                       | Host validates `default` against `Struct({id, setup: function}) \| Struct({id, effect})` (`PluginModule.load`); extra keys (e.g. `server`) are ignored — spike loaded `{id, setup, server}` as `active` |
| Config key `"plugins"`, entries `string \| { package, options }`                | `Config.Plugin.Entry({ package, options? })` in the host config schema; `opencode.json` spike                                                                                                           |
| Options in `ctx.options`, storage in `ctx.storage`                              | `plugin.d.ts:28`, `promise/storage.d.ts`; spike logged the exact `options` object from `opencode.json`                                                                                                  |
| Local plugins auto-discovered under `plugins/`                                  | Spike: `~/.config/opencode/plugins/<dir>/index.js` **and** a lone `plugins/lone.js` both loaded (`source.type: "local"`)                                                                                |
| `auth` hook / `loader` / custom `fetch` are gone                                | Not present in `promise/*.d.ts`                                                                                                                                                                         |
| OAuth methods are `{ authorize, refresh }` registrations on an integration      | `promise/integration.d.ts:39-56` (`IntegrationOAuthMethodRegistration`)                                                                                                                                 |
| The host refreshes ~5 min before expiry and persists the result                 | `Integration.connection.resolve`: `if (expires > now + 5min) return value; next = refresh(value); credentials.update(id, {value: next})`                                                                |
| Credentials live in `credential` table of `opencode.db`                         | `sqlite3 opencode.db .tables`; `POST /api/credential` round-trip                                                                                                                                        |
| Providers via `ctx.provider.transform(editor => editor.add / update)`           | `promise/provider.d.ts:11-31`                                                                                                                                                                           |
| `integrationID` field on the provider                                           | `schema/dist/provider.js:51` (`Provider.Info.integrationID`, optional)                                                                                                                                  |
| `@ai-sdk/openai-compatible` maps to `@opencode/ai/providers/openai-compatible`  | Host package alias table; `/api/provider` shows the mapped package; `settings.baseURL` is the v2 location                                                                                               |
| Legacy import maps a non-builtin OAuth id to method id `"oauth"`                | Migration `20260805200742_import_legacy_credentials`: `methodID = id === "openai" ? "chatgpt-browser" : [copilot,opencode,xai] ? "device" : "oauth"`                                                    |
| Built-in migration does **not** run on a fresh v2 DB                            | Still true on **2.0.25**: fresh sandbox with a `keycloak` entry in `auth.json` → migration recorded as applied, `credential` table empty                                                                |
| No generic OIDC in core; the plugin stays necessary                             | Built-in auth method types are only `oauth` (plugin-implemented), `key`, `env`, `command`, `external`                                                                                                   |
| v1 (`server()`) + v2 (`id`/`setup`) dual export works                           | Spike under OpenCode **1.17.11** called `server()` exactly once; v2 loaded `setup`                                                                                                                      |

## 2. Contradicted or nuanced

1. **Bearer injection is automatic — no `http.request` hook needed (resolves the ⚠️ critical
   point).** `ModelResolver.resolveModel` does
   `connection.active(provider.integrationID ?? providerID)` → `connection.resolve()` → for an
   `oauth` credential, `{ apiKey: credential.access }` for `openai-compatible` (`authToken` for
   anthropic, `accessToken` for vertex). Verified end-to-end: fake server received
   `Authorization: Bearer <refreshed token>` after the host refreshed an expired credential.
   The fallback `session.hook("http.request")` is therefore **not** implemented.
2. **The link provider → integration is implicit when ids are equal** (`?? providerID` above).
   `integrationID` is only needed when the ids differ. We still set it when we add the provider.
3. **`Credential.OAuth` has a required `methodID`** (`schema/dist/credential.js:23-30`) and the host
   finds `refresh` **through that `methodID`** (`implementations.get(credential.methodID)`). So
   every login method must carry `refresh`, and every credential must carry the id of the method
   that produced it. `expires` is a non-negative **integer in ms** (`NonNegativeInt`).
4. **The host does not de-duplicate concurrent refreshes.** Spike: two parallel model calls
   (title + primary) on an expired credential invoked `refresh` twice within 1 ms with the same
   refresh token. With Keycloak "Revoke Refresh Token" (rotation), the second would get
   `invalid_grant`. → the plugin keeps a **single-flight** keyed on the refresh token.
5. **`provider.transform` cannot see providers declared in `opencode.json`.** In the editor,
   `get("<config provider>")` is `undefined` (only models.dev + plugin layers are visible); config
   is overlaid **after** plugins. Consequence, verified: `editor.add({ info: {id, integrationID,
settings: {baseURL}}, models: [] })` on an id that is also in `opencode.json` is **non-destructive**
   — the final provider keeps the user's `name`, `headers`, `settings` and `models`, plus our
   `integrationID`. So "update without overwrite" is achieved by `add` + config overlay, not by
   `update`.
6. **Declaring a brand-new integration**: there is no `add`; `editor.update(id, fn)` and
   `editor.method.update({ integrationID, … })` **create** the integration when missing (host
   `integration` editor). Verified: `/api/integration/<id>` lists our methods. When a config
   provider exists, the host pre-creates an integration with a `key` method; registering our
   OAuth methods replaces it.
7. **Plugin referenced by path in `opencode.json` must be a directory** (host warning
   `configured plugin path must be a directory`; a file path is ignored). For a directory the host
   resolves `<dir>/server(.js)` then `<dir>/index(.js)` (`Bun.resolveSync`, `PluginModule.load` →
   `resolve`), **not** `package.json#main`. A package installed by name resolves
   `<name>/server` then `<name>`. → the package now ships a root `server.js` shim and an
   `exports["./server"]` entry, so an extracted tarball folder works offline.
8. **Single-file bundle**: works when dropped in an auto-discovered `plugins/` folder (v1 and v2),
   but **not** when referenced by file path from `opencode.json` in v2 (see 7).
9. **v1 compatibility is wider than "≥ 1.18.29"**: 1.17.11 already honours `default.server()`.
10. **Plugin `console` output is not in `opencode.log`** in v2 (the background service owns the
    process). The `[keycloak-auth]` logger is kept (zero-dep, never logs secrets) but v2 users see
    it only with `--standalone --print-logs`.
11. **`authorize` errors surface verbatim.** A rejected `callback`/`authorize` becomes attempt
    status `failed` with the error message, which the CLI prints. So v2 flows **throw** descriptive
    errors instead of returning `{ type: "failed" }`.

## 3. Uncertain points and how they were settled

| Question                                | Decision                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authorize` signature                   | `(answer) => Promise<{ url, instructions, expiresAt?, mode: "auto", callback: Promise<Credential.OAuth> } \| { …, mode: "code", callback: (code) => Promise<Credential.OAuth> }>` (`integration.d.ts:39-53`). Note `auto.callback` is a **Promise**, not a function. Attempt expiry = `expiresAt ?? now + 10 min`.                                        |
| Paste-code fallback                     | Supported as its own method (`mode: "code"`, CLI prompts "Paste the authorization code").                                                                                                                                                                                                                                                                 |
| Device flow                             | A `mode: "auto"` method: `url` = `verification_uri_complete`, `instructions` carry the user code, `expiresAt` = device-code expiry, `callback` = polling promise. CLI prints instructions + URL, opens a browser only on a TTY.                                                                                                                           |
| Method order / device-first on headless | Host keeps registration order (CLI only pushes `key` methods last) → device registered first when no local browser.                                                                                                                                                                                                                                       |
| Error mode                              | Register the integration with one `⚠ not configured` method whose `authorize` throws the actionable message.                                                                                                                                                                                                                                              |
| v1 `auth.json` import from the plugin   | **Not implemented.** The plugin API exposes no way to create an OAuth credential (`ctx.integration` only has `connect.key/external`, `oauth.connect` flows). The only route would be a fake, user-visible login method — not clean. Documented instead: re-run `opencode auth login keycloak` (or a one-shot `opencode api POST /api/credential` recipe). |
| `refreshLeewaySeconds`                  | Host-owned (5 min). Option accepted and ignored in v2, documented.                                                                                                                                                                                                                                                                                        |
| Minimum OpenCode v2                     | Only **2.0.25** was exercised. The API used (`integration.transform`, `method.update` with `refresh`, `provider.transform().add`, `ctx.options`) is the documented 2.0 surface, but 2.0.x changes fast; the README states "tested with 2.0.25".                                                                                                           |

## 4. The experimental `wellknown` endpoint

`POST /api/experimental/integration/wellknown` feeds the built-in `opencode.wellknown` plugin: it
fetches a manifest from the given origin, persists the source (`kv` key `wellknown:sources`) and
registers an integration whose only method is a **`command`** ("Log in") that runs
`manifest.auth.command` and stores its stdout as a **key** credential. There is no refresh and no
OAuth — it does not replace this plugin.

## 5. Out of scope, noted

- Client identification header for agentgateway metrics: no code needed in v2 —
  `providers.<id>.headers: { "X-Client": "opencode" }` is sent on every request (verified with the
  fake server).
