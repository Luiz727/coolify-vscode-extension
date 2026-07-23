/**
 * Single source of truth for Coolify resource status.
 *
 * Coolify reports status as `<container>:<health>` (e.g. `running:unhealthy`).
 * The health suffix is not decoration: a container that is up but failing its
 * healthcheck is degraded, not healthy.
 *
 * Keep this behaviourally identical to web-control-center/backend/status.js —
 * the two products must never disagree about whether a resource is healthy.
 */

export type StatusBucket =
  | 'error'
  | 'degraded'
  | 'stopped'
  | 'starting'
  | 'unknown'
  | 'running';

export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';

export interface ParsedResourceStatus {
  raw: string;
  container: string;
  health: HealthStatus;
  bucket: StatusBucket;
}

export const STATUS_BUCKETS: StatusBucket[] = [
  'error',
  'degraded',
  'stopped',
  'starting',
  'unknown',
  'running',
];

/** Problems first — an operator scans this list to find what is broken. */
export const STATUS_ORDER: Record<StatusBucket, number> = {
  error: 0,
  degraded: 1,
  stopped: 2,
  starting: 3,
  unknown: 4,
  running: 5,
};

const CONTAINER_BUCKET: Record<string, StatusBucket> = {
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

function normalizeHealth(rawHealth: string, rawStatus: string): HealthStatus {
  const candidate = rawHealth || rawStatus;

  // Order matters: "unhealthy" contains "healthy", so the negative case wins.
  if (candidate.includes('unhealthy')) {
    return 'unhealthy';
  }
  if (candidate.includes('healthy')) {
    return 'healthy';
  }
  return 'unknown';
}

export function parseResourceStatus(rawValue: unknown): ParsedResourceStatus {
  const raw = String(rawValue ?? '').trim().toLowerCase();

  if (!raw) {
    return { raw: '', container: 'unknown', health: 'unknown', bucket: 'unknown' };
  }

  const separatorIndex = raw.indexOf(':');
  const container = (separatorIndex >= 0 ? raw.slice(0, separatorIndex) : raw).trim();
  const healthPart = separatorIndex >= 0 ? raw.slice(separatorIndex + 1).trim() : '';
  const health = normalizeHealth(healthPart, raw);

  let bucket = CONTAINER_BUCKET[container];

  if (!bucket) {
    bucket =
      raw.includes('error') || raw.includes('fail') || raw.includes('crash')
        ? 'error'
        : 'unknown';
  }

  // A container that is up but failing its healthcheck is degraded, never running.
  if (bucket === 'running' && health === 'unhealthy') {
    bucket = 'degraded';
  }

  return { raw, container: container || 'unknown', health, bucket };
}

export function statusBucket(rawValue: unknown): StatusBucket {
  return parseResourceStatus(rawValue).bucket;
}

/** True when the resource is in a state an operator should look at. */
export function needsAttention(rawValue: unknown): boolean {
  const bucket = statusBucket(rawValue);
  return bucket === 'error' || bucket === 'degraded';
}

export function compareStatusBuckets(a: StatusBucket, b: StatusBucket): number {
  return (STATUS_ORDER[a] ?? 99) - (STATUS_ORDER[b] ?? 99);
}
