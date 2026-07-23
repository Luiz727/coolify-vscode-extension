import express from 'express';

import {
  createAuthMiddleware,
  createSession,
  destroySession,
  getBearerToken,
  getLoginLockRemainingMs,
  loadAuthConfig,
  registerLoginFailure,
  registerLoginSuccess,
  verifyCredentials,
} from './auth.js';
import {
  appendAuditEntry,
  initAuditLog,
  readAuditEntries,
} from './audit.js';
import {
  clampPaging,
  createCoolifyClient,
  executeAction,
  fetchResources,
  normalizeDeploymentLogs,
  normalizeProject,
  CoolifyRequestError,
} from './coolify.js';
import {
  correlateServersToVms,
  createHostingerClient,
  evaluateAlerts,
  flattenMetricSeries,
  isHostingerEnabled,
  HostingerError,
} from './hostinger.js';
import {
  getDeploymentStats,
  getFlappingResources,
  getHistoryStatus,
  getManualLinks,
  getMeanTimeToRecovery,
  getUptimeByResource,
  getVpsMetricSeries,
  initHistory,
  isHistoryEnabled,
  pruneOldData,
  recordResourceStates,
  recordVpsMetrics,
  saveServerVmLinks,
} from './history.js';

const PORT = Number(process.env.PORT || 8787);
const COOLIFY_BASE_URL = (process.env.COOLIFY_BASE_URL || '').trim();
const COOLIFY_TOKEN = (process.env.COOLIFY_TOKEN || '').trim();

/**
 * Fail-closed startup.
 *
 * This console proxies full administrative power over every Coolify resource.
 * Booting it without credentials would publish that power to anyone who can
 * reach the port, so a missing configuration is a fatal error, not a mode.
 */
function validateStartupConfig() {
  const errors = [];

  if (!COOLIFY_BASE_URL) {
    errors.push('COOLIFY_BASE_URL is required.');
  }
  if (!COOLIFY_TOKEN) {
    errors.push('COOLIFY_TOKEN is required.');
  }

  const authConfig = loadAuthConfig();
  errors.push(...authConfig.errors);

  if (errors.length > 0) {
    console.error('\n[control-center] Configuracao invalida. O servidor nao vai subir:\n');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    console.error(
      '\nGere o hash da senha com: npm run hash-password -- "sua-senha"\n' +
        'Documentacao: web-control-center/README.md\n'
    );
    process.exit(1);
  }

  if (authConfig.plainPassword) {
    console.warn(
      '[control-center] WEB_AUTH_PASSWORD em texto puro esta em uso. ' +
        'Prefira WEB_AUTH_PASSWORD_HASH (npm run hash-password).'
    );
  }

  return authConfig;
}

const authConfig = validateStartupConfig();
const requireWebAuth = createAuthMiddleware(authConfig);
const coolify = createCoolifyClient({
  baseUrl: COOLIFY_BASE_URL,
  token: COOLIFY_TOKEN,
  logger: console,
});

const HOSTINGER_ENABLED = isHostingerEnabled();
const hostinger = HOSTINGER_ENABLED
  ? createHostingerClient({ token: process.env.HOSTINGER_API_TOKEN, logger: console })
  : null;

const ALERT_THRESHOLDS = {
  cpuPct: Number(process.env.ALERT_CPU_PCT || 85),
  ramPct: Number(process.env.ALERT_RAM_PCT || 90),
  diskPct: Number(process.env.ALERT_DISK_PCT || 85),
  consecutiveSamples: Number(process.env.ALERT_CONSECUTIVE_SAMPLES || 2),
};

const METRICS_POLL_MS = Number(process.env.VPS_METRICS_POLL_MS || 60000);
const RESOURCE_STATE_POLL_MS = Number(process.env.HISTORY_POLL_MS || 30000);

/** Cap on deployment-history lookups per cycle, to bound the request burst. */
const MAX_APPS_PER_HISTORY_CYCLE = Number(
  process.env.HISTORY_MAX_APPS_PER_CYCLE || 25
);

/** Latest VPS snapshot, refreshed by the collector below. */
const vpsState = {
  virtualMachines: [],
  metricsByVmId: new Map(),
  alertsByVmId: new Map(),
  breachesByVmId: new Map(),
  links: [],
  lastCollectedAt: null,
  lastError: '',
};

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));

function clientKey(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

/**
 * Translates an error into an HTTP response.
 * Upstream response bodies stay in the server log — the browser only receives
 * a message we authored, so provider internals are never leaked.
 */
function sendError(res, error) {
  const known =
    error instanceof CoolifyRequestError || error instanceof HostingerError;

  if (!known) {
    console.error('[control-center] erro nao tratado', error);
  }

  res
    .status(known ? error.status || 500 : 500)
    .json({ message: known ? error.message : 'Erro interno no Control Center.' });
}

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    configured: true,
    authEnabled: true,
    apiBase: coolify.apiBase,
  });
});

app.get('/auth/status', (_req, res) => {
  // Auth is always on. Kept for frontend compatibility.
  res.json({ authEnabled: true });
});

app.post('/auth/login', async (req, res) => {
  const key = clientKey(req);
  const lockRemainingMs = getLoginLockRemainingMs(key);

  if (lockRemainingMs > 0) {
    const seconds = Math.ceil(lockRemainingMs / 1000);
    appendAuditEntry({
      actor: String(req.body?.username || 'unknown'),
      type: 'auth.login',
      status: 'blocked',
      details: `Bloqueado por tentativas repetidas (${seconds}s restantes)`,
    });
    res
      .status(429)
      .json({ message: `Muitas tentativas. Tente novamente em ${seconds}s.` });
    return;
  }

  const username = String(req.body?.username || '');
  const password = String(req.body?.password || '');

  const valid = await verifyCredentials(authConfig, username, password).catch(
    () => false
  );

  if (!valid) {
    registerLoginFailure(key);
    appendAuditEntry({
      actor: username || 'unknown',
      type: 'auth.login',
      status: 'failed',
      details: 'Credenciais invalidas',
    });
    res.status(401).json({ message: 'Credenciais invalidas.' });
    return;
  }

  registerLoginSuccess(key);
  const token = createSession(username);

  appendAuditEntry({
    actor: username,
    type: 'auth.login',
    status: 'succeeded',
    details: 'Login realizado',
  });

  res.json({ token, authEnabled: true, user: username });
});

app.post('/auth/logout', (req, res) => {
  const token = getBearerToken(req);
  destroySession(token);
  res.json({ ok: true });
});

app.use('/api', requireWebAuth);

app.get('/api/session', (req, res) => {
  res.json({ actor: req.actor });
});

app.get('/api/projects', async (_req, res) => {
  try {
    const payload = await coolify.call('/projects');
    const projects = Array.isArray(payload) ? payload.map(normalizeProject) : [];
    res.json({ projects });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/resources', async (_req, res) => {
  try {
    const resources = await fetchResources(coolify, console);
    res.json({ ...resources, fetchedAt: new Date().toISOString() });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/actions/:resourceType/:uuid/:action', async (req, res) => {
  const { resourceType, uuid, action } = req.params;
  const actor = req.actor;

  try {
    const message = await executeAction(coolify, { resourceType, uuid, action });
    appendAuditEntry({
      actor,
      type: 'action.single',
      status: 'succeeded',
      resourceType,
      resourceUuid: uuid,
      action,
      message,
    });
    res.json({ message });
  } catch (error) {
    appendAuditEntry({
      actor,
      type: 'action.single',
      status: 'failed',
      resourceType,
      resourceUuid: uuid,
      action,
      message: error.message,
    });
    sendError(res, error);
  }
});

app.post('/api/actions/batch', async (req, res) => {
  const actor = req.actor;
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (items.length === 0) {
    res.status(400).json({ message: 'Nenhuma acao informada.' });
    return;
  }

  if (items.length > 50) {
    res.status(400).json({ message: 'Lote limitado a 50 recursos por execucao.' });
    return;
  }

  // Record the intent before touching anything, so a crash mid-batch still
  // leaves evidence of what was attempted.
  appendAuditEntry({
    actor,
    type: 'action.batch.intent',
    status: 'started',
    total: items.length,
    items: items.map((item) => ({
      resourceType: item?.resourceType,
      uuid: item?.uuid,
      action: item?.action,
    })),
  });

  const results = [];
  for (const item of items) {
    const resourceType = String(item?.resourceType || '');
    const uuid = String(item?.uuid || '');
    const action = String(item?.action || '');

    if (!resourceType || !uuid || !action) {
      results.push({
        resourceType,
        uuid,
        action,
        ok: false,
        message: 'Payload invalido para item.',
      });
      continue;
    }

    try {
      const message = await executeAction(coolify, { resourceType, uuid, action });
      results.push({ resourceType, uuid, action, ok: true, message });
    } catch (error) {
      results.push({
        resourceType,
        uuid,
        action,
        ok: false,
        message: error.message,
      });
    }
  }

  const succeeded = results.filter((item) => item.ok).length;
  const failed = results.length - succeeded;

  appendAuditEntry({
    actor,
    type: 'action.batch',
    status: failed > 0 ? 'partial' : 'succeeded',
    total: results.length,
    succeeded,
    failed,
    items: results,
  });

  res.json({
    results,
    summary: { total: results.length, succeeded, failed },
  });
});

app.get('/api/audit', (req, res) => {
  const entries = readAuditEntries(req.query.take || 100);
  res.json({ entries });
});

app.get('/api/deployments/applications/:uuid', async (req, res) => {
  const { uuid } = req.params;
  const { skip, take } = clampPaging(req.query.skip, req.query.take, {
    defaultTake: 20,
    maxTake: 100,
  });

  try {
    const payload = await coolify.call(
      `/deployments/applications/${encodeURIComponent(uuid)}?skip=${skip}&take=${take}`
    );

    const deployments = Array.isArray(payload)
      ? payload.map((item) => ({
          id: item.deployment_uuid || String(item.id ?? ''),
          deployment_uuid: item.deployment_uuid,
          status: item.status,
          commit: item.commit,
          commit_message: item.commit_message,
          created_at: item.created_at,
          deployment_url: item.deployment_url,
        }))
      : [];

    res.json({ deployments });
  } catch (error) {
    sendError(res, error);
  }
});

/** Runtime container logs — what the operator actually wants while the app is up. */
app.get('/api/logs/applications/:uuid/runtime', async (req, res) => {
  const { uuid } = req.params;

  try {
    const payload = await coolify.call(
      `/applications/${encodeURIComponent(uuid)}/logs`
    );
    res.json({ logs: typeof payload?.logs === 'string' ? payload.logs : '' });
  } catch (error) {
    sendError(res, error);
  }
});

function toDeploymentMeta(item) {
  return {
    id: item?.deployment_uuid || String(item?.id ?? '') || null,
    deployment_uuid: item?.deployment_uuid || null,
    status: item?.status || 'unknown',
    created_at: item?.created_at || null,
  };
}

app.get('/api/logs/applications/:uuid/latest', async (req, res) => {
  const { uuid } = req.params;

  try {
    const deploymentsPayload = await coolify.call(
      `/deployments/applications/${encodeURIComponent(uuid)}?skip=0&take=1`
    );

    const latest = Array.isArray(deploymentsPayload) ? deploymentsPayload[0] : null;
    if (!latest) {
      res.json({ deployment: null, logs: '' });
      return;
    }

    // /deployments/{uuid} expects the deployment UUID, not the numeric id.
    const deploymentId = latest.deployment_uuid || latest.id;
    if (!deploymentId) {
      res.json({ deployment: toDeploymentMeta(latest), logs: '' });
      return;
    }

    const details = await coolify.call(
      `/deployments/${encodeURIComponent(String(deploymentId))}`
    );

    res.json({
      deployment: toDeploymentMeta(latest),
      logs: normalizeDeploymentLogs(details?.logs),
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/logs/applications/:uuid/history', async (req, res) => {
  const { uuid } = req.params;
  const { take } = clampPaging(0, req.query.take, { defaultTake: 5, maxTake: 20 });

  try {
    const deploymentsPayload = await coolify.call(
      `/deployments/applications/${encodeURIComponent(uuid)}?skip=0&take=${take}`
    );

    const deployments = Array.isArray(deploymentsPayload) ? deploymentsPayload : [];
    if (deployments.length === 0) {
      res.json({ entries: [] });
      return;
    }

    const entries = await Promise.all(
      deployments.map(async (item) => {
        const deploymentId = item.deployment_uuid || item.id;
        if (!deploymentId) {
          return { deployment: toDeploymentMeta(item), logs: '' };
        }

        try {
          const details = await coolify.call(
            `/deployments/${encodeURIComponent(String(deploymentId))}`
          );
          return {
            deployment: toDeploymentMeta(item),
            logs: normalizeDeploymentLogs(details?.logs),
          };
        } catch {
          return { deployment: toDeploymentMeta(item), logs: '' };
        }
      })
    );

    res.json({ entries });
  } catch (error) {
    sendError(res, error);
  }
});

// ---------------------------------------------------------------------------
// Servers (Coolify) — the root-cause signals at machine level
// ---------------------------------------------------------------------------

app.get('/api/servers', async (_req, res) => {
  try {
    const payload = await coolify.call('/servers');
    const servers = Array.isArray(payload) ? payload : [];

    const detailed = await Promise.all(
      servers.map(async (server) => {
        const resources = await coolify
          .call(`/servers/${encodeURIComponent(server.uuid)}/resources`)
          .catch(() => []);

        return {
          uuid: server.uuid,
          name: server.name,
          ip: server.ip || '',
          proxyType: server.proxy_type || 'none',
          // A non-zero unreachable_count means Coolify is failing to SSH in.
          reachable: !(server.unreachable_count && server.unreachable_count > 0),
          unreachableCount: Number(server.unreachable_count) || 0,
          highDiskUsage: server.high_disk_usage_notification_sent === true,
          resourceCount: Array.isArray(resources) ? resources.length : 0,
        };
      })
    );

    res.json({ servers: detailed });
  } catch (error) {
    sendError(res, error);
  }
});

// ---------------------------------------------------------------------------
// VPS (Hostinger)
// ---------------------------------------------------------------------------

function requireHostinger(_req, res, next) {
  if (!HOSTINGER_ENABLED) {
    res.status(503).json({
      message:
        'Monitoramento de VPS desativado. Defina HOSTINGER_API_TOKEN para habilitar.',
    });
    return;
  }
  next();
}

app.get('/api/vps', requireHostinger, (_req, res) => {
  const machines = vpsState.virtualMachines.map((vm) => ({
    ...vm,
    metrics: vpsState.metricsByVmId.get(vm.id) || null,
    alerts: vpsState.alertsByVmId.get(vm.id) || [],
    linkedServers: vpsState.links
      .filter((link) => link.vmId === vm.id)
      .map((link) => ({ uuid: link.serverUuid, name: link.serverName })),
  }));

  res.json({
    machines,
    thresholds: ALERT_THRESHOLDS,
    lastCollectedAt: vpsState.lastCollectedAt,
    error: vpsState.lastError || undefined,
    historyEnabled: isHistoryEnabled(),
  });
});

app.get('/api/vps/:vmId/metrics', requireHostinger, async (req, res) => {
  const { vmId } = req.params;
  const windowHours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 168);

  try {
    // Prefer our own series (denser and cheaper); fall back to the provider.
    if (isHistoryEnabled()) {
      const series = await getVpsMetricSeries(vmId, windowHours);
      if (series.length > 0) {
        res.json({ source: 'history', windowHours, series });
        return;
      }
    }

    const metrics = await hostinger.getMetrics(vmId, {
      from: new Date(Date.now() - windowHours * 3600_000).toISOString(),
    });

    // Same shape as the history source: the UI must not care where the
    // series came from.
    res.json({
      source: 'hostinger',
      windowHours,
      series: flattenMetricSeries(metrics.series),
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/vps/:vmId/restore-points', requireHostinger, async (req, res) => {
  const { vmId } = req.params;

  try {
    const [snapshot, backups] = await Promise.all([
      hostinger.getSnapshot(vmId).catch(() => null),
      hostinger.listBackups(vmId).catch(() => []),
    ]);

    res.json({ snapshot, backups });
  } catch (error) {
    sendError(res, error);
  }
});

/**
 * Computes what a VPS-level operation would take down.
 *
 * Rebooting a machine is not like restarting a container: every Coolify
 * resource on it goes with it. The operator sees this list before confirming.
 */
async function computeBlastRadius(vmId) {
  const linkedServers = vpsState.links.filter((link) => link.vmId === vmId);

  const affected = await Promise.all(
    linkedServers.map(async (link) => {
      const resources = await coolify
        .call(`/servers/${encodeURIComponent(link.serverUuid)}/resources`)
        .catch(() => []);

      return {
        serverUuid: link.serverUuid,
        serverName: link.serverName,
        resources: (Array.isArray(resources) ? resources : []).map((item) => ({
          uuid: item.uuid,
          name: item.name,
          type: item.type,
          status: item.status,
        })),
      };
    })
  );

  const totalResources = affected.reduce(
    (total, server) => total + server.resources.length,
    0
  );

  return { servers: affected, totalResources };
}

app.get('/api/vps/:vmId/blast-radius', requireHostinger, async (req, res) => {
  try {
    res.json(await computeBlastRadius(req.params.vmId));
  } catch (error) {
    sendError(res, error);
  }
});

/**
 * Guard for every state-changing VPS operation.
 *
 * The user must echo the machine hostname. This is not decoration: it is the
 * difference between "I clicked the wrong row" and "I meant this machine".
 */
async function assertVpsConfirmation(req, vmId) {
  const vm =
    vpsState.virtualMachines.find((candidate) => candidate.id === String(vmId)) ||
    (await hostinger.getVirtualMachine(vmId));

  if (!vm) {
    throw new HostingerError('Maquina virtual nao encontrada.', 404);
  }

  const typed = String(req.body?.confirmHostname || '').trim();
  if (!typed || typed !== vm.hostname) {
    throw new HostingerError(
      `Confirmacao invalida. Digite exatamente o hostname da maquina para confirmar.`,
      400
    );
  }

  return vm;
}

async function runGuardedVpsOperation({
  req,
  res,
  vmId,
  operation,
  auditType,
  irreversible = false,
  perform,
}) {
  const actor = req.actor;
  let vm;

  try {
    vm = await assertVpsConfirmation(req, vmId);
  } catch (error) {
    appendAuditEntry({
      actor,
      type: auditType,
      status: 'rejected',
      vmId,
      operation,
      message: error.message,
    });
    sendError(res, error);
    return;
  }

  if (irreversible && req.body?.acknowledgeDataLoss !== true) {
    const error = new HostingerError(
      'Operacao irreversivel: e necessario reconhecer explicitamente a perda de dados (acknowledgeDataLoss).',
      400
    );
    appendAuditEntry({
      actor,
      type: auditType,
      status: 'rejected',
      vmId,
      hostname: vm.hostname,
      operation,
      message: error.message,
    });
    sendError(res, error);
    return;
  }

  const blastRadius = await computeBlastRadius(vmId).catch(() => ({
    totalResources: 0,
    servers: [],
  }));

  // Intent is recorded BEFORE the call: if the process dies mid-operation the
  // trail still shows who asked for what.
  appendAuditEntry({
    actor,
    type: auditType,
    status: 'intent',
    vmId,
    hostname: vm.hostname,
    operation,
    irreversible,
    affectedResources: blastRadius.totalResources,
  });

  try {
    const result = await perform();
    appendAuditEntry({
      actor,
      type: auditType,
      status: 'succeeded',
      vmId,
      hostname: vm.hostname,
      operation,
      affectedResources: blastRadius.totalResources,
    });
    res.json({ ok: true, operation, hostname: vm.hostname, result });
  } catch (error) {
    appendAuditEntry({
      actor,
      type: auditType,
      status: 'failed',
      vmId,
      hostname: vm.hostname,
      operation,
      message: error.message,
    });
    sendError(res, error);
  }
}

app.post('/api/vps/:vmId/power/:action', requireHostinger, async (req, res) => {
  const { vmId, action } = req.params;

  if (!['start', 'stop', 'restart'].includes(action)) {
    res.status(400).json({ message: 'Acao de energia invalida.' });
    return;
  }

  await runGuardedVpsOperation({
    req,
    res,
    vmId,
    operation: `power.${action}`,
    auditType: 'vps.power',
    perform: () => hostinger.powerAction(vmId, action),
  });
});

app.post('/api/vps/:vmId/snapshot', requireHostinger, async (req, res) => {
  await runGuardedVpsOperation({
    req,
    res,
    vmId: req.params.vmId,
    operation: 'snapshot.create',
    auditType: 'vps.snapshot',
    perform: () => hostinger.createSnapshot(req.params.vmId),
  });
});

app.delete('/api/vps/:vmId/snapshot', requireHostinger, async (req, res) => {
  await runGuardedVpsOperation({
    req,
    res,
    vmId: req.params.vmId,
    operation: 'snapshot.delete',
    auditType: 'vps.snapshot',
    perform: () => hostinger.deleteSnapshot(req.params.vmId),
  });
});

app.post('/api/vps/:vmId/snapshot/restore', requireHostinger, async (req, res) => {
  await runGuardedVpsOperation({
    req,
    res,
    vmId: req.params.vmId,
    operation: 'snapshot.restore',
    auditType: 'vps.restore',
    irreversible: true,
    perform: () => hostinger.restoreSnapshot(req.params.vmId),
  });
});

app.post(
  '/api/vps/:vmId/backups/:backupId/restore',
  requireHostinger,
  async (req, res) => {
    await runGuardedVpsOperation({
      req,
      res,
      vmId: req.params.vmId,
      operation: `backup.restore:${req.params.backupId}`,
      auditType: 'vps.restore',
      irreversible: true,
      perform: () =>
        hostinger.restoreBackup(req.params.vmId, req.params.backupId),
    });
  }
);

// ---------------------------------------------------------------------------
// Metrics / history
// ---------------------------------------------------------------------------

app.get('/api/metrics', async (req, res) => {
  if (!isHistoryEnabled()) {
    res.json({
      enabled: false,
      message:
        'Historico desativado. Defina HISTORY_DATABASE_URL para habilitar uptime, MTTR e taxa de deploy.',
      ...getHistoryStatus(),
    });
    return;
  }

  const windowHours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 720);

  try {
    const [uptime, mttr, deployments, flapping] = await Promise.all([
      getUptimeByResource(windowHours),
      getMeanTimeToRecovery(windowHours),
      getDeploymentStats(windowHours),
      getFlappingResources(60, 4),
    ]);

    res.json({ enabled: true, windowHours, uptime, mttr, deployments, flapping });
  } catch (error) {
    sendError(res, error);
  }
});

// ---------------------------------------------------------------------------
// Background collectors
// ---------------------------------------------------------------------------

async function collectVpsMetrics() {
  if (!HOSTINGER_ENABLED) {
    return;
  }

  try {
    const machines = await hostinger.listVirtualMachines();
    vpsState.virtualMachines = machines.filter(Boolean);

    const serversPayload = await coolify.call('/servers').catch(() => []);
    const servers = Array.isArray(serversPayload) ? serversPayload : [];
    const manualLinks = isHistoryEnabled() ? await getManualLinks() : {};

    vpsState.links = correlateServersToVms(
      servers,
      vpsState.virtualMachines,
      manualLinks
    );
    await saveServerVmLinks(vpsState.links);

    // Sequential on purpose: bursting the provider invites a 429 that would
    // block the next several collection cycles.
    for (const vm of vpsState.virtualMachines) {
      try {
        const metrics = await hostinger.getMetrics(vm.id, {
          from: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        });

        vpsState.metricsByVmId.set(vm.id, {
          cpuPct: metrics.cpuPct,
          ramPct: metrics.ramPct,
          diskPct: metrics.diskPct,
          netIn: metrics.netIn,
          netOut: metrics.netOut,
          uptimeSeconds: metrics.uptimeSeconds,
        });

        const { alerts, breaches } = evaluateAlerts(
          metrics,
          ALERT_THRESHOLDS,
          vpsState.breachesByVmId.get(vm.id) || {}
        );
        vpsState.alertsByVmId.set(vm.id, alerts);
        vpsState.breachesByVmId.set(vm.id, breaches);

        await recordVpsMetrics(vm.id, metrics);
      } catch (error) {
        console.warn(`[vps] falha ao coletar metricas de ${vm.id}: ${error.message}`);
      }
    }

    vpsState.lastCollectedAt = new Date().toISOString();
    vpsState.lastError = '';
  } catch (error) {
    vpsState.lastError = error.message;
    console.warn(`[vps] coleta falhou: ${error.message}`);
  }
}

async function collectResourceStates() {
  if (!isHistoryEnabled()) {
    return;
  }

  try {
    const resources = await fetchResources(coolify, console);
    const all = [
      ...resources.applications,
      ...resources.services,
      ...resources.databases,
    ];
    await recordResourceStates(all);
    await collectDeploymentHistory(resources.applications);
  } catch (error) {
    console.warn(`[history] coleta de estados falhou: ${error.message}`);
  }
}

/**
 * Feeds deployment_history so /api/metrics can report success rate and
 * duration. Without this the table stays empty and the metric is meaningless.
 *
 * Sequential with a small cap: this runs every 30s and must not burst the API.
 */
async function collectDeploymentHistory(applications) {
  if (!isHistoryEnabled() || !Array.isArray(applications)) {
    return;
  }

  for (const application of applications.slice(0, MAX_APPS_PER_HISTORY_CYCLE)) {
    try {
      const payload = await coolify.call(
        `/deployments/applications/${encodeURIComponent(application.uuid)}?skip=0&take=5`
      );

      if (!Array.isArray(payload)) {
        continue;
      }

      for (const item of payload) {
        const uuid = item.deployment_uuid || (item.id ? String(item.id) : '');
        if (!uuid) {
          continue;
        }

        const startedAt = item.created_at || null;
        const finishedAt = isTerminalDeploymentStatus(item.status)
          ? item.updated_at || null
          : null;

        await recordDeployment({
          uuid,
          applicationUuid: application.uuid,
          applicationName: application.name,
          status: item.status || 'unknown',
          commit: item.commit || null,
          commitMessage: item.commit_message || null,
          startedAt,
          finishedAt,
          durationMs:
            startedAt && finishedAt
              ? Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime())
              : null,
        });
      }
    } catch (error) {
      console.warn(
        `[history] deployments de ${application.uuid} falharam: ${error.message}`
      );
    }
  }
}

function isTerminalDeploymentStatus(status) {
  const value = String(status || '').toLowerCase();
  return (
    value.includes('finish') ||
    value.includes('success') ||
    value.includes('fail') ||
    value.includes('error') ||
    value.includes('cancel')
  );
}

async function start() {
  await initAuditLog(process.env.AUDIT_LOG_PATH, console);
  await initHistory(console);

  if (HOSTINGER_ENABLED) {
    console.log('[control-center] monitoramento de VPS (Hostinger) habilitado.');
    collectVpsMetrics();
    setInterval(collectVpsMetrics, METRICS_POLL_MS).unref();
  } else {
    console.log(
      '[control-center] HOSTINGER_API_TOKEN ausente — secao de infraestrutura desativada.'
    );
  }

  if (isHistoryEnabled()) {
    collectResourceStates();
    setInterval(collectResourceStates, RESOURCE_STATE_POLL_MS).unref();
    setInterval(pruneOldData, 6 * 60 * 60 * 1000).unref();
  }

  app.listen(PORT, () => {
    console.log(`[control-center] backend ouvindo na porta ${PORT}`);
    console.log(`[control-center] API do Coolify: ${coolify.apiBase}`);
  });
}

start().catch((error) => {
  console.error('[control-center] falha ao iniciar', error);
  process.exit(1);
});
