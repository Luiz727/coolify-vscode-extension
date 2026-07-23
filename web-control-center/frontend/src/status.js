/**
 * Mirror of web-control-center/backend/status.js.
 *
 * The backend already computes `statusBucket` for every resource; this module
 * exists so the UI can label, order and summarise buckets without inventing a
 * second taxonomy. Keep the bucket list in sync with the backend.
 */

export const STATUS_BUCKETS = [
  'error',
  'degraded',
  'stopped',
  'starting',
  'unknown',
  'running',
];

/** Problems first. An operator opens this screen to find what is broken. */
export const STATUS_ORDER = {
  error: 0,
  degraded: 1,
  stopped: 2,
  starting: 3,
  unknown: 4,
  running: 5,
};

export const STATUS_LABELS = {
  error: 'Erro',
  degraded: 'Degradado',
  stopped: 'Parados',
  starting: 'Iniciando',
  unknown: 'Desconhecido',
  running: 'Rodando',
};

/** Buckets that represent something an operator should look at. */
export const ATTENTION_BUCKETS = new Set(['error', 'degraded']);

export function emptySummary() {
  const summary = { total: 0 };
  for (const bucket of STATUS_BUCKETS) {
    summary[bucket] = 0;
  }
  return summary;
}

export function summarize(resources) {
  const summary = emptySummary();
  for (const resource of resources) {
    const bucket = STATUS_BUCKETS.includes(resource.statusBucket)
      ? resource.statusBucket
      : 'unknown';
    summary[bucket] += 1;
    summary.total += 1;
  }
  return summary;
}

export function compareResources(a, b) {
  const delta =
    (STATUS_ORDER[a.statusBucket] ?? 99) - (STATUS_ORDER[b.statusBucket] ?? 99);
  if (delta !== 0) {
    return delta;
  }
  return String(a.name).localeCompare(String(b.name));
}
