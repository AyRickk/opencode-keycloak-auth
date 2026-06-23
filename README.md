# opencode-keycloak-auth

An [OpenCode](https://opencode.ai) **auth plugin** that logs in to **Keycloak**
via OAuth2/OIDC and feeds short-lived, auto-refreshed access tokens to an
**OpenAI-compatible AgentGateway** provider.

It replaces the pattern of pasting a long-lived static JWT as `apiKey`: OpenCode
now obtains a real access token from Keycloak and refreshes it automatically.
**Nothing changes on the gateway side** — the Keycloak access token *is* the JWT
AgentGateway validates (JWKS + CEL policies on the claims).

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

This package does not need to be published to a public npm registry.

**Vendored / offline install:**

```bash
# Build the artifact once on a connected machine:
npm install && npm run build
npm pack                      # -> opencode-keycloak-auth-0.1.0.tgz

# On the target (air-gapped) machine, drop the tarball next to your config and:
npm install ./opencode-keycloak-auth-0.1.0.tgz
```

Or reference a local checkout directly in `opencode.json` (see below). OpenCode
can load a plugin by package name, local path, or file URL.

## Configuration

Everything is configurable via environment variables (prefix `OPENCODE_KC_`)
and/or plugin options in `opencode.json`. **Plugin options take precedence over
environment variables.**

| Env var | Plugin option | Default | Description |
| --- | --- | --- | --- |
| `OPENCODE_KC_ISSUER` | `issuer` | — (required) | Realm issuer URL, e.g. `https://kc.example.com/realms/agents` |
| `OPENCODE_KC_CLIENT_ID` | `clientId` | — (required) | Public client id |
| `OPENCODE_KC_SCOPES` | `scopes` | `openid` | Space/comma list; `openid` always added |
| `OPENCODE_KC_PROVIDER_ID` | `providerId` | `agentgateway` | Provider id the auth hook attaches to |
| `OPENCODE_KC_CALLBACK_HOST` | `callbackHost` | `127.0.0.1` | Localhost callback bind host |
| `OPENCODE_KC_CALLBACK_PORT` | `callbackPort` | `49170` | Localhost callback port (`0` = ephemeral) |
| `OPENCODE_KC_REDIRECT_PATH` | `redirectPath` | `/callback` | Redirect path |
| `OPENCODE_KC_BASE_URL` | `baseUrl` | — | AgentGateway base URL (informational) |
| `OPENCODE_KC_REFRESH_LEEWAY` | `refreshLeewaySeconds` | `30` | Refresh this many seconds before expiry |
| `OPENCODE_KC_BROWSER_TIMEOUT` | `browserTimeoutSeconds` | `300` | Browser callback wait timeout |

## Keycloak client setup

Create a client in your realm with:

- **Client type:** OpenID Connect
- **Client authentication:** **OFF** (public client)
- **Standard flow:** **ON** (Authorization Code)
- **OAuth 2.0 Device Authorization Grant:** **ON**
- **PKCE:** Advanced → *Proof Key for Code Exchange Code Challenge Method* =
  **S256**
- **Valid Redirect URIs:** include the localhost callback, e.g.
  `http://127.0.0.1:49170/callback`
  (add any other ports you configure; for `callbackPort: 0` allow
  `http://127.0.0.1/*`)
- **Web Origins:** not required (no browser-based XHR to Keycloak from the app).

### Claims required by AgentGateway (CEL policies)

AgentGateway's CEL policies typically check claims such as **`aud`** and
**roles**. The access token must carry them, which is configured **on the
Keycloak side**, not in this plugin:

- **`aud`** — add the AgentGateway audience via a *Client Scope* with an
  **Audience** mapper (or an *Audience Resolve* mapper), and request that scope
  (e.g. `OPENCODE_KC_SCOPES="openid aud-agentgateway"`).
- **roles** — assign realm/client roles and ensure the relevant role mapper is
  included in the requested scopes.

Verify a freshly issued token with `jwt` tooling and confirm `aud` / `realm_access.roles`
match what your CEL policies expect.

## `opencode.json`

Declare the custom OpenAI-compatible provider (baseURL = AgentGateway) and enable
the plugin:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-keycloak-auth",
      {
        "issuer": "https://kc.example.com/realms/agents",
        "clientId": "opencode-cli",
        "providerId": "agentgateway",
        "scopes": "openid aud-agentgateway",
        "callbackPort": 49170
      }
    ]
  ],
  "provider": {
    "agentgateway": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "AgentGateway (Keycloak)",
      "options": {
        "baseURL": "https://gateway.example.com/v1"
      },
      "models": {
        "qwen2.5-coder-32b": { "name": "Qwen2.5 Coder 32B" },
        "llama-3.3-70b": { "name": "Llama 3.3 70B" }
      }
    }
  }
}
```

> The plugin's `provider` (default `agentgateway`) **must match** the provider key
> under `"provider"`. The plugin's `loader` returns `{ apiKey: <access_token> }`,
> which the OpenAI-compatible provider sends as `Authorization: Bearer <token>`
> to AgentGateway.

You can also configure everything via env vars instead of plugin options:

```bash
export OPENCODE_KC_ISSUER="https://kc.example.com/realms/agents"
export OPENCODE_KC_CLIENT_ID="opencode-cli"
export OPENCODE_KC_SCOPES="openid aud-agentgateway"
```

## Logging in

```bash
opencode auth login
# pick the "agentgateway" provider, then a Keycloak method:
#   - Browser (PKCE, auto-capture)   ← recommended on a workstation
#   - Browser (paste the code)       ← fallback when the port is busy
#   - Device code (headless / SSH)   ← recommended on a server/container
```

On headless hosts (SSH / container / no `DISPLAY`) the **Device code** method is
offered first automatically.

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
