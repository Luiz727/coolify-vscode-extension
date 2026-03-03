# Copilot Instructions — Coolify VS Code Extension

Responda sempre em Portugues BR

## Big picture architecture
- Entry point is `src/extension.ts`: it wires commands, status bar context switching, webview provider, chat participant, and language model tools.
- UI/state lives in `src/providers/CoolifyWebViewProvider.ts`; API calls should generally flow through this provider for sidebar features.
- Coolify API access is encapsulated by `src/services/CoolifyService.ts` using `src/services/HttpClient.ts` (typed error mapping + timeout + abort handling).
- Configuration is context-based (`default`, `prod`, etc.) in `src/managers/ConfigurationManager.ts`.
  - Server URL is stored in `globalState` per context.
  - Token is stored in `SecretStorage` per context key (`coolifyToken:<context>`).
- Chat integrations:
  - Participant flow: `src/chat/CoolifyChatParticipant.ts` (`@coolify`).
  - Configure Tools flow: `src/tools/CoolifyTools.ts` + `contributes.languageModelTools` in `package.json`.

## Critical workflows (local dev)
- Typecheck: `pnpm run check-types`
- Lint: `pnpm run lint`
- Build production bundle: `pnpm run package`
- Create VSIX: `pnpm dlx @vscode/vsce package`
- Reinstall local VSIX: `code --install-extension <path-to-vsix> --force`
- Tests:
  - `pnpm run test:coverage` uses `compile-tests` + `mocha` + c8 thresholds.
  - `pnpm run test` runs extension tests via `vscode-test` (requires extension host environment).

## Project-specific implementation patterns
- Security defaults are intentional:
  - HTTPS required unless `coolify.allowInsecureHttp` is explicitly enabled.
  - Keep warning behavior when allowing HTTP.
- Error handling pattern:
  - Prefer throwing/propagating `CoolifyApiError` categories (`auth`, `forbidden`, `timeout`, `server`, etc.).
  - Show user-facing `vscode.window.showErrorMessage` at command/provider boundaries.
- Logging pattern:
  - Use `logger` from `src/services/LoggerService.ts` (supports level filtering + token redaction).
- Webview pattern:
  - Message-driven communication with typed message names (`refresh`, `deploy`, `start-app`, etc.).
  - Keep CSP/nonce-safe template behavior in `src/templates/webview.html`.

## When adding a new Coolify operation
- Add API method in `src/services/CoolifyService.ts` (do not call `fetch` directly from commands/provider).
- If sidebar feature:
  - Add provider method in `src/providers/CoolifyWebViewProvider.ts`.
  - Add command in `src/extension.ts` and command contribution/activation in `package.json`.
  - Add webview message type and handler if triggered from UI.
- If chat feature:
  - `@coolify`: update intent routing in `src/chat/CoolifyChatParticipant.ts`.
  - Configure Tools: add runtime registration in `src/tools/CoolifyTools.ts` and metadata in `contributes.languageModelTools`.
- Validate with `check-types` and `lint` before packaging.

## Integration points to keep in sync
- `package.json` must match runtime registrations for:
  - commands
  - activation events
  - chat participants
  - language model tools
- `src/test/extension.test.ts` validates command registration and core configuration defaults; update tests if command surface changes.
