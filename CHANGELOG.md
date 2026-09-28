# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/AyRickk/opencode-keycloak-auth/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/AyRickk/opencode-keycloak-auth/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/AyRickk/opencode-keycloak-auth/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/AyRickk/opencode-keycloak-auth/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/AyRickk/opencode-keycloak-auth/compare/v0.2.1...v0.2.3
[0.2.1]: https://github.com/AyRickk/opencode-keycloak-auth/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/AyRickk/opencode-keycloak-auth/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AyRickk/opencode-keycloak-auth/releases/tag/v0.1.0
