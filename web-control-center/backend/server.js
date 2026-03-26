import express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 8787);
const COOLIFY_BASE_URL = (process.env.COOLIFY_BASE_URL || '').trim();
const COOLIFY_TOKEN = (process.env.COOLIFY_TOKEN || '').trim();

const WEB_AUTH_USER = (process.env.WEB_AUTH_USER || '').trim();
const WEB_AUTH_PASSWORD = (process.env.WEB_AUTH_PASSWORD || '').trim();
const WEB_ACCESS_TOKEN = (process.env.WEB_ACCESS_TOKEN || '').trim();
const AUTH_ENABLED = Boolean(WEB_AUTH_USER && WEB_AUTH_PASSWORD);

const AUDIT_LOG_PATH = path.resolve(
  process.cwd(),
  process.env.AUDIT_LOG_PATH || './web-control-center/backend/audit.log.jsonl'
);

function ensureApiBase(baseUrl) {
  const normalized = baseUrl.replace(/\/+$/, '');
  if (normalized.endsWith('/api/v1')) {
    return normalized;
  }
  if (normalized.endsWith('/api')) {
    return `${normalized}/v1`;
  }
  return `${normalized}/api/v1`;
}

function getAuthHeaders() {
  return {
    Authorization: `Bearer ${COOLIFY_TOKEN}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function statusBucket(status) {
  const value = String(status || '').toLowerCase();
  if (value.startsWith('running')) {
    return 'running';
  }
  if (value.startsWith('starting')) {
    return 'starting';
  }
  if (value.includes('error') || value.includes('failed')) {
    return 'error';
  }
  if (value.startsWith('exited') || value.startsWith('stopped')) {
    return 'stopped';
  }
  return 'unknown';
}

function getWebToken() {
  if (WEB_ACCESS_TOKEN) {
    return WEB_ACCESS_TOKEN;
  }
  return Buffer.from(`${WEB_AUTH_USER}:${WEB_AUTH_PASSWORD}`).toString('base64url');
}

function getBearerToken(req) {
  const auth = req.headers.authorization || '';
  if (!auth.toLowerCase().startsWith('bearer ')) {
    return '';
  }
  return auth.slice(7).trim();
}

function requireWebAuth(req, res, next) {
  if (!AUTH_ENABLED) {
    next();
    return;
  }

  const token = getBearerToken(req);
  if (!token || token !== getWebToken()) {
    res.status(401).json({ message: 'Nao autenticado.' });
    return;
  }

  next();
}

async function appendAuditEntry(entry) {
  const payload = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n';
  await fs.mkdir(path.dirname(AUDIT_LOG_PATH), { recursive: true });
  await fs.appendFile(AUDIT_LOG_PATH, payload, 'utf8');
}

async function readAuditEntries(take = 100) {
  try {
    const raw = await fs.readFile(AUDIT_LOG_PATH, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const parsed = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return parsed.slice(-take).reverse();
  } catch {
    return [];
  }
}

async function callCoolify(pathValue, options = {}) {
  if (!COOLIFY_BASE_URL || !COOLIFY_TOKEN) {
    throw new Error('Missing COOLIFY_BASE_URL or COOLIFY_TOKEN');
  }

  const url = `${ensureApiBase(COOLIFY_BASE_URL)}${pathValue}`;
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || 15000);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: getAuthHeaders(),
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      const error = new Error(`Coolify request failed (${response.status}): ${body}`);
      error.status = response.status;
      throw error;
    }

    if (response.status === 204) {
      return null;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      return { raw: text };
    }

    return response.json();
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error(`Tempo limite excedido em ${timeoutMs}ms`);
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeProject(item) {
  return {
    uuid: item.uuid,
    name: item.name,
    description: item.description || '',
  };
}

function normalizeResource(item, type) {
  return {
    uuid: item.uuid,
    name: item.name,
    type,
    description: item.description || '',
    status: item.status || 'unknown',
    statusBucket: statusBucket(item.status),
    environment: item.environment_name || item.environment?.name || '',
    project: item.project_name || item.project || '',
  };
}

async function fetchProjects() {
  const payload = await callCoolify('/projects');
  return Array.isArray(payload) ? payload.map(normalizeProject) : [];
}

async function fetchResources() {
  const [applications, services, databases] = await Promise.all([
    callCoolify('/applications').catch(() => []),
    callCoolify('/services').catch(() => []),
    callCoolify('/databases').catch(() => []),
  ]);

  return {
    applications: Array.isArray(applications)
      ? applications.map((item) => normalizeResource(item, 'application'))
      : [],
    services: Array.isArray(services)
      ? services.map((item) => normalizeResource(item, 'service'))
      : [],
    databases: Array.isArray(databases)
      ? databases.map((item) => normalizeResource(item, 'database'))
      : [],
  };
}

async function executeAction({ resourceType, uuid, action }) {
  const allowedTypeMap = {
    application: 'applications',
    service: 'services',
    database: 'databases',
  };
  const allowedActions = new Set(['start', 'stop', 'restart', 'deploy']);
  const collection = allowedTypeMap[resourceType];

  if (!collection) {
    const error = new Error('resourceType invalido.');
    error.status = 400;
    throw error;
  }

  if (!allowedActions.has(action)) {
    const error = new Error('action invalida.');
    error.status = 400;
    throw error;
  }

  if (resourceType === 'application' && action === 'deploy') {
    const payload = await callCoolify(`/deploy?uuid=${encodeURIComponent(uuid)}`);
    return payload?.message || 'Deploy solicitado.';
  }

  const payload = await callCoolify(`/${collection}/${encodeURIComponent(uuid)}/${action}`);
  return payload?.message || `${action} solicitado.`;
}

app.get('/health', (_req, res) => {
  const configured = Boolean(COOLIFY_BASE_URL && COOLIFY_TOKEN);
  res.json({
    status: 'ok',
    configured,
    authEnabled: AUTH_ENABLED,
    apiBase: configured ? ensureApiBase(COOLIFY_BASE_URL) : null,
  });
});

app.get('/auth/status', (_req, res) => {
  res.json({ authEnabled: AUTH_ENABLED });
});

app.post('/auth/login', async (req, res) => {
  if (!AUTH_ENABLED) {
    res.json({ token: 'no-auth', authEnabled: false });
    return;
  }

  const { username, password } = req.body || {};
  if (username !== WEB_AUTH_USER || password !== WEB_AUTH_PASSWORD) {
    await appendAuditEntry({
      actor: username || 'unknown',
      type: 'auth.login',
      status: 'failed',
      details: 'Credenciais invalidas',
    });
    res.status(401).json({ message: 'Credenciais invalidas.' });
    return;
  }

  await appendAuditEntry({
    actor: username,
    type: 'auth.login',
    status: 'succeeded',
    details: 'Login realizado',
  });

  res.json({ token: getWebToken(), authEnabled: true });
});

app.use('/api', requireWebAuth);

app.get('/api/projects', async (_req, res) => {
  try {
    const projects = await fetchProjects();
    res.json({ projects });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

app.get('/api/resources', async (_req, res) => {
  try {
    const resources = await fetchResources();
    res.json(resources);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

app.post('/api/actions/:resourceType/:uuid/:action', async (req, res) => {
  const { resourceType, uuid, action } = req.params;
  const actor = String(req.headers['x-actor'] || 'web-user');

  try {
    const message = await executeAction({ resourceType, uuid, action });
    await appendAuditEntry({
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
    await appendAuditEntry({
      actor,
      type: 'action.single',
      status: 'failed',
      resourceType,
      resourceUuid: uuid,
      action,
      message: error.message,
    });
    res.status(error.status || 500).json({ message: error.message });
  }
});

app.post('/api/actions/batch', async (req, res) => {
  const actor = String(req.headers['x-actor'] || 'web-user');
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (items.length === 0) {
    res.status(400).json({ message: 'Nenhuma acao informada.' });
    return;
  }

  const results = [];
  for (const item of items) {
    const resourceType = String(item.resourceType || '');
    const uuid = String(item.uuid || '');
    const action = String(item.action || '');

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
      const message = await executeAction({ resourceType, uuid, action });
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

  await appendAuditEntry({
    actor,
    type: 'action.batch',
    status: results.some((item) => !item.ok) ? 'partial' : 'succeeded',
    total: results.length,
    succeeded: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    items: results,
  });

  res.json({
    results,
    summary: {
      total: results.length,
      succeeded: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
    },
  });
});

app.get('/api/audit', async (req, res) => {
  const take = Number(req.query.take || 100);
  const safeTake = Number.isFinite(take) ? Math.max(1, Math.min(500, take)) : 100;
  const entries = await readAuditEntries(safeTake);
  res.json({ entries });
});

app.get('/api/deployments/applications/:uuid', async (req, res) => {
  const { uuid } = req.params;
  const skip = Number(req.query.skip || 0);
  const take = Number(req.query.take || 20);

  try {
    const payload = await callCoolify(
      `/deployments/applications/${encodeURIComponent(uuid)}?skip=${Math.max(0, skip)}&take=${Math.max(1, take)}`
    );

    const deployments = Array.isArray(payload)
      ? payload.map((item) => ({
          id: item.id,
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
    res.status(error.status || 500).json({ message: error.message });
  }
});

app.get('/api/logs/applications/:uuid/latest', async (req, res) => {
  const { uuid } = req.params;

  try {
    const deploymentsPayload = await callCoolify(
      `/deployments/applications/${encodeURIComponent(uuid)}?skip=0&take=1`
    );

    const latest = Array.isArray(deploymentsPayload) ? deploymentsPayload[0] : null;
    if (!latest) {
      res.json({ deployment: null, logs: '' });
      return;
    }

    const deploymentId = latest.id || latest.deployment_uuid;
    if (!deploymentId) {
      res.json({
        deployment: {
          id: latest.id || null,
          deployment_uuid: latest.deployment_uuid || null,
          status: latest.status || 'unknown',
          created_at: latest.created_at || null,
        },
        logs: '',
      });
      return;
    }

    const deploymentDetails = await callCoolify(
      `/deployments/${encodeURIComponent(String(deploymentId))}`
    );

    res.json({
      deployment: {
        id: latest.id || null,
        deployment_uuid: latest.deployment_uuid || null,
        status: latest.status || 'unknown',
        created_at: latest.created_at || null,
      },
      logs: typeof deploymentDetails?.logs === 'string' ? deploymentDetails.logs : '',
    });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

app.get('/api/logs/applications/:uuid/history', async (req, res) => {
  const { uuid } = req.params;
  const takeRaw = Number(req.query.take || 5);
  const take = Number.isFinite(takeRaw) ? Math.max(1, Math.min(20, takeRaw)) : 5;

  try {
    const deploymentsPayload = await callCoolify(
      `/deployments/applications/${encodeURIComponent(uuid)}?skip=0&take=${take}`
    );

    const deployments = Array.isArray(deploymentsPayload) ? deploymentsPayload : [];
    if (deployments.length === 0) {
      res.json({ entries: [] });
      return;
    }

    const entries = await Promise.all(
      deployments.map(async (item) => {
        const deploymentId = item.id || item.deployment_uuid;
        if (!deploymentId) {
          return {
            deployment: {
              id: item.id || null,
              deployment_uuid: item.deployment_uuid || null,
              status: item.status || 'unknown',
              created_at: item.created_at || null,
            },
            logs: '',
          };
        }

        try {
          const details = await callCoolify(`/deployments/${encodeURIComponent(String(deploymentId))}`);
          return {
            deployment: {
              id: item.id || null,
              deployment_uuid: item.deployment_uuid || null,
              status: item.status || 'unknown',
              created_at: item.created_at || null,
            },
            logs: typeof details?.logs === 'string' ? details.logs : '',
          };
        } catch {
          return {
            deployment: {
              id: item.id || null,
              deployment_uuid: item.deployment_uuid || null,
              status: item.status || 'unknown',
              created_at: item.created_at || null,
            },
            logs: '',
          };
        }
      })
    );

    res.json({ entries });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Control Center backend running on port ${PORT}`);
});
