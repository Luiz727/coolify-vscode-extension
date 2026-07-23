/**
 * Deployment identity and log normalisation.
 *
 * Coolify's deployment object carries two identifiers: a numeric `id` (the
 * database primary key) and a `deployment_uuid`. Every API route that takes a
 * deployment — `GET /deployments/{uuid}` and `POST /deployments/{uuid}/cancel`
 * — expects the UUID. Passing the numeric id yields a 404, which is why
 * cancelling a deployment and opening its details used to fail silently.
 */

export interface DeploymentIdentityLike {
  id?: string | number;
  deployment_uuid?: string | number;
}

/** The identifier the Coolify API accepts. Always prefer the UUID. */
export function resolveDeploymentId(deployment: DeploymentIdentityLike): string {
  const uuid = deployment?.deployment_uuid;
  if (typeof uuid === 'string' && uuid.trim().length > 0) {
    return uuid.trim();
  }
  if (typeof uuid === 'number' && Number.isFinite(uuid)) {
    return String(uuid);
  }

  const id = deployment?.id;
  if (typeof id === 'string' && id.trim().length > 0) {
    return id.trim();
  }
  if (typeof id === 'number' && Number.isFinite(id)) {
    return String(id);
  }

  return '';
}

/** Every identifier a deployment may be known by, for reverse lookups. */
export function deploymentIdCandidates(
  deployment: DeploymentIdentityLike
): string[] {
  const candidates = new Set<string>();

  for (const value of [deployment?.deployment_uuid, deployment?.id]) {
    if (typeof value === 'string' && value.trim().length > 0) {
      candidates.add(value.trim());
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      candidates.add(String(value));
    }
  }

  return Array.from(candidates);
}

interface MergeableDeployment extends DeploymentIdentityLike {
  created_at?: string;
  isRunning?: boolean;
}

/**
 * Merges live deployments with historical ones.
 *
 * A deployment can appear in both lists; the live entry wins so the UI can tell
 * "running now" from "ran earlier". Results are newest-first.
 */
export function mergeDeployments<T extends MergeableDeployment>(
  running: T[],
  history: T[]
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];

  const push = (deployment: T, isRunning: boolean) => {
    const key = resolveDeploymentId(deployment);
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push({ ...deployment, isRunning });
  };

  running.forEach((deployment) => push(deployment, true));
  history.forEach((deployment) => push(deployment, false));

  return merged.sort(
    (a, b) =>
      new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
  );
}

interface DeploymentLogEntry {
  output?: unknown;
  order?: unknown;
}

/**
 * Coolify stores deployment logs as a JSON-encoded array of entries.
 * Rendering that raw shows the operator JSON instead of logs, so decode it
 * when possible and fall back to the original text when it is already plain.
 */
export function normalizeDeploymentLogs(rawLogs: unknown): string {
  if (typeof rawLogs !== 'string' || !rawLogs.trim()) {
    return '';
  }

  try {
    const parsed = JSON.parse(rawLogs) as unknown;
    if (!Array.isArray(parsed)) {
      return rawLogs;
    }

    return (parsed as Array<DeploymentLogEntry | string>)
      .slice()
      .sort((a, b) => {
        const orderA = typeof a === 'object' && a ? Number(a.order ?? 0) : 0;
        const orderB = typeof b === 'object' && b ? Number(b.order ?? 0) : 0;
        return orderA - orderB;
      })
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
 * Timestamp helper that never produces "Invalid Date" in the UI.
 * Returns an empty string when the input cannot be parsed.
 */
export function formatTimestamp(value: unknown, locale?: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }

  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return '';
  }

  return new Date(timestamp).toLocaleString(locale);
}
