# Change Log

All notable changes to the "vscode-coolify" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- UX: commands are now discoverable in Command Palette even before opening the sidebar.
- UX: added explicit `onCommand` activation events for all Coolify commands.
- Security: enforce HTTPS by default during server configuration.
- Security: add `coolify.allowInsecureHttp` setting (disabled by default) for explicit HTTP opt-in.
- Security: harden Webview with CSP + nonce and safer DOM rendering.
- Reliability: introduce typed HTTP client with timeout and API error classification.
- Reliability: improve user-facing error handling for auth/network/server failures.
- Reliability: apply selective retry strategy (retry only transient timeout/network/5xx errors).
- Tests: add unit tests for URL validation/normalization and HTTP client error classification.
- Feature: add command palette actions to list deployments and open deployment details.
- Feature: add command palette action to cancel deployments with confirmation.
- Feature: add command palette action to open deployment logs.
- Feature: add command palette actions to start, stop, and restart applications.
- Feature: add language selection (`en` / `pt-BR`) with translated webview and welcome screen.
- Observability: add `Coolify Extension` output channel with structured logs and secret redaction.
- Observability: add `coolify.logLevel` setting and `Coolify: Show Logs` command.
- Feature: add multi-context management (`create`, `switch`, `delete`) with active context aware configuration.
- Feature: add context selector directly in sidebar (webview) for quick context switching.
- Feature: add application environment variables CRUD commands (list/create/update/delete).
- Feature: add sidebar actions for env vars per application (`Envs` and `Add Env`).
- UX: add inline env vars panel in sidebar with direct per-variable edit/delete actions.
- UX: add deployments filters in sidebar (status + application name) with persisted state.
- UX: add status bar indicator for active context with quick context switching.
- UX: add `Open` action in sidebar cards to open application/deployment URLs in browser when available.
- Feature: add `.env` sync flow with diff preview (add/update/full-sync) and conflict resolution strategy by key (`.env` vs remote).
- Feature: add setting `coolify.envSyncConflictStrategy` to persist default conflict strategy for `.env` sync.
- UX: add command `Coolify: Set Env Sync Conflict Strategy` for quick strategy changes from Command Palette.
- UX: add sidebar selector for env sync conflict strategy, synchronized with global setting.
- CI: add GitHub Actions workflow running typecheck, lint, compile-tests and test on push/PR.
- Tests: add mocked integration coverage for `CoolifyService` endpoints used by deployments/lifecycle/env vars.
- CI: add coverage gate (`test:coverage`) with initial baseline thresholds for lines/functions/branches/statements.
- Tests: replace sample extension test with real contribution/command registration assertions.
- Architecture: replace `any[]` API mapping paths in webview provider with explicit typed models from `CoolifyService`.
- Architecture: add typed list-item mappers and safer deployment date sorting to reduce shape/date assumptions in provider reads.
- Docs: add security notes for transport configuration.