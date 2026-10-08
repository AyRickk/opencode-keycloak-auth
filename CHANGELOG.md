# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **OpenCode v2 support** from the same package. The default export is now a
  plain `{ id, setup, server }` object: OpenCode v2 calls `setup(ctx)`, which
  lazily loads the new `src/v2` code; OpenCode v1 keeps calling `server()`, the
  unchanged v1 plugin. Verified end-to-end against Keycloak 26.8 with OpenCode
  2.0.25, 1.18.35 and 1.17.11.
  - Registers integration `<providerId>` with three methods — `oauth` (browser,
    localhost auto-capture), `code` (paste the code) and `device` — each with a
    `refresh` the host calls ~5 min before expiry. The host sends the Bearer.
  - Single-flight refresh per refresh token (the v2 host does not de-duplicate
    concurrent refreshes), so Keycloak refresh-token rotation never triggers a
    spurious `invalid_grant`; `invalid_grant` explains how to reconnect.
  - Declares the OpenAI-compatible provider when `baseUrl` is set (your
    `providers.<id>` entry still wins), or binds an existing one.
  - ERROR mode kept: an incomplete config registers a "⚠ not configured
    (missing: …)" method and logs a `warn`.
- `server.js` at the package root and an `exports["./server"]` entry, which
  OpenCode v2 resolves when the plugin is referenced by folder path or name.
- `scripts/check-bundle.mjs`, run by `npm run build`: the release bundle must be a
  single file with no runtime import besides Node built-ins.

### Changed

- **Breaking (programmatic use only):** the package's default export is now the
  plain `{ id, setup, server }` object instead of the v1 plugin function. OpenCode
  itself is unaffected (v1 calls `server()`, v2 calls `setup()`); code that
  imported the default export and called it should use the named
  `KeycloakAuthPlugin` export instead.
- `refreshLeewaySeconds` / `OPENCODE_KC_REFRESH_LEEWAY` only applies to OpenCode
  v1; it is accepted and ignored on v2 (the host owns the refresh schedule).
- `@opencode-ai/plugin` is now an **optional** peer dependency (OpenCode v2 users
  do not need it). `@opencode/plugin` 2.0.25 is a type-only dev dependency.
- The build no longer splits code into chunks: `dist/index.js` is the whole
  plugin.

### Fixed

- **Device login against a client that enforces PKCE** (S256, the recommended
  setup) failed on Keycloak 26 with `Missing parameter: code_challenge_method`.
  The device grant now sends PKCE (challenge on authorization, verifier on each
  poll); servers that do not require it ignore it. Affects OpenCode v1 too.
- A browser redirect that failed before the code was awaited raised an unhandled
  promise rejection.
- (v2) Retrying a browser login no longer fails with "port already in use" while
  an abandoned attempt still holds the callback port.
- (v1) `opencode auth login` did not open the browser: OpenCode v1 only prints
  `Go to: <url>` and expects the plugin to open it. The v1 entry point now opens
  it (when a local browser is detected). OpenCode v2 opens it itself.
- The "Authentication complete" tab now closes itself when the browser allows
  it — when Keycloak redirects straight back because an SSO session is active.
  After typing a password, browsers forbid scripts from closing the tab, so it
  stays open with a "you can close this tab" message.

## [0.4.2] - 2026-09-28

### Added

- Package is now published to npm on each release (`npm install opencode-keycloak-auth`).

## [0.4.1] - 2026-07-08

### Fixed

- **Token refresh now happens per request, not just at startup.** OpenCode calls
  the auth `loader` only once — when it builds and memoizes the provider's SDK
  client — so returning a static `{ apiKey }` froze the access token for the life
  of the process. After a long idle (e.g. overnight) that token expired and every
  request failed with `Unauthorized` (401) until OpenCode was **restarted** — no
  `auth login` required, because the stored (offline) refresh token was still
  valid. The loader now installs a custom `fetch` that re-resolves and refreshes
  the token on every outgoing request, so freshness no longer depends on how often
  OpenCode invokes the loader. Single-flight refresh, rotation handling, and
  persistence are preserved.

## [0.4.0] - 2026-07-06

### Added

- Structured, leveled logging via `OPENCODE_KC_LOG`
  (`silent`/`error`/`warn`/`info`/`debug`, default `warn`), prefixed with
  `[keycloak-auth]`. Secrets are never logged.
- `ConfigError` that names every missing required setting at once.

### Changed

- A missing/incomplete configuration now logs a loud `warn`
  (`registered in ERROR mode (missing: …)`) instead of failing silently.
- The token loader no longer swallows persistence failures — it warns, since a
  lost rotated token would otherwise strand auth until re-login.
- Login flows (auto-capture, paste-code, device) log the real failure cause
  instead of an opaque `failed`.
- Test suite expanded from 29 to 99 tests, covering `log`, `errors`, `keycloak`,
  `browser`, and `shared` in addition to the existing suites.

## [0.3.0] - 2026-07-03

### Added

- Request the `offline_access` scope by default (`offlineAccess` option /
  `OPENCODE_KC_OFFLINE_ACCESS`) for a durable, offline refresh token that
  survives SSO session timeouts — a single login keeps refreshing for days.

### Changed

- `RefreshFailedError` detects `invalid_grant` and returns an explicit
  "session expired" message pointing at the offline-token fix.

## [0.2.3] - 2026-07-01

### Fixed

- Single-flight token refresh so concurrent requests near expiry redeem the
  rotating refresh token only once (avoids a spurious `invalid_grant`/re-login).
- Register the provider even when the config is incomplete, so it still appears
  in `opencode auth login` and reports the real reason when selected.

## [0.2.1] - 2026-06-25

### Changed

- Update all dev dependencies to latest.

## [0.2.0] - 2026-06-25

### Changed

- Remove AgentGateway-specific references in favor of a generic OpenAI-compatible
  provider.

## [0.1.0] - 2026-06-25

### Added

- Initial release: Keycloak OAuth2/OIDC auth plugin for OpenCode —
  Authorization Code + PKCE (S256) with localhost auto-capture and paste-code
  fallbacks, and a Device Authorization Grant for headless hosts. Automatic
  token refresh, public-client/PKCE-only, zero runtime dependencies.

[Unreleased]: https://github.com/AyRickk/opencode-keycloak-auth/compare/v0.4.2...HEAD
[0.4.2]: https://github.com/AyRickk/opencode-keycloak-auth/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/AyRickk/opencode-keycloak-auth/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/AyRickk/opencode-keycloak-auth/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/AyRickk/opencode-keycloak-auth/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/AyRickk/opencode-keycloak-auth/compare/v0.2.1...v0.2.3
[0.2.1]: https://github.com/AyRickk/opencode-keycloak-auth/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/AyRickk/opencode-keycloak-auth/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AyRickk/opencode-keycloak-auth/releases/tag/v0.1.0
