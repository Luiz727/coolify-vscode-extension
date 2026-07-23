import { parseResourceStatus } from './status.js';

const DEFAULT_TIMEOUT_MS = 15000;
const RESOURCE_CACHE_TTL_MS = Number(process.env.COOLIFY_CACHE_TTL_MS || 5000);
const PROJECT_INDEX_TTL_MS = Number(process.env.COOLIFY_PROJECT_TTL_MS || 60000);

export class CoolifyRequestError extends Error {
  constructor(message, status, endpoint, upstreamBody) {
    super(message);
    this.name = 'CoolifyRequestError';
    this.status = status;
    this.endpoint = endpoint;
    /** Kept server-side only. Never serialize this to the browser. */
    this.upstreamBody = upstreamBody;
  }
}

export function ensureApiBase(baseUrl) {
  const normalized = String(baseUrl || '').replace(/\/+$/, '');
  if (normalized.endsWith('/api/v1')) {
    return normalized;
  }
  if (normalized.endsWith('/api')) {
    return `${normalized}/v1`;
  }
  return `${normalized}/api/v1`;
}

/**
 * Shared response cache. Several operators with the console open must not
 * multiply the load on the Coolify VPS — they read the same snapshot.
 */
const responseCache = new Map();

function readCache(key, ttlMs) {
  const entry = responseCache.get(key);
  if (!entry) {
    return undefined;
  }
  if (Date.now() - entry.storedAt > ttlMs) {
    responseCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function writeCache(key, value) {
  responseCache.set(key, { value, storedAt: Date.now() });
}

export function clearCoolifyCache() {
  responseCache.clear();
}

/**
 * Drops the cached resource snapshots after a mutation.
 *
 * Without this the refresh that follows a start/stop/deploy is served from the
 * 5s cache and the operator sees the old status — looking as if the action did
 * nothing. The project index is kept: actions never change project membership.
 */
export function invalidateResourceCache() {
  for (const key of responseCache.keys()) {
    if (key === 'project-index') {
      continue;
    }
    responseCache.delete(key);
  }
}

export function createCoolifyClient({ baseUrl, token, logger = console }) {
  const apiBase = ensureApiBase(baseUrl);

  async function call(pathValue, options = {}) {
    if (!baseUrl || !token) {
      throw new CoolifyRequestError(
        'Integracao com o Coolify nao configurada.',
        500,
        pathValue
      );
    }

    const method = options.method || 'GET';
    const cacheKey = `${method}:${pathValue}`;
    const cacheTtl = options.cacheTtlMs ?? (method === 'GET' ? RESOURCE_CACHE_TTL_MS : 0);

    if (cacheTtl > 0) {
      const cached = readCache(cacheKey, cacheTtl);
      if (cached !== undefined) {
        return cached;
      }
    }

    const controller = new AbortController();
    const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    try {
      const response = await fetch(`${apiBase}${pathValue}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const upstreamBody = await response.text().catch(() => '');
        logger.error?.(
          `[coolify] ${method} ${pathValue} -> ${response.status}: ${upstreamBody.slice(0, 500)}`
        );
        throw new CoolifyRequestError(
          describeUpstreamStatus(response.status),
          response.status,
          pathValue,
          upstreamBody
        );
      }

      let payload = null;
      if (response.status !== 204) {
        const contentType = response.headers.get('content-type') || '';
        payload = contentType.includes('application/json')
          ? await response.json()
          : { raw: await response.text() };
      }

      if (cacheTtl > 0) {
        writeCache(cacheKey, payload);
      }

      return payload;
    } catch (error) {
      if (error instanceof CoolifyRequestError) {
        throw error;
      }
      if (error?.name === 'AbortError') {
        throw new CoolifyRequestError(
          `Tempo limite excedido em ${timeoutMs}ms ao falar com o Coolify.`,
          504,
          pathValue
        );
      }
      logger.error?.(`[coolify] ${method} ${pathValue} falhou`, error);
      throw new CoolifyRequestError(
        'Falha de rede ao comunicar com o Coolify.',
        502,
        pathValue
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return { call, apiBase };
}

function describeUpstreamStatus(status) {
  if (status === 401) return 'Token do Coolify invalido ou expirado.';
  if (status === 403) return 'Token do Coolify sem permissao para esta acao.';
  if (status === 404) return 'Recurso nao encontrado no Coolify.';
  if (status === 422) return 'Dados invalidos enviados ao Coolify.';
  if (status === 429) return 'Coolify recusou por excesso de requisicoes.';
  if (status >= 500) return 'Coolify indisponivel ou com erro interno.';
  return `Erro inesperado do Coolify (${status}).`;
}

/**
 * Coolify stores deployment logs as a JSON-encoded array of entries.
 * Dumping that raw into a <pre> shows the operator JSON instead of logs.
 */
export function normalizeDeploymentLogs(rawLogs) {
  if (typeof rawLogs !== 'string' || !rawLogs.trim()) {
    return '';
  }

  try {
    const parsed = JSON.parse(rawLogs);
    if (!Array.isArray(parsed)) {
      return rawLogs;
    }

    return parsed
      .slice()
      .sort((a, b) => Number(a?.order ?? 0) - Number(b?.order ?? 0))
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry;
        }
        return String(entry?.output ?? '');
      })
      .filter((line) => line.length > 0)
      .join('\n');
  } catch {
    // Plain text logs are equally valid — return them untouched.
    return rawLogs;
  }
}

/**
 * Builds resourceUuid -> {project, environment}.
 *
 * The /applications and /services payloads carry only environment_id, never
 * project_name — which is why the project filter never matched anything.
 * The reliable mapping comes from walking projects -> environments -> resources.
 */
export async function buildProjectIndex(client, logger = console) {
  const cached = readCache('project-index', PROJECT_INDEX_TTL_MS);
  if (cached !== undefined) {
    return cached;
  }

  const index = new Map();
  const projects = await client.call('/projects').catch((error) => {
    logger.warn?.('[coolify] falha ao listar projetos', error.message);
    return [];
  });

  const projectList = Array.isArray(projects) ? projects : [];

  // Build the full task list first, then drain it with a bounded worker pool.
  // Fanning out project × environment with Promise.all sent dozens of
  // simultaneous requests to the VPS — the exact burst this codebase avoids
  // everywhere else.
  const tasks = [];
  for (const project of projectList) {
    const environments = Array.isArray(project.environments)
      ? project.environments
      : await client
          .call(`/projects/${encodeURIComponent(project.uuid)}/environments`)
          .catch(() => []);

    for (const environment of Array.isArray(environments) ? environments : []) {
      const environmentKey = environment?.uuid || environment?.name;
      if (environmentKey) {
        tasks.push({ project, environment, environmentKey });
      }
    }
  }

  await drainWithConcurrency(tasks, PROJECT_INDEX_CONCURRENCY, async (task) => {
    const detail = await client
      .call(
        `/projects/${encodeURIComponent(task.project.uuid)}/${encodeURIComponent(task.environmentKey)}`
      )
      .catch(() => null);

    if (!detail) {
      return;
    }

    for (const collection of RESOURCE_COLLECTIONS) {
      const items = detail[collection];
      if (!Array.isArray(items)) {
        continue;
      }
      for (const item of items) {
        if (item?.uuid) {
          index.set(item.uuid, {
            project: task.project.name || '',
            environment: task.environment.name || '',
          });
        }
      }
    }
  });

  writeCache('project-index', index);
  return index;
}

const PROJECT_INDEX_CONCURRENCY = Number(
  process.env.COOLIFY_INDEX_CONCURRENCY || 4
);

/** Every collection a Coolify environment payload may expose. */
const RESOURCE_COLLECTIONS = [
  'applications',
  'services',
  'databases',
  'postgresqls',
  'mysqls',
  'mariadbs',
  'mongodbs',
  'redis',
  'keydbs',
  'dragonflies',
  'clickhouses',
];

async function drainWithConcurrency(items, concurrency, handler) {
  const queue = [...items];
  const workerCount = Math.max(1, Math.min(concurrency, queue.length || 1));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item === undefined) {
          return;
        }
        await handler(item);
      }
    })
  );
}

export function normalizeProject(item) {
  return {
    uuid: item?.uuid || '',
    name: item?.name || '',
    description: item?.description || '',
  };
}

export function normalizeResource(item, type, projectIndex) {
  const parsed = parseResourceStatus(item?.status);
  const mapping = projectIndex?.get(item?.uuid) || {};

  return {
    uuid: item?.uuid || '',
    name: item?.name || '',
    type,
    description: item?.description || '',
    status: item?.status || 'unknown',
    statusBucket: parsed.bucket,
    containerStatus: parsed.container,
    healthStatus: parsed.health,
    environment: mapping.environment || item?.environment_name || '',
    project: mapping.project || item?.project_name || '',
    serverUuid: item?.server_uuid || item?.destination?.server?.uuid || '',
  };
}

export async function fetchResources(client, logger = console) {
  const projectIndex = await buildProjectIndex(client, logger).catch(() => new Map());

  const [applications, services, databases] = await Promise.all([
    client.call('/applications').catch(() => []),
    client.call('/services').catch(() => []),
    client.call('/databases').catch(() => []),
  ]);

  const toList = (payload, type) =>
    Array.isArray(payload)
      ? payload.map((item) => normalizeResource(item, type, projectIndex))
      : [];

  return {
    applications: toList(applications, 'application'),
    services: toList(services, 'service'),
    databases: toList(databases, 'database'),
  };
}

const ALLOWED_ACTIONS_BY_TYPE = {
  application: new Set(['start', 'stop', 'restart', 'deploy']),
  service: new Set(['start', 'stop', 'restart']),
  database: new Set(['start', 'stop', 'restart']),
};

const COLLECTION_BY_TYPE = {
  application: 'applications',
  service: 'services',
  database: 'databases',
};

export function assertActionAllowed(resourceType, action) {
  const collection = COLLECTION_BY_TYPE[resourceType];
  if (!collection) {
    throw new CoolifyRequestError('resourceType invalido.', 400);
  }

  const allowed = ALLOWED_ACTIONS_BY_TYPE[resourceType];
  if (!allowed.has(action)) {
    throw new CoolifyRequestError(
      `Acao "${action}" nao suportada para ${resourceType}.`,
      400
    );
  }

  return collection;
}

export async function executeAction(client, { resourceType, uuid, action }) {
  const collection = assertActionAllowed(resourceType, action);

  if (!uuid) {
    throw new CoolifyRequestError('uuid do recurso e obrigatorio.', 400);
  }

  try {
    // Actions mutate state: never serve them from cache.
    if (resourceType === 'application' && action === 'deploy') {
      const payload = await client.call(`/deploy?uuid=${encodeURIComponent(uuid)}`, {
        cacheTtlMs: 0,
      });
      return payload?.message || 'Deploy solicitado.';
    }

    const payload = await client.call(
      `/${collection}/${encodeURIComponent(uuid)}/${action}`,
      { cacheTtlMs: 0 }
    );
    return payload?.message || `${action} solicitado.`;
  } finally {
    // Invalidate even on failure: the action may have partially applied.
    invalidateResourceCache();
  }
}

export function clampPaging(rawSkip, rawTake, { defaultTake = 20, maxTake = 100 } = {}) {
  const parsedSkip = Number(rawSkip);
  const parsedTake = Number(rawTake);

  const skip = Number.isFinite(parsedSkip) ? Math.max(0, Math.trunc(parsedSkip)) : 0;
  const take = Number.isFinite(parsedTake)
    ? Math.min(maxTake, Math.max(1, Math.trunc(parsedTake)))
    : defaultTake;

  return { skip, take };
}
