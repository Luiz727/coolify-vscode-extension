/**
 * Hostinger VPS API client.
 *
 * Coolify only sees inside the containers — it cannot tell you the machine ran
 * out of RAM or filled its disk. This module supplies that missing layer:
 * CPU, memory, disk and network for the VPS itself.
 *
 * Docs: https://developers.hostinger.com
 *
 * SECURITY: HOSTINGER_API_TOKEN grants control over the entire Hostinger
 * account, including destroying machines. It lives only here, on the server,
 * and is never serialised into a response.
 */

const API_BASE = 'https://developers.hostinger.com';
const DEFAULT_TIMEOUT_MS = 20000;

export class HostingerError extends Error {
  constructor(message, status, endpoint) {
    super(message);
    this.name = 'HostingerError';
    this.status = status;
    this.endpoint = endpoint;
  }
}

export function isHostingerEnabled(env = process.env) {
  return Boolean(String(env.HOSTINGER_API_TOKEN || '').trim());
}

export function createHostingerClient({ token, logger = console }) {
  const authToken = String(token || '').trim();

  /**
   * Rate-limit state. Hostinger answers 429 with limit headers; hammering it
   * after that just extends the block, so we hold off until the reset.
   */
  let blockedUntil = 0;

  async function call(pathValue, options = {}) {
    if (!authToken) {
      throw new HostingerError('Integracao Hostinger nao configurada.', 503, pathValue);
    }

    if (Date.now() < blockedUntil) {
      const seconds = Math.ceil((blockedUntil - Date.now()) / 1000);
      throw new HostingerError(
        `Limite de requisicoes da Hostinger atingido. Aguarde ${seconds}s.`,
        429,
        pathValue
      );
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(`${API_BASE}${pathValue}`, {
        method: options.method || 'GET',
        headers: {
          Authorization: `Bearer ${authToken}`,
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after')) || 60;
        blockedUntil = Date.now() + retryAfter * 1000;
        throw new HostingerError(
          `Limite de requisicoes da Hostinger atingido. Aguarde ${retryAfter}s.`,
          429,
          pathValue
        );
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        // Logged in full server-side; the browser gets a sanitised message.
        logger.error?.(
          `[hostinger] ${options.method || 'GET'} ${pathValue} -> ${response.status}: ${body.slice(0, 400)}`
        );
        throw new HostingerError(
          describeStatus(response.status),
          response.status,
          pathValue
        );
      }

      if (response.status === 204) {
        return null;
      }

      const contentType = response.headers.get('content-type') || '';
      return contentType.includes('application/json')
        ? await response.json()
        : { raw: await response.text() };
    } catch (error) {
      if (error instanceof HostingerError) {
        throw error;
      }
      if (error?.name === 'AbortError') {
        throw new HostingerError(
          `Tempo limite excedido ao falar com a Hostinger.`,
          504,
          pathValue
        );
      }
      logger.error?.(`[hostinger] ${pathValue} falhou`, error);
      throw new HostingerError('Falha de rede ao comunicar com a Hostinger.', 502, pathValue);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function describeStatus(status) {
    if (status === 401) return 'Token da Hostinger invalido ou expirado.';
    if (status === 403) return 'Token da Hostinger sem permissao para esta acao.';
    if (status === 404) return 'Recurso nao encontrado na Hostinger.';
    if (status >= 500) return 'Hostinger indisponivel ou com erro interno.';
    return `Erro inesperado da Hostinger (${status}).`;
  }

  // ----------------------------------------------------------------- reads

  async function listVirtualMachines() {
    const payload = await call('/api/vps/v1/virtual-machines');
    const items = Array.isArray(payload) ? payload : payload?.data || [];
    return items.map(normalizeVirtualMachine);
  }

  async function getVirtualMachine(vmId) {
    const payload = await call(
      `/api/vps/v1/virtual-machines/${encodeURIComponent(vmId)}`
    );
    return normalizeVirtualMachine(payload?.data || payload);
  }

  /**
   * Historical CPU / RAM / disk / network for a machine.
   * Hostinger takes an ISO window through date_from / date_to.
   */
  async function getMetrics(vmId, { from, to } = {}) {
    const dateTo = to || new Date().toISOString();
    const dateFrom =
      from || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const query = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
    const payload = await call(
      `/api/vps/v1/virtual-machines/${encodeURIComponent(vmId)}/metrics?${query}`
    );

    return normalizeMetrics(payload?.data || payload);
  }

  async function listActions(vmId) {
    const payload = await call(
      `/api/vps/v1/virtual-machines/${encodeURIComponent(vmId)}/actions`
    );
    return Array.isArray(payload) ? payload : payload?.data || [];
  }

  async function getAction(vmId, actionId) {
    return call(
      `/api/vps/v1/virtual-machines/${encodeURIComponent(vmId)}/actions/${encodeURIComponent(actionId)}`
    );
  }

  async function getSnapshot(vmId) {
    return call(`/api/vps/v1/virtual-machines/${encodeURIComponent(vmId)}/snapshot`);
  }

  async function listBackups(vmId) {
    const payload = await call(
      `/api/vps/v1/virtual-machines/${encodeURIComponent(vmId)}/backups`
    );
    return Array.isArray(payload) ? payload : payload?.data || [];
  }

  // ---------------------------------------------------------------- writes
  //
  // Every one of these is destructive at the machine level. The HTTP layer in
  // server.js enforces typed confirmation, blast-radius display and an audit
  // entry written BEFORE the call — this module only performs the request.

  async function powerAction(vmId, action) {
    if (!['start', 'stop', 'restart'].includes(action)) {
      throw new HostingerError('Acao de energia invalida.', 400);
    }
    return call(
      `/api/vps/v1/virtual-machines/${encodeURIComponent(vmId)}/${action}`,
      { method: 'POST' }
    );
  }

  async function createSnapshot(vmId) {
    return call(
      `/api/vps/v1/virtual-machines/${encodeURIComponent(vmId)}/snapshot`,
      { method: 'POST' }
    );
  }

  async function deleteSnapshot(vmId) {
    return call(
      `/api/vps/v1/virtual-machines/${encodeURIComponent(vmId)}/snapshot`,
      { method: 'DELETE' }
    );
  }

  /** Rolls the whole machine back in time. Data written after the snapshot is lost. */
  async function restoreSnapshot(vmId) {
    return call(
      `/api/vps/v1/virtual-machines/${encodeURIComponent(vmId)}/snapshot/restore`,
      { method: 'POST' }
    );
  }

  /** Same irreversibility as restoreSnapshot, from a dated backup. */
  async function restoreBackup(vmId, backupId) {
    return call(
      `/api/vps/v1/virtual-machines/${encodeURIComponent(vmId)}/backups/${encodeURIComponent(backupId)}/restore`,
      { method: 'POST' }
    );
  }

  return {
    listVirtualMachines,
    getVirtualMachine,
    getMetrics,
    listActions,
    getAction,
    getSnapshot,
    listBackups,
    powerAction,
    createSnapshot,
    deleteSnapshot,
    restoreSnapshot,
    restoreBackup,
  };
}

function normalizeVirtualMachine(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  return {
    id: String(item.id ?? item.uuid ?? ''),
    hostname: item.hostname || item.name || '',
    state: item.state || item.status || 'unknown',
    ipv4: extractIpv4(item),
    plan: item.plan || item.plan_name || '',
    cpus: Number(item.cpus) || null,
    memoryMb: Number(item.memory) || null,
    diskMb: Number(item.disk) || null,
    createdAt: item.created_at || null,
  };
}

function extractIpv4(item) {
  if (typeof item.ipv4 === 'string') {
    return item.ipv4;
  }
  if (Array.isArray(item.ipv4) && item.ipv4.length > 0) {
    const first = item.ipv4[0];
    return typeof first === 'string' ? first : first?.address || '';
  }
  return item.ip || item.main_ip || '';
}

/**
 * Reduces Hostinger's metric series to the latest reading plus the series
 * itself, so the UI can show both a number and a chart.
 */
function normalizeMetrics(payload) {
  if (!payload || typeof payload !== 'object') {
    return { cpuPct: null, ramPct: null, diskPct: null, netIn: null, netOut: null, uptimeSeconds: null, series: {} };
  }

  const series = {
    cpu: toSeries(payload.cpu_usage),
    ram: toSeries(payload.ram_usage),
    disk: toSeries(payload.disk_usage ?? payload.disk_space),
    netIn: toSeries(payload.incoming_traffic),
    netOut: toSeries(payload.outgoing_traffic),
  };

  return {
    cpuPct: latestValue(series.cpu),
    ramPct: latestValue(series.ram),
    diskPct: latestValue(series.disk),
    netIn: latestValue(series.netIn),
    netOut: latestValue(series.netOut),
    uptimeSeconds: readNumber(payload.uptime?.usage ?? payload.uptime),
    series,
  };
}

function toSeries(node) {
  if (!node) {
    return [];
  }

  const usage = node.usage ?? node;

  // Shape 1: { "2026-07-23T10:00:00Z": 42, ... }
  if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
    return Object.entries(usage)
      .map(([timestamp, value]) => ({ t: timestamp, v: readNumber(value) }))
      .filter((point) => point.v !== null)
      .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
  }

  // Shape 2: [{ timestamp, value }] or [[timestamp, value]]
  if (Array.isArray(usage)) {
    return usage
      .map((point) => {
        if (Array.isArray(point)) {
          return { t: point[0], v: readNumber(point[1]) };
        }
        return {
          t: point?.timestamp ?? point?.date ?? point?.t,
          v: readNumber(point?.value ?? point?.usage ?? point?.v),
        };
      })
      .filter((point) => point.t && point.v !== null);
  }

  return [];
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function latestValue(series) {
  if (!Array.isArray(series) || series.length === 0) {
    return null;
  }
  return series[series.length - 1].v;
}

/**
 * Links each Coolify server to the Hostinger VM hosting it, by IP.
 *
 * This is the join that turns two disconnected dashboards into one diagnosis:
 * without it you know "7 apps are down", with it you know "7 apps are down
 * because the disk on srv-01 is full".
 */
export function correlateServersToVms(coolifyServers, virtualMachines, manualLinks = {}) {
  const byIp = new Map();
  for (const vm of virtualMachines) {
    if (vm?.ipv4) {
      byIp.set(String(vm.ipv4).trim(), vm);
    }
  }

  return coolifyServers.map((server) => {
    const manualVmId = manualLinks[server.uuid];
    const vm = manualVmId
      ? virtualMachines.find((candidate) => candidate.id === String(manualVmId))
      : byIp.get(String(server.ip || '').trim());

    return {
      serverUuid: server.uuid,
      serverName: server.name,
      serverIp: server.ip || '',
      vmId: vm?.id || null,
      vmHostname: vm?.hostname || null,
      linkSource: vm ? (manualVmId ? 'manual' : 'ip-match') : 'unlinked',
    };
  });
}

/**
 * Evaluates thresholds with hysteresis: a metric must stay over the limit for
 * several consecutive samples before it raises an alert, so a momentary spike
 * does not make the banner flash on and off.
 */
export function evaluateAlerts(metrics, thresholds, consecutiveBreaches = {}) {
  const alerts = [];
  const nextBreaches = { ...consecutiveBreaches };
  const required = thresholds.consecutiveSamples ?? 2;

  const checks = [
    { key: 'cpu', value: metrics.cpuPct, limit: thresholds.cpuPct, label: 'CPU' },
    { key: 'ram', value: metrics.ramPct, limit: thresholds.ramPct, label: 'memoria' },
    { key: 'disk', value: metrics.diskPct, limit: thresholds.diskPct, label: 'disco' },
  ];

  for (const check of checks) {
    if (check.value === null || check.value === undefined) {
      nextBreaches[check.key] = 0;
      continue;
    }

    if (check.value >= check.limit) {
      nextBreaches[check.key] = (nextBreaches[check.key] || 0) + 1;
      if (nextBreaches[check.key] >= required) {
        alerts.push({
          metric: check.key,
          label: check.label,
          value: check.value,
          limit: check.limit,
          message: `${check.label} em ${check.value.toFixed(0)}% (limite ${check.limit}%)`,
        });
      }
    } else {
      nextBreaches[check.key] = 0;
    }
  }

  return { alerts, breaches: nextBreaches };
}
