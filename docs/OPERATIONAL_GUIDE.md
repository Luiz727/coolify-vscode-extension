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
| Chat participant | `@coolify` operational | ✅ | Copilot Chat |
| Configure Tools | Language Model Tools (21) | ✅ | Copilot Chat > Configure Tools |
| Services (Coolify) | List/details/start/stop/restart | ✅ | Command Palette + Sidebar + Chat Tools |
| Databases (Coolify) | List/details/start/stop/restart | ✅ | Command Palette + Sidebar + Chat Tools |
| Databases (Coolify) | Backup schedules + run backup now | ✅ | Sidebar + Chat Tools |
| Databases (Coolify) | Backup **restore** | ❌ | Not exposed by the Coolify API — see §6 |
| Servers (Coolify) | Health, reachability, disk alerts, hosted resources | ✅ | Sidebar + Chat Tools |
| Applications | Runtime container logs | ✅ | Sidebar + Chat Tools |
| Deployments | History per application | ✅ | Sidebar + Command Palette + Chat Tools |
| VPS (Hostinger) | CPU/RAM/disk/network metrics + power + snapshots | ✅ | Control Center web only |
| Resource deletion | Delete apps/databases/projects/servers | ❌ | Deliberately out of scope — use the Coolify UI |
| Team/Organization | Team management | ❌ | Not implemented |
| Batch operations | Multi-resource batch | ✅ | Control Center web |
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

## 4. Language Model Tools (Copilot / Claude Code)

### 4.1 Safety model

Read tools run without friction. **Every tool that changes state requires explicit
user confirmation** through VS Code's confirmation dialog, which names the
resource, the action and the active context before anything happens.

Target resolution is strict for write operations:

- an `appId` that does not exist is an **error**, never a fallback to name matching;
- a partial name matching more than one resource is an **error** listing the
  candidates — `"api"` never silently picks between `api-prod` and `api-staging`;
- the "there is only one application" shortcut is allowed **only for reads**.

Deletion endpoints are not exposed as tools at all.

### 4.2 Read tools

| Tool | Purpose |
|---|---|
| `coolify-healthCheck` | Connectivity and token validity |
| `coolify-listApplications` | Applications with status and health |
| `coolify-getApplicationStatus` | Detailed status of one application |
| `coolify-getApplicationLogs` | **Runtime** container logs |
| `coolify-listApplicationEnvs` | Env var keys (values never returned) |
| `coolify-listDeployments` | Deployment **history** |
| `coolify-getDeploymentLogs` | Build/deploy logs |
| `coolify-listServices` | Services with status |
| `coolify-listDatabases` | Databases with status |
| `coolify-listDatabaseBackups` | Backup schedules and recent executions |
| `coolify-listProjects` | Projects |
| `coolify-listServers` | Servers with reachability and disk alerts |
| `coolify-getServerResources` | What runs on a given server |

### 4.3 Write tools (all require confirmation)

| Tool | Purpose |
|---|---|
| `coolify-configure` | Opens the configuration flow |
| `coolify-setApplicationEnv` | Creates/updates an env var |
| `coolify-startDeployment` | Starts a deployment |
| `coolify-applicationLifecycle` | start/stop/restart an application |
| `coolify-serviceLifecycle` | start/stop/restart a service |
| `coolify-databaseLifecycle` | start/stop/restart a database |
| `coolify-cancelDeployment` | Cancels a running deployment |
| `coolify-runDatabaseBackup` | Triggers an immediate backup |

## 5. Known API constraints

These are limitations of the Coolify API itself, not of this extension:

- **`GET /deployments` returns only deployments running right now.** History must
  be read per application via `/deployments/applications/{uuid}`. Any screen built
  solely on `/deployments` looks empty on an idle system.
- **Deployments are addressed by UUID**, not by the numeric `id`. Passing the id
  to `/deployments/{uuid}` or `/deployments/{uuid}/cancel` returns 404.
- **Env var create/update accept only** `key`, `value`, `is_preview`, `is_literal`,
  `is_multiline`, `is_shown_once`. Unknown fields — including `is_buildtime` and
  `is_runtime`, which exist on the model — are rejected with 422.
- **`/databases/{uuid}/backups` returns backup *schedules*, not backup files.**
  Actual runs live under `/backups/{scheduled_backup_uuid}/executions`, and
  creating a schedule requires `frequency`.

## 6. Restoring a database backup

**The Coolify API has no restore endpoint.** Restoring is a manual procedure on
the server; the extension deliberately does not offer a button that cannot work.

1. Identify the backup file on the server (default: `/data/coolify/backups/`).
2. Open a terminal on the server through the Coolify UI or SSH.
3. Restore with the client for your engine, for example PostgreSQL:
   ```bash
   docker exec -i <container> psql -U <user> -d <database> < backup.sql
   ```
4. Restart the dependent applications so they reconnect.

Always take a fresh backup before restoring an older one.

## 7. Scope and Non-goals (current release line)

Optimized for deployment-centric operations inside VS Code. Resource **deletion**
and team/organization management stay in the Coolify UI on purpose: they are
irreversible or administrative, and an editor sidebar is the wrong place for them.

Infrastructure monitoring (VPS CPU/RAM/disk) lives in the Control Center web
panel — see [VPS_MONITORING.md](VPS_MONITORING.md).
