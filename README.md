# opencode-keycloak-auth

[![CI](https://github.com/AyRickk/opencode-keycloak-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/AyRickk/opencode-keycloak-auth/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

An [OpenCode](https://opencode.ai) **auth plugin** that logs in to **Keycloak**
via OAuth2/OIDC and feeds short-lived, auto-refreshed access tokens to an
**OpenAI-compatible** provider. **One package works on both OpenCode v1 and
OpenCode v2.**

It replaces the pattern of pasting a long-lived static JWT as `apiKey`: OpenCode
now obtains a real access token from Keycloak and refreshes it automatically.
**Nothing changes on the provider side** — the Keycloak access token _is_ the JWT
the provider validates (e.g. JWKS + claim policies).

## Contents

- [Features](#features)
- [Compatibility](#compatibility)
- [Install](#install)
- [Configuration](#configuration)
- [Keycloak client setup](#keycloak-client-setup)
- [`opencode.json`](#opencodejson)
- [Moving from OpenCode v1 to v2](#moving-from-opencode-v1-to-v2)
- [Logging in](#logging-in)
- [Logging & diagnostics](#logging--diagnostics)
- [Troubleshooting](#troubleshooting)
- [How it maps to the OpenCode plugin APIs](#how-it-maps-to-the-opencode-plugin-apis)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## Features

- **Authorization Code + PKCE (S256)** with a localhost callback (auto-capture),
  plus a **paste-the-code** fallback.
- **Device Authorization Grant** fallback for headless / SSH / container hosts —
  auto-selected (offered first) when no local browser is detected.
- **Automatic refresh.** On OpenCode v2 the host refreshes the token (~5 min
  before expiry) through the plugin, which de-duplicates concurrent refreshes so
  Keycloak refresh-token rotation never causes a spurious `invalid_grant`. On
  OpenCode v1 the loader installs a custom `fetch` that refreshes the token on
  **every** request (30s leeway, configurable). Either way, a long idle (e.g.
  overnight) never leaves you with a stale token: no restart, no re-login.
- **Public client, PKCE only** — no client secret is ever read or stored.
- **Zero runtime dependencies** — only Node built-ins (`node:crypto`,
  `node:http`) and the global `fetch`. Builds and installs **offline** (suitable
  for on-prem / air-gapped environments).
- Credential storage is delegated to OpenCode's native mechanism (v2: the
  `credential` table of `opencode.db`; v1: `auth.json`, mode `0600`).

## Compatibility

| OpenCode           | Status       | Entry point used | Config key                           | Login                                        |
| ------------------ | ------------ | ---------------- | ------------------------------------ | -------------------------------------------- |
| **2.x** (≥ 2.0.25) | ✅ supported | `setup(ctx)`     | `"plugins"` (`{ package, options }`) | `/connect` or `opencode auth login keycloak` |
| **1.17 – 1.18.x**  | ✅ supported | `server()`       | `"plugin"` (`[path, options]`)       | `opencode auth login`                        |

The package exports a plain `{ id, setup, server }` object: OpenCode v2 calls
`setup`, which lazily loads the v2 code; OpenCode v1 calls `server`, the
unchanged v1 plugin. Verified end-to-end against a real Keycloak with OpenCode
**2.0.25**, **1.18.35** and **1.17.11**. Older 2.0.x releases were not tested —
the v2 plugin API is young, prefer the latest 2.x.

> v1 credentials are **not** carried over to v2 automatically: log in once with
> `/connect` after upgrading (see
> [Moving from OpenCode v1 to v2](#moving-from-opencode-v1-to-v2)).

## Install

> **How OpenCode loads a plugin.** OpenCode resolves a plugin entry either by
> **package name from the npm registry** (needs network access — it downloads the
> package itself, it does _not_ look in your project's or global `node_modules`)
> **or by a filesystem path**. For an **offline / air-gapped** host you must use a
> **filesystem path** (or the auto-loaded `plugins/` folder) — a bare package name
> will fail because OpenCode cannot reach the registry.

### Option A — prebuilt single file (simplest, v1 and v2)

Every [GitHub Release](https://github.com/AyRickk/opencode-keycloak-auth/releases)
attaches a self-contained bundle `opencode-keycloak-auth.js` (zero runtime
dependencies). Drop it into OpenCode's auto-load directory — the same file works
on OpenCode v1 and v2:

```bash
mkdir -p ~/.config/opencode/plugins
curl -fsSL -o ~/.config/opencode/plugins/opencode-keycloak-auth.js \
  https://github.com/AyRickk/opencode-keycloak-auth/releases/latest/download/opencode-keycloak-auth.js
```

On an air-gapped host, copy the file there by any means. Auto-loaded plugins do
not receive inline options, so configure them with `OPENCODE_KC_*` environment
variables (see [Configuration](#configuration)). On OpenCode v2 the variables
must be set in the environment of the background service (`opencode service
restart` after changing them).

> A project-local `.opencode/plugins/` folder works the same way.

### Option B — tarball, referenced by path (offline, with inline options)

Build (or download from the release) the tarball on a machine with network
access:

```bash
npm ci
npm run build          # -> dist/ (single ESM file + d.ts), verified by scripts/check-bundle.mjs
npm pack               # -> opencode-keycloak-auth-<version>.tgz
```

Install it into a dedicated folder on the target host — no network needed (the
package has no dependencies):

```bash
mkdir -p ~/.opencode-plugins && cd ~/.opencode-plugins
npm init -y
npm install --offline /path/to/opencode-keycloak-auth-<version>.tgz
# -> ~/.opencode-plugins/node_modules/opencode-keycloak-auth
```

Then reference **that folder** (absolute path) in `opencode.json` — see
[`opencode.json`](#opencodejson) for the v1 and v2 syntax.

> **OpenCode v2 needs a folder, not a file.** In `opencode.json` v2 ignores a
> path to a `.js` file (`configured plugin path must be a directory` in the log)
> and loads `<folder>/server.js` (then `<folder>/index.js`) — the package ships
> a `server.js` for that. OpenCode v1 loads the folder through `package.json`.
> Either way the folder must contain the built `dist/`.

### Option C — npm registry (online hosts)

Reference the package by name (`"opencode-keycloak-auth"`) and OpenCode
downloads it on first run. No manual install step.

### Offline note: models.dev

On first run OpenCode fetches `https://models.dev/api.json`. The failure is
**non-fatal** (login still works) but it adds a startup delay and a scary log
line. On air-gapped hosts, silence it:

```bash
export OPENCODE_DISABLE_MODELS_FETCH=1
# or point it at a local copy:
export OPENCODE_MODELS_PATH=/path/to/models.json
```

## Configuration

Everything is configurable via environment variables (prefix `OPENCODE_KC_`)
and/or plugin options in `opencode.json`. **Plugin options take precedence over
environment variables.** The option names are identical on OpenCode v1 and v2.

| Env var                       | Plugin option           | Default      | Description                                                      |
| ----------------------------- | ----------------------- | ------------ | ---------------------------------------------------------------- |
| `OPENCODE_KC_ISSUER`          | `issuer`                | — (required) | Realm issuer URL, e.g. `https://kc.example.com/realms/agents`    |
| `OPENCODE_KC_CLIENT_ID`       | `clientId`              | — (required) | Public client id                                                 |
| `OPENCODE_KC_SCOPES`          | `scopes`                | `openid`     | Space/comma list; `openid` always added                          |
| `OPENCODE_KC_OFFLINE_ACCESS`  | `offlineAccess`         | `true`       | Add `offline_access` for a durable refresh token (see below)     |
| `OPENCODE_KC_PROVIDER_ID`     | `providerId`            | `keycloak`   | Provider id (and, on v2, integration id) to attach to            |
| `OPENCODE_KC_CALLBACK_HOST`   | `callbackHost`          | `127.0.0.1`  | Localhost callback bind host                                     |
| `OPENCODE_KC_CALLBACK_PORT`   | `callbackPort`          | `49170`      | Localhost callback port (`0` = ephemeral)                        |
| `OPENCODE_KC_REDIRECT_PATH`   | `redirectPath`          | `/callback`  | Redirect path                                                    |
| `OPENCODE_KC_BASE_URL`        | `baseUrl`               | —            | v2: declares the provider with this base URL; v1: informational  |
| `OPENCODE_KC_REFRESH_LEEWAY`  | `refreshLeewaySeconds`  | `30`         | v1 only: refresh this many seconds before expiry (ignored on v2) |
| `OPENCODE_KC_BROWSER_TIMEOUT` | `browserTimeoutSeconds` | `300`        | Browser callback wait timeout                                    |
| `OPENCODE_KC_LOG`             | —                       | `warn`       | Log level: `silent`/`error`/`warn`/`info`/`debug` (see below)    |

## Keycloak client setup

Create a client in your realm with:

- **Client type:** OpenID Connect
- **Client authentication:** **OFF** (public client)
- **Standard flow:** **ON** (Authorization Code)
- **OAuth 2.0 Device Authorization Grant:** **ON**
- **PKCE:** Advanced → _Proof Key for Code Exchange Code Challenge Method_ =
  **S256**
- **Valid Redirect URIs:** include the localhost callback, e.g.
  `http://127.0.0.1:49170/callback`
  (add any other ports you configure; for `callbackPort: 0` allow
  `http://127.0.0.1/*`)
- **Web Origins:** not required (no browser-based XHR to Keycloak from the app).

> With PKCE enforced (S256), Keycloak also requires PKCE on the **device** grant.
> The plugin sends it since the release that added OpenCode v2 support; earlier
> versions failed the device login with `Missing parameter: code_challenge_method`.

### Staying logged in (offline tokens)

By default the plugin requests the **`offline_access`** scope so a single
`opencode auth login` keeps working across days. This matters because a _regular_
Keycloak refresh token only lives as long as the **SSO session**, which is capped
by the realm's **SSO Session Idle** (default 30 min) and **SSO Session Max**
(default 10h). Leave OpenCode overnight and the session expires, the refresh
fails with `invalid_grant`, and you are forced to log in again every morning.

> Note: the client's **Access Token Lifespan** does _not_ control this — it only
> sets how long each access token is valid, not the refresh token / session.

An **offline token** is exempt from those caps: it is governed instead by
**Offline Session Idle** (default 30 days, refreshed on each use) and, if
enabled, Offline Session Max. That is the difference between "log in once" and
"log in every morning".

Requirements on the Keycloak side:

- The client must have `offline_access` in its **assigned optional client
  scopes** (the realm default for all clients; `fullScopeAllowed` does not affect
  this — it governs role mappings, not client scopes).
- Optionally raise **Offline Session Idle** if 30 days is too short.

Set `OPENCODE_KC_OFFLINE_ACCESS=false` (or `offlineAccess: false`) only for
realms that do not grant `offline_access`.

### Claims required by the provider

A provider that validates the JWT typically checks claims such as **`aud`** and
**roles**. The access token must carry them, which is configured **on the
Keycloak side**, not in this plugin:

- **`aud`** — add the provider audience via a _Client Scope_ with an
  **Audience** mapper (or an _Audience Resolve_ mapper), and request that scope
  (e.g. `OPENCODE_KC_SCOPES="openid aud-api"`).
- **roles** — assign realm/client roles and ensure the relevant role mapper is
  included in the requested scopes.

Verify a freshly issued token with `jwt` tooling and confirm `aud` / `realm_access.roles`
match what your provider's policies expect.

## `opencode.json`

Declare the OpenAI-compatible provider and enable the plugin. The plugin entry is
**either** the published package name (online) **or** an absolute path to the
installed folder (offline — see [Install](#install)). The plugin's `providerId`
(default `keycloak`) **must match** the provider key.

### OpenCode v2

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      // online: "opencode-keycloak-auth"; offline: absolute path to the installed folder
      "package": "/home/you/.opencode-plugins/node_modules/opencode-keycloak-auth",
      "options": {
        "issuer": "https://kc.example.com/realms/agents",
        "clientId": "opencode-cli",
        "scopes": "openid aud-api",
      },
    },
  ],
  "providers": {
    "keycloak": {
      "name": "Inference gateway",
      "package": "@ai-sdk/openai-compatible", // v2 maps it to @opencode/ai/providers/openai-compatible
      "settings": { "baseURL": "https://api.example.com/v1" },
      "headers": { "X-Client": "opencode" }, // optional, see below
      "models": {
        "qwen2.5-coder-32b": { "name": "Qwen2.5 Coder 32B" },
        "llama-3.3-70b": { "name": "Llama 3.3 70B" },
      },
    },
  },
}
```

- OpenCode v2 itself sends the Keycloak access token as
  `Authorization: Bearer <token>` to the provider bound to the integration —
  the plugin no longer touches requests. A provider whose id equals the
  plugin's `providerId` is bound automatically.
- Alternatively, set the `baseUrl` option (or `OPENCODE_KC_BASE_URL`) and keep
  only `providers.keycloak.models` in `opencode.json`: the plugin then declares
  the provider (`@opencode/ai/providers/openai-compatible`, `settings.baseURL`).
  Anything you put under `providers.keycloak` still wins over the plugin's
  defaults.

### Browser behavior (both versions)

- **The browser opens by itself** when you pick a browser method on a desktop:
  OpenCode v2 opens the URL itself (verified for `opencode auth login` in a
  terminal; the TUI uses the same opener); on v1 the
  plugin does it, since `opencode auth login` only prints `Go to: <url>`. On
  SSH / containers / CI nothing is opened — use the printed URL or the device
  flow.
- **The "Authentication complete" tab closes itself only when the browser
  allows it.** Browsers let a page close a tab only if it has a single history
  entry — the case when Keycloak redirects straight back because you already
  have an SSO session. After typing your password the tab has two entries and
  must be closed by hand. Verified with Chrome; Firefox-based browsers apply the
  same rule; Safari was not tested.

### OpenCode v1

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      // online: "opencode-keycloak-auth"; offline: absolute path to the installed folder
      "/home/you/.opencode-plugins/node_modules/opencode-keycloak-auth",
      {
        "issuer": "https://kc.example.com/realms/agents",
        "clientId": "opencode-cli",
        "providerId": "keycloak",
        "scopes": "openid aud-api",
        "callbackPort": 49170,
      },
    ],
  ],
  "provider": {
    "keycloak": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Keycloak",
      "options": {
        "baseURL": "https://api.example.com/v1",
      },
      "models": {
        "qwen2.5-coder-32b": { "name": "Qwen2.5 Coder 32B" },
        "llama-3.3-70b": { "name": "Llama 3.3 70B" },
      },
    },
  },
}
```

> **Provider npm package (v1).** The `provider.keycloak.npm` package
> (`@ai-sdk/openai-compatible`) is fetched by OpenCode the first time you **call a
> model** (not during login). On an air-gapped host, pre-install it the same way
> as the plugin and OpenCode will reuse it from disk. (OpenCode v2 ships the
> OpenAI-compatible provider built in.)

### Identifying the client in gateway metrics

To tell OpenCode apart from other tools in gateway metrics (e.g. agentgateway
per-client dashboards), add a static header — no plugin code involved:

```jsonc
// OpenCode v2
"providers": { "keycloak": { "headers": { "X-Client": "opencode" } } }
// OpenCode v1
"provider": { "keycloak": { "options": { "headers": { "X-Client": "opencode" } } } }
```

### Environment variables instead of options

```bash
export OPENCODE_KC_ISSUER="https://kc.example.com/realms/agents"
export OPENCODE_KC_CLIENT_ID="opencode-cli"
export OPENCODE_KC_SCOPES="openid aud-api"
export OPENCODE_KC_BASE_URL="https://api.example.com/v1"   # v2: declares the provider
```

## Moving from OpenCode v1 to v2

1. Keep the same package (or bundle) — it serves both versions.
2. Rewrite the config (option names do not change):
   - `"plugin": [[path, opts]]` → `"plugins": [{ "package": path, "options": opts }]`
   - `provider.<id>` (`npm`, `options.baseURL`, `options.headers`) →
     `providers.<id>` (`package`, `settings.baseURL`, `headers`)
3. **Log in again once** with `/connect` (TUI) or `opencode auth login keycloak`.
   OpenCode v2 does not import the v1 `auth.json` on a fresh install (observed on
   2.0.25), and a plugin cannot create an OAuth credential itself.

   _Optional, to skip the browser:_ import the v1 offline token by hand (needs
   `jq`; the token briefly appears in the process list):

   ```bash
   opencode api POST /api/credential -d "$(jq '{integrationID: "keycloak", label: "Keycloak (from v1)",
     activate: true, value: {type: "oauth", methodID: "oauth", access: .keycloak.access,
     refresh: .keycloak.refresh, expires: .keycloak.expires}}' ~/.local/share/opencode/auth.json)"
   ```

4. Running v1 and v2 side by side? Log in **separately** in each. If both use the
   same (imported) refresh token and the realm rotates refresh tokens, whichever
   refreshes first invalidates the other (`invalid_grant`).

## Logging in

**OpenCode v2:** `/connect` in the TUI, or from a shell:

```bash
opencode auth login keycloak                    # pick a method
opencode auth login keycloak --method device    # headless / SSH / devcontainer
```

**OpenCode v1:**

```bash
opencode auth login
# pick the "keycloak" provider, then a Keycloak method
```

Methods (same on both):

- **Browser (PKCE, auto-capture)** — recommended on a workstation (method id `oauth`)
- **Browser (paste the code)** — fallback when the port is busy (method id `code`)
- **Device code (headless / SSH)** — recommended on a server/container (method id `device`)

On headless hosts (SSH / container / no `DISPLAY`) the **Device code** method is
offered first automatically.

## Logging & diagnostics

The plugin logs to the console (which OpenCode captures), prefixed with
`[keycloak-auth]`. Control verbosity with **`OPENCODE_KC_LOG`**:

| Level            | What you see                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `silent`         | nothing                                                                                                     |
| `error`          | login / refresh failures                                                                                    |
| `warn` (default) | the above **plus** misconfiguration (missing issuer/clientId → provider in error mode) and persist failures |
| `info`           | the above plus successful configuration, logins and token refreshes                                         |
| `debug`          | the above plus the per-request refresh decision and every Keycloak call (never token values)                |

Secrets are never logged — access/refresh tokens and authorization codes are
withheld entirely (or redacted to a short suffix). To trace a refresh problem:

```bash
# OpenCode v1
OPENCODE_KC_LOG=debug opencode --print-logs --log-level DEBUG
# OpenCode v2: plugin console output is only visible with a private server
OPENCODE_KC_LOG=debug opencode --standalone --print-logs --log-level debug
```

On OpenCode v2 the background service owns the plugin, so its console output
does not reach `opencode.log`; errors raised by login/refresh **do** appear there
(`~/.local/share/opencode/log/opencode.log`, search for `Keycloak`).

The default `warn` level exists specifically so the most common failure — a
dropped/incomplete config — is no longer silent: you get
`configuration incomplete — provider "…" registered in ERROR mode (missing: issuer, clientId)`
instead of a provider that mysteriously stops working.

## Troubleshooting

### OpenCode v2

- **`opencode plugin list` does not show `opencode-keycloak-auth`.** A path in
  `"plugins"` must be a **folder** (v2 logs `configured plugin path must be a
directory` for a file). Use the installed package folder, or drop the
  single-file bundle into `~/.config/opencode/plugins/`. Check with
  `opencode api GET /api/plugin`.
- **The integration shows `⚠ not configured (missing: …)`.** `issuer` /
  `clientId` did not reach the plugin. Auto-loaded plugins get no options: set
  `OPENCODE_KC_*` in the environment of the background service and run
  `opencode service restart`.
- **`Authentication failed — UnexpectedStatus: 500` when starting a login.**
  OpenCode 2.0.x hides errors raised while _starting_ a login (e.g. Keycloak
  unreachable, wrong issuer, client not allowed the device grant) behind HTTP 500. The real message is in `~/.local/share/opencode/log/opencode.log`.
- **`Keycloak session expired (invalid_grant)` on a request.** The stored refresh
  token is no longer accepted (session revoked or expired). Reconnect with
  `/connect`. Keep `offline_access` so it does not happen every morning.
- **`Callback port 49170 is already in use`.** Another program holds the port;
  set `callbackPort`, or use the paste-the-code or device method. (A previous,
  abandoned attempt of this plugin no longer blocks the port: a new attempt
  replaces it.)
- **Requests are sent without a token.** The provider id must equal the
  plugin's `providerId` (or carry `integrationID`), and the integration must have
  an active connection: `opencode api GET /api/integration/keycloak`.

### OpenCode v1

**`Unknown provider "keycloak"` / the provider is missing from `auth login`.**
This means OpenCode never loaded the plugin, so no auth method is registered for
the provider id. The provider block in `opencode.json` alone is _not_ enough —
the login methods come from the plugin. Run the diagnostic:

```bash
opencode auth login -p keycloak --print-logs --log-level DEBUG
```

- A line `failed to load plugin … error="Missing Keycloak issuer …"` → you did
  not pass `issuer`/`clientId` (plugin options or `OPENCODE_KC_*` env vars).
- **No** plugin line at all, and you referenced the plugin by **package name** on
  an offline host → OpenCode tried to fetch it from the registry. Reference it by
  **filesystem path** instead (see Install).

Since this plugin now registers the provider even when the config is incomplete,
selecting the **`⚠ not configured`** method prints the exact missing value.

**`Unexpected server error` every morning / after being idle, fixed by
re-running `opencode auth login`.** The stored refresh token was rejected with
`invalid_grant` because the Keycloak **SSO session expired** overnight (idle or
max lifespan). This is a realm/session setting, not a plugin bug — note it also
affects OpenCode's native MCP OAuth against the same realm. Fix it durably with
an **offline token**: keep `offline_access` enabled (the default) and make sure
the client is granted that scope. See _Staying logged in (offline tokens)_.

**`Unauthorized` (401) after a long idle, fixed by **restarting** OpenCode — no
`auth login` needed.** Distinct from the case above (that one needs a re-login).
Here the stored refresh token is still valid — restarting refreshes it fine —
but the running process was serving a token frozen at startup. This was a plugin
bug fixed in **v0.4.1**: OpenCode calls the auth `loader` only once (when it
memoizes the SDK client), so a static `apiKey` never got refreshed at runtime and
expired mid-session. The loader now installs a custom `fetch` that refreshes per
request. Upgrade to ≥ 0.4.1 and reload the plugin.

**Auth suddenly fails / the provider "stops working" after it used to be fine.**
Most often the config was dropped (env vars unset, or the plugin options removed
from `opencode.json`), so the plugin loads in **error mode** with no loader. Since
v0.3.0 this is logged at `warn`: look for
`configuration incomplete — provider "…" registered in ERROR mode (missing: …)`.
Restore `OPENCODE_KC_ISSUER`/`OPENCODE_KC_CLIENT_ID` (or the plugin options) and
re-run. Run with `OPENCODE_KC_LOG=debug` to trace the token refresh lifecycle.

**`Failed to fetch models.dev`.** Harmless — see the offline note in Install. Set
`OPENCODE_DISABLE_MODELS_FETCH=1` to silence it.

## How it maps to the OpenCode plugin APIs

**OpenCode v2** (`@opencode/plugin` 2.x, `setup(ctx)`; analysis in
[docs/v2-analysis.md](docs/v2-analysis.md)):

- `ctx.integration.transform` registers integration `<providerId>` with three
  `oauth` methods (`oauth`, `code`, `device`). Each has `authorize` (returns
  `{ url, instructions, expiresAt, mode, callback }`) and `refresh`.
- The credential is a `Credential.OAuth` (`access`, `refresh`, `expires` in ms,
  `methodID`). The host calls `refresh` ~5 min before expiry and persists the
  result; the plugin single-flights concurrent refreshes of the same token.
- `ctx.provider.transform` declares the provider when `baseUrl` is set, or binds
  an already-known one (`integrationID`). The host injects the Bearer itself.
- No loader, no custom `fetch`, no `client.auth.set`.

**OpenCode v1** (`@opencode-ai/plugin` ≥ 1.17, `AuthHook` via `server()`):

- `provider` — the provider id to attach to.
- `methods[]` — three `oauth` methods: browser auto-capture (`method: "auto"`),
  browser paste (`method: "code"`), and device flow (`method: "auto"` whose
  `callback()` polls the token endpoint).
- `loader(auth, provider)` — OpenCode calls this **once**, when it builds and
  memoizes the provider's SDK client (not before every request). Returning a bare
  `{ apiKey }` would freeze that access token for the life of the process, so the
  loader instead returns a **custom `fetch`** that re-resolves and refreshes the
  token on **every** outgoing request (reading stored tokens, refreshing when near
  expiry, and persisting via `client.auth.set(...)`). Freshness is therefore
  independent of how often OpenCode invokes the loader.

## Development

Requires **Node.js >= 20**.

```bash
npm ci
npm run typecheck
npm test          # vitest, fetch/clock fully injected — no network, no real timers
npm run build     # tsup -> dist/ (ESM + d.ts)
npm run lint
npm run format
```

Run the full pre-PR check (mirrors CI) in one line:

```bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for the
development setup, project layout, testing conventions, and the (short) house
rules — chiefly: **no runtime dependencies** and **never log secrets**. Please
also read the [Code of Conduct](CODE_OF_CONDUCT.md).

Changes are tracked in [CHANGELOG.md](CHANGELOG.md).

## Security

This plugin handles OAuth tokens. Please report vulnerabilities privately as
described in [SECURITY.md](SECURITY.md) — not as public issues.

## License

[MIT](LICENSE) © AyRickk
