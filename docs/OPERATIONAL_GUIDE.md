# Coolify Extension — Operational Guide

## 1. Functional Support Matrix

### Legend
- ✅ Supported
- ⚠️ Partial / conditional
- ❌ Not supported

| Area | Capability | Status | Where to use |
|---|---|---:|---|
| Configuration | Configure active context URL/token | ✅ | Command Palette + Sidebar |
| Configuration | Reconfigure active context | ✅ | Command Palette + Sidebar |
| Contexts | Create context | ✅ | Command Palette + Sidebar |
| Contexts | Switch context | ✅ | Command Palette + Sidebar |
| Contexts | Delete context | ✅ | Command Palette + Sidebar |
| Applications | List applications | ✅ | Sidebar + Chat Tools |
| Applications | Start/Stop/Restart app | ✅ | Command Palette + Sidebar + Chat Tools |
| Applications | Start deployment | ✅ | Command Palette + Sidebar + Chat Tools |
| Deployments | List deployments | ✅ | Command Palette + Sidebar |
| Deployments | Show deployment details | ✅ | Command Palette + Sidebar |
| Deployments | Show deployment logs | ✅ | Command Palette + Sidebar + Chat Tools |
| Deployments | Cancel deployment | ✅ | Command Palette + Sidebar |
| Environment variables | List/Create/Update/Delete env vars | ✅ | Command Palette + Sidebar |
| Environment variables | `.env` sync with conflict strategy | ✅ | Command Palette + Sidebar |
| Filters/Favorites | Status/app filters + favorites | ✅ | Sidebar |
| Chat participant | `@coolify` operational MVP | ✅ | Copilot Chat |
| Configure Tools | Language Model Tools | ✅ | Copilot Chat > Configure Tools |
| Services (Coolify) | Service entity operations | ❌ | Not implemented |
| Databases (Coolify) | Database entity operations | ❌ | Not implemented |
| Team/Organization | Team management | ❌ | Not implemented |
| Batch operations | Multi-app deployment batch | ❌ | Not implemented |
| Telemetry | Product telemetry/analytics | ❌ | Not implemented |

## 2. Troubleshooting

### 2.1 Authentication failed / invalid token
Symptoms:
- Message like "Authentication failed" or unauthorized errors.

Checks:
1. Re-run `Coolify: Configure` and paste a fresh token.
2. Verify token scope/permissions in Coolify.
3. Confirm active context in status bar (`Coolify: <context>`).

### 2.2 Server unreachable / timeout
Symptoms:
- Health check fails, refresh errors, timeout messages.

Checks:
1. Confirm URL protocol/host/port is correct.
2. Validate DNS/network reachability from your machine.
3. If proxy is required, ensure VS Code/network environment is configured.

### 2.3 HTTP blocked during configuration
Symptoms:
- Setup rejects non-HTTPS server URL.

Checks:
1. Prefer HTTPS endpoint.
2. If you intentionally use trusted local HTTP, enable `coolify.allowInsecureHttp`.
3. Re-run configuration after changing the setting.

### 2.4 Empty application/deployment lists
Symptoms:
- Sidebar shows no apps/deployments after successful setup.

Checks:
1. Verify you are in the expected context.
2. Trigger manual refresh (`↻ Force Refresh`).
3. Inspect `Coolify Extension` output logs via `Coolify: Show Logs`.

### 2.5 Deployment logs not available
Symptoms:
- Logs command returns empty or "No logs available".

Checks:
1. Confirm deployment ID is correct and still available via API.
2. Try latest deployment for the target app.
3. Validate permissions for reading deployment logs.

## 3. Security Guidance

### 3.1 Transport and token safety
- HTTPS is enforced by default for configuration.
- HTTP is blocked unless `coolify.allowInsecureHttp=true`.
- If HTTP is enabled, treat network as trusted-only and rotate token periodically.

### 3.2 Secret handling
- Token is stored in VS Code `SecretStorage` per context key.
- Avoid sharing screenshots/logs that include sensitive server metadata.
- Revoke/rotate token immediately if compromise is suspected.

### 3.3 Webview hardening
- CSP and nonce policy are enabled for webview templates.
- Dynamic UI uses DOM APIs (`textContent`) and central sanitization of display text.
- API payloads are shape-validated before reaching UI mappers.

### 3.4 Incident response baseline
If a token leak is suspected:
1. Revoke token in Coolify immediately.
2. Generate a new token with least privilege.
3. Update extension configuration in all used contexts.
4. Review recent deployment actions and logs for unusual activity.

## 4. Copilot Tools IDs (current)

- `coolify-configure`
- `coolify-healthCheck`
- `coolify-listApplications`
- `coolify-getApplicationStatus`
- `coolify-startDeployment`
- `coolify-applicationLifecycle`
- `coolify-getDeploymentLogs`

## 5. Scope and Non-goals (current release line)

This extension is optimized for deployment-centric operations (applications, deployments, env vars, and context management) inside VS Code. It is not intended to replace the full administrative breadth of `coolify-cli` (services, databases, org/team management, and advanced batch operations).
