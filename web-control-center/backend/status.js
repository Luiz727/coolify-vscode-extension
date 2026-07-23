/**
 * Single source of truth for Coolify resource status.
 *
 * Coolify reports status as `<container>:<health>` (e.g. `running:unhealthy`).
 * The health suffix is NOT decoration: a container that is up but failing its
 * healthcheck is degraded, not healthy. Treating `running:unhealthy` as green
 * is what made the web console disagree with the VS Code sidebar.
 *
 * Keep this file byte-identical in behaviour with src/utils/resourceStatus.ts.
 */

export const STATUS_BUCKETS = [
  'error',
  'degraded',
  'stopped',
  'starting',
  'unknown',
  'running',
];

/** Problems first — an operations console must surface what needs attention. */
export const STATUS_ORDER = {
  error: 0,
  degraded: 1,
  stopped: 2,
  starting: 3,
  unknown: 4,
  running: 5,
};

const CONTAINER_BUCKET = {
  running: 'running',
  healthy: 'running',
  starting: 'starting',
  restarting: 'starting',
  created: 'starting',
  initializing: 'starting',
  degraded: 'degraded',
  exited: 'stopped',
  stopped: 'stopped',
  paused: 'stopped',
  removing: 'stopped',
  dead: 'error',
  error: 'error',
  failed: 'error',
};

function normalizeHealth(rawHealth, rawStatus) {
  if (rawHealth) {
    return rawHealth;
  }

  // Order matters: "unhealthy" contains "healthy", so the negative case wins.
  if (rawStatus.includes('unhealthy')) {
    return 'unhealthy';
  }
  if (rawStatus.includes('healthy')) {
    return 'healthy';
  }
  return 'unknown';
}

export function parseResourceStatus(rawValue) {
  const raw = String(rawValue || '').trim().toLowerCase();

  if (!raw) {
    return { raw: '', container: 'unknown', health: 'unknown', bucket: 'unknown' };
  }

  const separatorIndex = raw.indexOf(':');
  const container = (separatorIndex >= 0 ? raw.slice(0, separatorIndex) : raw).trim();
  const healthPart = separatorIndex >= 0 ? raw.slice(separatorIndex + 1).trim() : '';
  const health = normalizeHealth(healthPart, raw);

  let bucket = CONTAINER_BUCKET[container];

  if (!bucket) {
    if (raw.includes('error') || raw.includes('fail') || raw.includes('crash')) {
      bucket = 'error';
    } else {
      bucket = 'unknown';
    }
  }

  // A container that is up but failing its healthcheck is degraded, never running.
  if (bucket === 'running' && health === 'unhealthy') {
    bucket = 'degraded';
  }

  return { raw, container: container || 'unknown', health, bucket };
}

export function statusBucket(rawValue) {
  return parseResourceStatus(rawValue).bucket;
}

export function compareByStatus(a, b) {
  const delta = (STATUS_ORDER[a] ?? 99) - (STATUS_ORDER[b] ?? 99);
  return delta;
}

export function emptyStatusSummary() {
  return STATUS_BUCKETS.reduce(
    (acc, bucket) => {
      acc[bucket] = 0;
      return acc;
    },
    { total: 0 }
  );
}
