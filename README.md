# opencode-keycloak-auth

[![CI](https://github.com/AyRickk/opencode-keycloak-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/AyRickk/opencode-keycloak-auth/actions/workflows/ci.yml)

An [OpenCode](https://opencode.ai) **auth plugin** that logs in to **Keycloak**
via OAuth2/OIDC and feeds short-lived, auto-refreshed access tokens to an
**OpenAI-compatible** provider.

It replaces the pattern of pasting a long-lived static JWT as `apiKey`: OpenCode
now obtains a real access token from Keycloak and refreshes it automatically.
**Nothing changes on the provider side** — the Keycloak access token _is_ the JWT
the provider validates (e.g. JWKS + claim policies).

## Features

- **Authorization Code + PKCE (S256)** with a localhost callback (auto-capture),
  plus a **paste-the-code** fallback.
- **Device Authorization Grant** fallback for headless / SSH / container hosts —
  auto-selected (offered first) when no local browser is detected.
- **Automatic refresh**: the access token is refreshed when it expires within
  30s (configurable) and the rotated tokens are persisted by OpenCode.
- **Public client, PKCE only** — no client secret is ever read or stored.
- **Zero runtime dependencies** — only Node built-ins (`node:crypto`,
  `node:http`) and the global `fetch`. Builds and installs **offline** (suitable
  for on-prem / air-gapped environments).
- Credential storage is delegated to OpenCode's native mechanism
  (`auth.json`, mode `0600`).

## Install

> **How OpenCode loads a plugin.** OpenCode resolves a plugin entry either by
> **package name from the npm registry** (needs network access — it downloads the
> package itself, it does _not_ look in your project's or global `node_modules`)
> **or by a filesystem path** to a folder that contains a `package.json` and a
> built `dist/`. For an **offline / air-gapped** host you must use the
> **filesystem-path** form — a bare package name will fail with
> `Unknown provider "<id>"` because OpenCode cannot reach the registry.

### 1. Build the artifact (on a machine with network access)

```bash
npm ci
npm run build          # -> dist/ (ESM + d.ts)
npm pack               # -> opencode-keycloak-auth-<version>.tgz
```

### 2. Install it where OpenCode can load it

Pick **one** of the following — all are plain `npm` commands.

**a) From the npm registry (online hosts):** if you publish the package, just
reference it by name in `opencode.json` (`"plugin": ["opencode-keycloak-auth"]`)
and OpenCode downloads it on first run. No manual install step.

**b) Vendored tarball (offline / air-gapped):** install the tarball into a
dedicated folder, then reference the **extracted folder by path**:

```bash
mkdir -p ~/.opencode-plugins && cd ~/.opencode-plugins
npm init -y
npm install /path/to/opencode-keycloak-auth-<version>.tgz
# -> ~/.opencode-plugins/node_modules/opencode-keycloak-auth   (contains dist/)
```

Then in `opencode.json` point the plugin at that folder (see below):

```jsonc
"plugin": [["/home/you/.opencode-plugins/node_modules/opencode-keycloak-auth", { /* options */ }]]
```

**c) Local checkout:** after `npm run build`, reference the checkout directory
directly (`"plugin": [["/abs/path/to/opencode-keycloak-auth", { /* options */ }]]`).

> ⚠️ The referenced folder must contain a built `dist/` — OpenCode loads
> `dist/index.js` via the package's `main`. If you skipped `npm run build`, the
> plugin will fail to load.

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
environment variables.**

| Env var                       | Plugin option           | Default      | Description                                                   |
| ----------------------------- | ----------------------- | ------------ | ------------------------------------------------------------- |
| `OPENCODE_KC_ISSUER`          | `issuer`                | — (required) | Realm issuer URL, e.g. `https://kc.example.com/realms/agents` |
| `OPENCODE_KC_CLIENT_ID`       | `clientId`              | — (required) | Public client id                                              |
| `OPENCODE_KC_SCOPES`          | `scopes`                | `openid`     | Space/comma list; `openid` always added                       |
| `OPENCODE_KC_PROVIDER_ID`     | `providerId`            | `keycloak`   | Provider id the auth hook attaches to                         |
| `OPENCODE_KC_CALLBACK_HOST`   | `callbackHost`          | `127.0.0.1`  | Localhost callback bind host                                  |
| `OPENCODE_KC_CALLBACK_PORT`   | `callbackPort`          | `49170`      | Localhost callback port (`0` = ephemeral)                     |
| `OPENCODE_KC_REDIRECT_PATH`   | `redirectPath`          | `/callback`  | Redirect path                                                 |
| `OPENCODE_KC_BASE_URL`        | `baseUrl`               | —            | Provider base URL (informational)                             |
| `OPENCODE_KC_REFRESH_LEEWAY`  | `refreshLeewaySeconds`  | `30`         | Refresh this many seconds before expiry                       |
| `OPENCODE_KC_BROWSER_TIMEOUT` | `browserTimeoutSeconds` | `300`        | Browser callback wait timeout                                 |

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

Declare the custom OpenAI-compatible provider and enable the plugin. The first
element of each `plugin` entry is **either** the published package name (online)
**or** a filesystem path to the built folder (offline — see Install):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      // online: "opencode-keycloak-auth"
      // offline: an absolute path to the built folder
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

> **Provider npm package.** The `provider.keycloak.npm` package
> (`@ai-sdk/openai-compatible`) is fetched by OpenCode the first time you **call a
> model** (not during login). On an air-gapped host, pre-install it the same way
> as the plugin and OpenCode will reuse it from disk.

> The plugin's `provider` (default `keycloak`) **must match** the provider key
> under `"provider"`. The plugin's `loader` returns `{ apiKey: <access_token> }`,
> which the OpenAI-compatible provider sends as `Authorization: Bearer <token>`
> to your API.

You can also configure everything via env vars instead of plugin options:

```bash
export OPENCODE_KC_ISSUER="https://kc.example.com/realms/agents"
export OPENCODE_KC_CLIENT_ID="opencode-cli"
export OPENCODE_KC_SCOPES="openid aud-api"
```

## Logging in

```bash
opencode auth login
# pick the "keycloak" provider, then a Keycloak method:
#   - Browser (PKCE, auto-capture)   ← recommended on a workstation
#   - Browser (paste the code)       ← fallback when the port is busy
#   - Device code (headless / SSH)   ← recommended on a server/container
```

On headless hosts (SSH / container / no `DISPLAY`) the **Device code** method is
offered first automatically.

## Troubleshooting

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

**`Failed to fetch models.dev`.** Harmless — see the offline note in Install. Set
`OPENCODE_DISABLE_MODELS_FETCH=1` to silence it.

## How it maps to the OpenCode auth API

This plugin targets `@opencode-ai/plugin` ≥ 1.17 (`AuthHook`):

- `provider` — the provider id to attach to.
- `methods[]` — three `oauth` methods: browser auto-capture (`method: "auto"`),
  browser paste (`method: "code"`), and device flow (`method: "auto"` whose
  `callback()` polls the token endpoint).
- `loader(auth, provider)` — reads stored tokens, refreshes when near expiry,
  persists via `client.auth.set(...)`, and returns `{ apiKey }`.

## Development

```bash
npm install
npm run typecheck
npm test          # vitest, fetch fully mocked
npm run build     # tsup -> dist/ (ESM + d.ts)
npm run lint
npm run format
```

## License

MIT
