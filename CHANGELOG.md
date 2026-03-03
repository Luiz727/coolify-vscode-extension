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
- Docs: add security notes for transport configuration.