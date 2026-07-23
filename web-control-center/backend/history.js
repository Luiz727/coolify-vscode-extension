/**
 * Optional history store (Postgres provisioned in Coolify).
 *
 * The Coolify API is a snapshot: it tells you what is happening now and
 * nothing about what happened yesterday. Uptime, MTTR, deploy success rate and
 * flapping detection all need our own timeline, which lives here.
 *
 * When HISTORY_DATABASE_URL is absent every function becomes a no-op and the
 * console keeps working — history is an enhancement, never a hard dependency.
 */

const RETENTION_DAYS = Number(process.env.HISTORY_RETENTION_DAYS || 90);

let pool = null;
let enabled = false;
let initError = '';

export function isHistoryEnabled() {
  return enabled;
}

export function getHistoryStatus() {
  return {
    enabled,
    error: initError || undefined,
    retentionDays: RETENTION_DAYS,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS resource_status_snapshot (
  id            BIGSERIAL PRIMARY KEY,
  resource_uuid TEXT        NOT NULL,
  resource_name TEXT        NOT NULL,
  resource_type TEXT        NOT NULL,
  bucket        TEXT        NOT NULL,
  health        TEXT,
  raw_status    TEXT,
  server_uuid   TEXT,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_status_resource_time
  ON resource_status_snapshot (resource_uuid, observed_at DESC);

CREATE TABLE IF NOT EXISTS deployment_history (
  deployment_uuid  TEXT PRIMARY KEY,
  application_uuid TEXT NOT NULL,
  application_name TEXT,
  status           TEXT NOT NULL,
  commit_sha       TEXT,
  commit_message   TEXT,
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  duration_ms      BIGINT,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deploy_app_time
  ON deployment_history (application_uuid, started_at DESC);

CREATE TABLE IF NOT EXISTS vps_metric_sample (
  id            BIGSERIAL PRIMARY KEY,
  vm_id         TEXT        NOT NULL,
  cpu_pct       DOUBLE PRECISION,
  ram_pct       DOUBLE PRECISION,
  disk_pct      DOUBLE PRECISION,
  net_in        DOUBLE PRECISION,
  net_out       DOUBLE PRECISION,
  uptime_s      BIGINT,
  collected_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_metric_vm_time
  ON vps_metric_sample (vm_id, collected_at DESC);

CREATE TABLE IF NOT EXISTS server_vm_link (
  server_uuid TEXT PRIMARY KEY,
  vm_id       TEXT NOT NULL,
  link_source TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function initHistory(logger = console) {
  const connectionString = String(process.env.HISTORY_DATABASE_URL || '').trim();

  if (!connectionString) {
    logger.log?.(
      '[history] HISTORY_DATABASE_URL ausente — historico desativado (painel opera normalmente).'
    );
    return false;
  }

  try {
    // Imported lazily so the dependency is only needed when history is used.
    const { default: pg } = await import('pg');
    pool = new pg.Pool({
      connectionString,
      max: Number(process.env.HISTORY_POOL_MAX || 4),
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 30000,
    });

    await pool.query(SCHEMA);
    enabled = true;
    initError = '';
    logger.log?.('[history] conectado ao Postgres e schema garantido.');
    return true;
  } catch (error) {
    enabled = false;
    initError = error.message;
    pool = null;
    // Degrade cleanly: a broken history store must not take the console down.
    logger.error?.(
      `[history] falha ao inicializar (${error.message}). Historico desativado; o painel continua operando.`
    );
    return false;
  }
}

async function run(query, params = []) {
  if (!enabled || !pool) {
    return { rows: [] };
  }

  try {
    return await pool.query(query, params);
  } catch (error) {
    console.error('[history] query falhou', error.message);
    return { rows: [] };
  }
}

/**
 * Records only transitions, not every poll.
 * At one sample per 15s a busy fleet would otherwise add millions of identical
 * rows per week; what matters is when a resource *changed* state.
 */
const lastKnownBucket = new Map();

export async function recordResourceStates(resources) {
  if (!enabled) {
    return 0;
  }

  const changed = resources.filter((resource) => {
    const previous = lastKnownBucket.get(resource.uuid);
    return previous !== resource.statusBucket;
  });

  if (changed.length === 0) {
    return 0;
  }

  const values = [];
  const placeholders = changed.map((resource, index) => {
    const base = index * 7;
    values.push(
      resource.uuid,
      resource.name,
      resource.type,
      resource.statusBucket,
      resource.healthStatus || null,
      resource.status || null,
      resource.serverUuid || null
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
  });

  await run(
    `INSERT INTO resource_status_snapshot
       (resource_uuid, resource_name, resource_type, bucket, health, raw_status, server_uuid)
     VALUES ${placeholders.join(', ')}`,
    values
  );

  for (const resource of changed) {
    lastKnownBucket.set(resource.uuid, resource.statusBucket);
  }

  return changed.length;
}

export async function recordDeployment(deployment) {
  if (!enabled || !deployment?.uuid) {
    return;
  }

  await run(
    `INSERT INTO deployment_history
       (deployment_uuid, application_uuid, application_name, status,
        commit_sha, commit_message, started_at, finished_at, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (deployment_uuid) DO UPDATE SET
       status      = EXCLUDED.status,
       finished_at = EXCLUDED.finished_at,
       duration_ms = EXCLUDED.duration_ms`,
    [
      deployment.uuid,
      deployment.applicationUuid,
      deployment.applicationName || null,
      deployment.status,
      deployment.commit || null,
      deployment.commitMessage || null,
      deployment.startedAt || null,
      deployment.finishedAt || null,
      deployment.durationMs || null,
    ]
  );
}

export async function recordVpsMetrics(vmId, metrics) {
  if (!enabled || !vmId) {
    return;
  }

  await run(
    `INSERT INTO vps_metric_sample
       (vm_id, cpu_pct, ram_pct, disk_pct, net_in, net_out, uptime_s)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      vmId,
      metrics.cpuPct,
      metrics.ramPct,
      metrics.diskPct,
      metrics.netIn,
      metrics.netOut,
      metrics.uptimeSeconds,
    ]
  );
}

export async function saveServerVmLinks(links) {
  if (!enabled || links.length === 0) {
    return;
  }

  for (const link of links) {
    if (!link.vmId) {
      continue;
    }
    await run(
      `INSERT INTO server_vm_link (server_uuid, vm_id, link_source, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (server_uuid) DO UPDATE SET
         vm_id       = EXCLUDED.vm_id,
         link_source = EXCLUDED.link_source,
         updated_at  = now()`,
      [link.serverUuid, link.vmId, link.linkSource]
    );
  }
}

export async function getManualLinks() {
  const { rows } = await run(
    `SELECT server_uuid, vm_id FROM server_vm_link WHERE link_source = 'manual'`
  );
  return Object.fromEntries(rows.map((row) => [row.server_uuid, row.vm_id]));
}

/**
 * Uptime per resource over a window.
 *
 * Computed from state transitions: each snapshot is valid until the next one,
 * so the time spent in "running" divided by the window is availability.
 */
export async function getUptimeByResource(windowHours = 24) {
  // Snapshots are written only on transitions, so a resource that stayed up
  // all week has NO rows inside a 24h window. Seeding each resource with the
  // state it carried into the window is what makes a stable resource report
  // 100% instead of disappearing from the report entirely.
  const { rows } = await run(
    `WITH window_start AS (
       SELECT (now() - ($1 || ' hours')::interval) AS ts
     ),
     carried AS (
       SELECT DISTINCT ON (s.resource_uuid)
              s.resource_uuid,
              s.resource_name,
              s.resource_type,
              s.bucket,
              (SELECT ts FROM window_start) AS observed_at
       FROM resource_status_snapshot s
       WHERE s.observed_at < (SELECT ts FROM window_start)
       ORDER BY s.resource_uuid, s.observed_at DESC
     ),
     inside AS (
       SELECT resource_uuid, resource_name, resource_type, bucket, observed_at
       FROM resource_status_snapshot
       WHERE observed_at >= (SELECT ts FROM window_start)
     ),
     combined AS (
       SELECT * FROM carried
       UNION ALL
       SELECT * FROM inside
     ),
     ordered AS (
       SELECT resource_uuid,
              resource_name,
              resource_type,
              bucket,
              observed_at,
              LEAD(observed_at, 1, now()) OVER (
                PARTITION BY resource_uuid ORDER BY observed_at
              ) AS next_at
       FROM combined
     )
     SELECT resource_uuid,
            MAX(resource_name) AS resource_name,
            MAX(resource_type) AS resource_type,
            SUM(EXTRACT(EPOCH FROM (next_at - observed_at))) AS total_seconds,
            SUM(CASE WHEN bucket = 'running'
                     THEN EXTRACT(EPOCH FROM (next_at - observed_at))
                     ELSE 0 END) AS up_seconds
     FROM ordered
     GROUP BY resource_uuid`,
    [String(windowHours)]
  );

  return rows.map((row) => {
    const total = Number(row.total_seconds) || 0;
    const up = Number(row.up_seconds) || 0;
    return {
      resourceUuid: row.resource_uuid,
      resourceName: row.resource_name,
      resourceType: row.resource_type,
      uptimePct: total > 0 ? Number(((up / total) * 100).toFixed(2)) : null,
      observedSeconds: total,
    };
  });
}

/**
 * Mean time to recovery: average gap between falling out of "running" and
 * coming back to it.
 */
export async function getMeanTimeToRecovery(windowHours = 168) {
  const { rows } = await run(
    `WITH ordered AS (
       SELECT resource_uuid,
              bucket,
              observed_at,
              LEAD(bucket)       OVER (PARTITION BY resource_uuid ORDER BY observed_at) AS next_bucket,
              LEAD(observed_at)  OVER (PARTITION BY resource_uuid ORDER BY observed_at) AS next_at
       FROM resource_status_snapshot
       WHERE observed_at >= now() - ($1 || ' hours')::interval
     )
     SELECT resource_uuid,
            AVG(EXTRACT(EPOCH FROM (next_at - observed_at))) AS mttr_seconds,
            COUNT(*) AS incidents
     FROM ordered
     WHERE bucket IN ('error', 'stopped', 'degraded')
       AND next_bucket = 'running'
     GROUP BY resource_uuid`,
    [String(windowHours)]
  );

  return rows.map((row) => ({
    resourceUuid: row.resource_uuid,
    mttrSeconds: Math.round(Number(row.mttr_seconds) || 0),
    incidents: Number(row.incidents) || 0,
  }));
}

export async function getDeploymentStats(windowHours = 168) {
  const { rows } = await run(
    `SELECT application_uuid,
            MAX(application_name) AS application_name,
            COUNT(*)                                                   AS total,
            COUNT(*) FILTER (WHERE status ILIKE '%finish%'
                                OR status ILIKE '%success%')            AS succeeded,
            COUNT(*) FILTER (WHERE status ILIKE '%fail%'
                                OR status ILIKE '%error%')              AS failed,
            AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL)     AS avg_duration_ms
     FROM deployment_history
     WHERE started_at >= now() - ($1 || ' hours')::interval
     GROUP BY application_uuid`,
    [String(windowHours)]
  );

  return rows.map((row) => {
    const total = Number(row.total) || 0;
    const succeeded = Number(row.succeeded) || 0;
    return {
      applicationUuid: row.application_uuid,
      applicationName: row.application_name,
      total,
      succeeded,
      failed: Number(row.failed) || 0,
      successRatePct: total > 0 ? Number(((succeeded / total) * 100).toFixed(1)) : null,
      avgDurationMs: row.avg_duration_ms ? Math.round(Number(row.avg_duration_ms)) : null,
    };
  });
}

/** Resources bouncing between states — usually a crash loop worth attention. */
export async function getFlappingResources(windowMinutes = 60, minTransitions = 4) {
  const { rows } = await run(
    `SELECT resource_uuid,
            MAX(resource_name) AS resource_name,
            COUNT(*)           AS transitions
     FROM resource_status_snapshot
     WHERE observed_at >= now() - ($1 || ' minutes')::interval
     GROUP BY resource_uuid
     HAVING COUNT(*) >= $2
     ORDER BY transitions DESC`,
    [String(windowMinutes), minTransitions]
  );

  return rows.map((row) => ({
    resourceUuid: row.resource_uuid,
    resourceName: row.resource_name,
    transitions: Number(row.transitions) || 0,
  }));
}

export async function getVpsMetricSeries(vmId, windowHours = 24) {
  const { rows } = await run(
    `SELECT cpu_pct, ram_pct, disk_pct, net_in, net_out, collected_at
     FROM vps_metric_sample
     WHERE vm_id = $1 AND collected_at >= now() - ($2 || ' hours')::interval
     ORDER BY collected_at ASC`,
    [vmId, String(windowHours)]
  );

  return rows.map((row) => ({
    t: row.collected_at,
    cpu: row.cpu_pct,
    ram: row.ram_pct,
    disk: row.disk_pct,
    netIn: row.net_in,
    netOut: row.net_out,
  }));
}

export async function pruneOldData() {
  if (!enabled) {
    return;
  }

  await run(
    `DELETE FROM resource_status_snapshot WHERE observed_at < now() - ($1 || ' days')::interval`,
    [String(RETENTION_DAYS)]
  );
  await run(
    `DELETE FROM vps_metric_sample WHERE collected_at < now() - ($1 || ' days')::interval`,
    [String(RETENTION_DAYS)]
  );
  await run(
    `DELETE FROM deployment_history WHERE recorded_at < now() - ($1 || ' days')::interval`,
    [String(RETENTION_DAYS)]
  );
}

export async function closeHistory() {
  if (pool) {
    await pool.end().catch(() => undefined);
    pool = null;
    enabled = false;
  }
}
