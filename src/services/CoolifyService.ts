import { CoolifyApiError, HttpClient } from './HttpClient';
import { logger } from './LoggerService';
import {
  isValidApplicationLifecycleResponse,
  isValidCoolifyApplication,
  isValidCoolifyProject,
  isValidCoolifyDeployment,
  isValidCoolifyDatabase,
  isValidCoolifyServer,
  isValidCoolifyService,
  isValidEnvironmentVariable,
  parseArrayPayload,
  parseObjectPayload,
} from '../utils/payloadGuards';
import {
  mergeDeployments,
  normalizeDeploymentLogs,
} from '../utils/deploymentIdentity';

export interface Application {
  uuid: string;
  name: string;
  status: string;
  git_branch: string;
  git_commit_sha: string;
  destination_type: string;
  fqdn: string;
  git_repository: string;
  updated_at: string;
  description: string;
}

export interface Deployment {
  id: string;
  deployment_uuid?: string;
  application_id: string;
  application_name: string;
  status: string;
  commit: string;
  created_at: string;
  deployment_url: string;
  commit_message: string;
  logs?: string;
  /** True when this deployment is currently executing (not historical). */
  isRunning?: boolean;
}

export interface ServiceResource {
  uuid: string;
  name: string;
  status: string;
  description?: string;
}

export interface DatabaseResource {
  uuid: string;
  name: string;
  status: string;
  description?: string;
}

/**
 * A *scheduled backup configuration*, not a stored backup file.
 *
 * `GET /databases/{uuid}/backups` returns schedules (frequency, enabled, S3
 * target). The actual backup runs live under `/backups/{uuid}/executions`.
 * Conflating the two used to make the UI show schedules as if they were
 * restorable backup files.
 */
export interface DatabaseBackupSchedule {
  uuid: string;
  frequency?: string;
  enabled?: boolean;
  saveS3?: boolean;
  databasesToBackup?: string;
  dumpAll?: boolean;
}

/** One actual backup run of a schedule. */
export interface DatabaseBackupExecution {
  uuid: string;
  status?: string;
  createdAt?: string;
  size?: string;
  message?: string;
  filename?: string;
}

export interface CreateBackupScheduleRequest {
  /** Required by the API: cron expression or daily/weekly/monthly/etc. */
  frequency: string;
  enabled?: boolean;
  save_s3?: boolean;
  s3_storage_uuid?: string;
  databases_to_backup?: string;
  dump_all?: boolean;
  backup_now?: boolean;
}

export interface ProjectResource {
  uuid: string;
  name: string;
  description?: string;
  environments?: unknown[];
}

/**
 * A machine registered in Coolify. The notification flags below are the
 * root-cause signals that explain why several resources went down at once.
 */
export interface ServerResource {
  uuid: string;
  name: string;
  description?: string;
  ip?: string;
  port?: number;
  user?: string;
  proxy_type?: string;
  unreachable_count?: number;
  unreachable_notification_sent?: boolean;
  high_disk_usage_notification_sent?: boolean;
  settings?: Record<string, unknown>;
  proxy?: Record<string, unknown>;
}

export interface ServerResourceItem {
  uuid: string;
  name: string;
  type: string;
  status: string;
}

export interface ApplicationLifecycleResponse {
  message?: string;
  deployment_uuid?: string;
}

/**
 * As returned by the API. `is_buildtime`/`is_runtime` exist on the model but
 * are NOT accepted on create/update requests — see the request types below.
 */
export interface EnvironmentVariable {
  uuid: string;
  key: string;
  value: string;
  is_buildtime?: boolean;
  is_preview?: boolean;
  is_literal?: boolean;
  is_multiline?: boolean;
  is_runtime?: boolean;
  is_shown_once?: boolean;
}

/**
 * Mirrors exactly the fields Coolify accepts on POST/PATCH
 * `/applications/{uuid}/envs`. The API rejects unknown fields with 422, so
 * sending `is_buildtime`/`is_runtime` here fails every single call.
 */
export interface EnvironmentVariableCreateRequest {
  key: string;
  value: string;
  is_preview?: boolean;
  is_literal?: boolean;
  is_multiline?: boolean;
  is_shown_once?: boolean;
}

/** `key` and `value` are both required by the API on update. */
export interface EnvironmentVariableUpdateRequest {
  key: string;
  value: string;
  is_preview?: boolean;
  is_literal?: boolean;
  is_multiline?: boolean;
  is_shown_once?: boolean;
}

/** Human-readable error detail, since Error objects serialize to `{}` in logs. */
function describeApiError(error: unknown): string {
  if (error instanceof CoolifyApiError) {
    const status = error.statusCode ? ` ${error.statusCode}` : '';
    const endpoint = error.endpoint ? ` (${error.endpoint})` : '';
    return `${error.type}${status}: ${error.message}${endpoint}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export class CoolifyService {
  private readonly client: HttpClient;

  constructor(private baseUrl: string, private token: string) {
    this.client = new HttpClient({
      baseUrl: this.baseUrl,
      token: this.token,
      timeoutMs: 10000,
    });
  }

  private async fetchWithAuth<T>(endpoint: string): Promise<T> {
    return this.client.get<T>(endpoint);
  }

  private async fetchValidatedArray<T>(
    endpoint: string,
    guard: (value: unknown) => value is T,
    entityName: string
  ): Promise<T[]> {
    const payload = await this.fetchWithAuth<unknown>(endpoint);
    const { items, invalidCount } = parseArrayPayload(payload, guard, entityName);

    if (invalidCount > 0) {
      logger.warn(`Ignoring invalid ${entityName} items from API response`, {
        entityName,
        invalidCount,
      });
    }

    return items;
  }

  private async fetchValidatedObject<T>(
    endpoint: string,
    guard: (value: unknown) => value is T,
    entityName: string
  ): Promise<T> {
    const payload = await this.fetchWithAuth<unknown>(endpoint);
    return parseObjectPayload(payload, guard, entityName);
  }

  private readString(
    candidate: Record<string, unknown>,
    ...keys: string[]
  ): string | undefined {
    for (const key of keys) {
      const value = candidate[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
      }
    }
    return undefined;
  }

  private mapBackupSchedule(value: unknown): DatabaseBackupSchedule | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const candidate = value as Record<string, unknown>;
    const uuid = this.readString(candidate, 'uuid', 'id');
    if (!uuid) {
      return undefined;
    }

    return {
      uuid,
      frequency: this.readString(candidate, 'frequency'),
      enabled: typeof candidate.enabled === 'boolean' ? candidate.enabled : undefined,
      saveS3: typeof candidate.save_s3 === 'boolean' ? candidate.save_s3 : undefined,
      databasesToBackup: this.readString(candidate, 'databases_to_backup'),
      dumpAll: typeof candidate.dump_all === 'boolean' ? candidate.dump_all : undefined,
    };
  }

  private mapBackupExecution(value: unknown): DatabaseBackupExecution | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const candidate = value as Record<string, unknown>;
    const uuid = this.readString(candidate, 'uuid', 'id');
    if (!uuid) {
      return undefined;
    }

    return {
      uuid,
      status: this.readString(candidate, 'status', 'state'),
      createdAt: this.readString(candidate, 'created_at', 'createdAt'),
      size: this.readString(candidate, 'size', 'file_size'),
      message: this.readString(candidate, 'message'),
      filename: this.readString(candidate, 'filename'),
    };
  }

  private toArrayPayload(payload: unknown): unknown[] {
    if (Array.isArray(payload)) {
      return payload;
    }

    if (payload && typeof payload === 'object') {
      const candidate = payload as Record<string, unknown>;
      const arrayLike = [
        candidate.backups,
        candidate.deployments,
        candidate.items,
        candidate.data,
      ].find((value) => Array.isArray(value));
      if (Array.isArray(arrayLike)) {
        return arrayLike;
      }
    }

    return [];
  }

  async getApplications(): Promise<Application[]> {
    return this.fetchValidatedArray(
      '/api/v1/applications',
      isValidCoolifyApplication,
      'applications'
    );
  }

  /**
   * IMPORTANT: `/deployments` only lists deployments that are running RIGHT
   * NOW. On an idle system it returns an empty array, which is why any screen
   * built solely on it looks broken. For history use getDeploymentHistory.
   */
  async getRunningDeployments(): Promise<Deployment[]> {
    return this.fetchValidatedArray(
      '/api/v1/deployments',
      isValidCoolifyDeployment,
      'deployments'
    );
  }

  /** @deprecated Use getRunningDeployments (running only) or getDeploymentHistory. */
  async getDeployments(): Promise<Deployment[]> {
    return this.getRunningDeployments();
  }

  /**
   * Recent deployments of each application.
   *
   * Costs one request per application, so callers should cache it rather than
   * run it on every refresh cycle. Concurrency is capped to avoid a burst.
   */
  async getDeploymentHistoryOnly(
    applicationUuids: string[],
    takePerApplication = 5,
    concurrency = 4
  ): Promise<Deployment[]> {
    const collected: Deployment[] = [];
    const queue = [...applicationUuids];
    // Aggregate failures into a single log line: one warning per application
    // per cycle floods the output and — because Error does not JSON-serialize —
    // each line said only `error: {}`, hiding the actual cause.
    let failureCount = 0;
    let firstError: unknown;

    const workers = Array.from(
      { length: Math.max(1, Math.min(concurrency, queue.length || 1)) },
      async () => {
        while (queue.length > 0) {
          const uuid = queue.shift();
          if (!uuid) {
            return;
          }

          try {
            const history = await this.getDeploymentsByApplication(
              uuid,
              0,
              takePerApplication
            );
            collected.push(...history);
          } catch (error) {
            failureCount += 1;
            if (firstError === undefined) {
              firstError = error;
            }
          }
        }
      }
    );

    await Promise.all(workers);

    if (failureCount > 0) {
      logger.warn('Deployment history unavailable for some applications', {
        failed: failureCount,
        total: applicationUuids.length,
        reason: describeApiError(firstError),
      });
    }

    return collected;
  }

  /**
   * Convenience wrapper: running deployments plus recent history, merged.
   * Prefer the two-step form when the history can be cached separately.
   */
  async getDeploymentHistory(
    applicationUuids: string[],
    takePerApplication = 5,
    concurrency = 4
  ): Promise<Deployment[]> {
    const [running, history] = await Promise.all([
      this.getRunningDeployments().catch((error) => {
        logger.warn('Failed to list running deployments', error);
        return [] as Deployment[];
      }),
      this.getDeploymentHistoryOnly(
        applicationUuids,
        takePerApplication,
        concurrency
      ),
    ]);

    return mergeDeployments(running, history);
  }

  async getDeploymentsByApplication(
    applicationUuid: string,
    skip = 0,
    take = 10
  ): Promise<Deployment[]> {
    const safeSkip = Number.isFinite(skip) ? Math.max(0, skip) : 0;
    const safeTake = Number.isFinite(take) ? Math.max(1, take) : 10;

    // Tolerant parse: some Coolify versions wrap the list in
    // `{ deployments: [...] }` instead of returning a bare array, which the
    // strict array parser rejected outright.
    const payload = await this.fetchWithAuth<unknown>(
      `/api/v1/deployments/applications/${applicationUuid}?skip=${safeSkip}&take=${safeTake}`
    );

    return this.toArrayPayload(payload).filter(isValidCoolifyDeployment);
  }

  async getDeployment(deploymentId: string): Promise<Deployment> {
    return this.fetchValidatedObject(
      `/api/v1/deployments/${deploymentId}`,
      isValidCoolifyDeployment,
      'deployment'
    );
  }

  async getDeploymentLogs(deploymentId: string): Promise<string> {
    const deployment = await this.getDeployment(deploymentId);
    return normalizeDeploymentLogs(deployment.logs);
  }

  /**
   * Runtime container logs — what is happening in the app right now.
   * Distinct from deployment logs, which only cover the build/release step.
   */
  async getApplicationLogs(applicationUuid: string): Promise<string> {
    const payload = await this.fetchWithAuth<unknown>(
      `/api/v1/applications/${applicationUuid}/logs`
    );

    if (payload && typeof payload === 'object') {
      const candidate = payload as Record<string, unknown>;
      if (typeof candidate.logs === 'string') {
        return candidate.logs;
      }
    }

    return typeof payload === 'string' ? payload : '';
  }

  /**
   * Triggers a deployment.
   *
   * Deliberately NOT retried by callers: this endpoint is not idempotent, so a
   * timeout followed by a retry would queue a second deployment of the same
   * application.
   */
  async startDeployment(uuid: string, force = false): Promise<boolean> {
    try {
      const forceParam = force ? '&force=true' : '';
      await this.client.get(
        `/api/v1/deploy?uuid=${encodeURIComponent(uuid)}${forceParam}`
      );

      return true;
    } catch (error) {
      logger.error('Error starting deployment', error);
      throw error;
    }
  }

  async cancelDeployment(deploymentId: string): Promise<boolean> {
    try {
      await this.client.request(`/api/v1/deployments/${deploymentId}/cancel`, {
        method: 'POST',
      });
      return true;
    } catch (error) {
      logger.error('Error canceling deployment', error);
      throw error;
    }
  }

  private async executeApplicationAction(
    applicationId: string,
    action: 'start' | 'stop' | 'restart'
  ): Promise<string> {
    const fallbackMessage = `Application ${action} request queued.`;
    const response = await this.client.get<unknown>(
      `/api/v1/applications/${applicationId}/${action}`
    );

    if (!isValidApplicationLifecycleResponse(response)) {
      logger.warn('Invalid application lifecycle payload received', {
        applicationId,
        action,
      });
      return fallbackMessage;
    }

    return response.message || fallbackMessage;
  }

  async startApplication(applicationId: string): Promise<string> {
    return this.executeApplicationAction(applicationId, 'start');
  }

  async stopApplication(applicationId: string): Promise<string> {
    return this.executeApplicationAction(applicationId, 'stop');
  }

  async restartApplication(applicationId: string): Promise<string> {
    return this.executeApplicationAction(applicationId, 'restart');
  }

  async getServices(): Promise<ServiceResource[]> {
    return this.fetchValidatedArray(
      '/api/v1/services',
      isValidCoolifyService,
      'services'
    );
  }

  async getService(serviceUuid: string): Promise<ServiceResource> {
    return this.fetchValidatedObject(
      `/api/v1/services/${serviceUuid}`,
      isValidCoolifyService,
      'service'
    );
  }

  private async executeServiceAction(
    serviceUuid: string,
    action: 'start' | 'stop' | 'restart'
  ): Promise<string> {
    const response = await this.client.get<unknown>(
      `/api/v1/services/${serviceUuid}/${action}`
    );

    if (!isValidApplicationLifecycleResponse(response)) {
      logger.warn('Invalid service action payload received', {
        serviceUuid,
        action,
      });
      return `Service ${action} request queued.`;
    }

    return response.message || `Service ${action} request queued.`;
  }

  async startService(serviceUuid: string): Promise<string> {
    return this.executeServiceAction(serviceUuid, 'start');
  }

  async stopService(serviceUuid: string): Promise<string> {
    return this.executeServiceAction(serviceUuid, 'stop');
  }

  async restartService(serviceUuid: string): Promise<string> {
    return this.executeServiceAction(serviceUuid, 'restart');
  }

  async getDatabases(): Promise<DatabaseResource[]> {
    return this.fetchValidatedArray(
      '/api/v1/databases',
      isValidCoolifyDatabase,
      'databases'
    );
  }

  async getDatabase(databaseUuid: string): Promise<DatabaseResource> {
    return this.fetchValidatedObject(
      `/api/v1/databases/${databaseUuid}`,
      isValidCoolifyDatabase,
      'database'
    );
  }

  private async executeDatabaseAction(
    databaseUuid: string,
    action: 'start' | 'stop' | 'restart'
  ): Promise<string> {
    const response = await this.client.get<unknown>(
      `/api/v1/databases/${databaseUuid}/${action}`
    );

    if (!isValidApplicationLifecycleResponse(response)) {
      logger.warn('Invalid database action payload received', {
        databaseUuid,
        action,
      });
      return `Database ${action} request queued.`;
    }

    return response.message || `Database ${action} request queued.`;
  }

  async startDatabase(databaseUuid: string): Promise<string> {
    return this.executeDatabaseAction(databaseUuid, 'start');
  }

  async stopDatabase(databaseUuid: string): Promise<string> {
    return this.executeDatabaseAction(databaseUuid, 'stop');
  }

  async restartDatabase(databaseUuid: string): Promise<string> {
    return this.executeDatabaseAction(databaseUuid, 'restart');
  }

  /**
   * Lists scheduled backup *configurations* for a database.
   * These are schedules, not restorable files — see listBackupExecutions.
   */
  async listBackupSchedules(
    databaseUuid: string
  ): Promise<DatabaseBackupSchedule[]> {
    const payload = await this.fetchWithAuth<unknown>(
      `/api/v1/databases/${databaseUuid}/backups`
    );

    return this.toArrayPayload(payload)
      .map((item) => this.mapBackupSchedule(item))
      .filter((item): item is DatabaseBackupSchedule => !!item);
  }

  /** The actual backup runs of a given schedule. */
  async listBackupExecutions(
    databaseUuid: string,
    scheduledBackupUuid: string
  ): Promise<DatabaseBackupExecution[]> {
    const payload = await this.fetchWithAuth<unknown>(
      `/api/v1/databases/${databaseUuid}/backups/${encodeURIComponent(
        scheduledBackupUuid
      )}/executions`
    );

    return this.toArrayPayload(payload)
      .map((item) => this.mapBackupExecution(item))
      .filter((item): item is DatabaseBackupExecution => !!item);
  }

  /**
   * Creates a scheduled backup configuration.
   * `frequency` is mandatory — omitting it makes the API answer 422.
   */
  async createBackupSchedule(
    databaseUuid: string,
    request: CreateBackupScheduleRequest
  ): Promise<string> {
    if (!request?.frequency) {
      throw new Error('frequency is required to create a backup schedule.');
    }

    const response = await this.client.request<unknown>(
      `/api/v1/databases/${databaseUuid}/backups`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }
    );

    if (isValidApplicationLifecycleResponse(response)) {
      return response.message || 'Backup schedule created.';
    }

    return 'Backup schedule created.';
  }

  /** Triggers an immediate run of an existing schedule. */
  async runBackupNow(
    databaseUuid: string,
    scheduledBackupUuid: string
  ): Promise<string> {
    const response = await this.client.request<unknown>(
      `/api/v1/databases/${databaseUuid}/backups/${encodeURIComponent(
        scheduledBackupUuid
      )}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backup_now: true }),
      }
    );

    if (isValidApplicationLifecycleResponse(response)) {
      return response.message || 'Backup iniciado.';
    }

    return 'Backup iniciado.';
  }

  async updateBackupSchedule(
    databaseUuid: string,
    scheduledBackupUuid: string,
    request: Partial<CreateBackupScheduleRequest>
  ): Promise<string> {
    const response = await this.client.request<unknown>(
      `/api/v1/databases/${databaseUuid}/backups/${encodeURIComponent(
        scheduledBackupUuid
      )}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }
    );

    if (isValidApplicationLifecycleResponse(response)) {
      return response.message || 'Backup schedule updated.';
    }

    return 'Backup schedule updated.';
  }

  private normalizeProjectCollection(payload: unknown): ProjectResource[] {
    if (Array.isArray(payload)) {
      return payload.filter(isValidCoolifyProject);
    }

    if (payload && typeof payload === 'object') {
      const candidate = payload as Record<string, unknown>;
      const arrayLike = [candidate.projects, candidate.items, candidate.data].find(
        (value) => Array.isArray(value)
      );

      if (Array.isArray(arrayLike)) {
        return arrayLike.filter(isValidCoolifyProject);
      }
    }

    return [];
  }

  async getProjects(): Promise<ProjectResource[]> {
    const payload = await this.fetchWithAuth<unknown>('/api/v1/projects');
    return this.normalizeProjectCollection(payload);
  }

  /** Resources of a single environment — the reliable project/env mapping. */
  async getProjectEnvironment(
    projectUuid: string,
    environmentNameOrUuid: string
  ): Promise<Record<string, unknown>> {
    const payload = await this.fetchWithAuth<unknown>(
      `/api/v1/projects/${projectUuid}/${encodeURIComponent(environmentNameOrUuid)}`
    );

    return payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {};
  }

  async getProject(projectUuid: string): Promise<ProjectResource> {
    return this.fetchValidatedObject(
      `/api/v1/projects/${projectUuid}`,
      isValidCoolifyProject,
      'project'
    );
  }

  async listEnvironmentVariables(
    applicationId: string
  ): Promise<EnvironmentVariable[]> {
    return this.fetchValidatedArray(
      `/api/v1/applications/${applicationId}/envs`,
      isValidEnvironmentVariable,
      'environment variables'
    );
  }

  async createEnvironmentVariable(
    applicationId: string,
    request: EnvironmentVariableCreateRequest
  ): Promise<EnvironmentVariable> {
    return this.client.request<EnvironmentVariable>(
      `/api/v1/applications/${applicationId}/envs`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      }
    );
  }

  async updateEnvironmentVariable(
    applicationId: string,
    request: EnvironmentVariableUpdateRequest
  ): Promise<EnvironmentVariable> {
    return this.client.request<EnvironmentVariable>(
      `/api/v1/applications/${applicationId}/envs`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      }
    );
  }

  /**
   * Applies many variables in a single request.
   * Syncing a 50-key .env used to mean 50 sequential round trips.
   */
  async updateEnvironmentVariablesBulk(
    applicationId: string,
    variables: EnvironmentVariableUpdateRequest[]
  ): Promise<void> {
    if (variables.length === 0) {
      return;
    }

    await this.client.request<unknown>(
      `/api/v1/applications/${applicationId}/envs/bulk`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data: variables }),
      }
    );
  }

  async getServers(): Promise<ServerResource[]> {
    return this.fetchValidatedArray(
      '/api/v1/servers',
      isValidCoolifyServer,
      'servers'
    );
  }

  async getServer(serverUuid: string): Promise<ServerResource> {
    return this.fetchValidatedObject(
      `/api/v1/servers/${serverUuid}`,
      isValidCoolifyServer,
      'server'
    );
  }

  /** Which resources run on a given machine — used to size the blast radius. */
  async getServerResources(serverUuid: string): Promise<ServerResourceItem[]> {
    const payload = await this.fetchWithAuth<unknown>(
      `/api/v1/servers/${serverUuid}/resources`
    );

    return this.toArrayPayload(payload)
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return undefined;
        }
        const candidate = item as Record<string, unknown>;
        const uuid = this.readString(candidate, 'uuid', 'id');
        if (!uuid) {
          return undefined;
        }
        return {
          uuid,
          name: this.readString(candidate, 'name') || uuid,
          type: this.readString(candidate, 'type') || 'unknown',
          status: this.readString(candidate, 'status') || 'unknown',
        };
      })
      .filter((item): item is ServerResourceItem => !!item);
  }

  /** Returns true when Coolify can reach the machine over SSH. */
  async validateServer(serverUuid: string): Promise<boolean> {
    try {
      await this.client.get(`/api/v1/servers/${serverUuid}/validate`);
      return true;
    } catch (error) {
      logger.warn('Server validation failed', { serverUuid, error });
      return false;
    }
  }

  async deleteEnvironmentVariable(
    applicationId: string,
    environmentVariableUuid: string
  ): Promise<void> {
    await this.client.request<void>(
      `/api/v1/applications/${applicationId}/envs/${environmentVariableUuid}`,
      {
        method: 'DELETE',
      }
    );
  }

  /**
   * Verifies if the token is valid by making a test API call
   * @returns true if token is valid, false otherwise
   */
  async verifyToken(): Promise<boolean> {
    try {
      await this.client.get('/api/v1/version');
      return true;
    } catch (error) {
      logger.warn('Error verifying token', error);
      return false;
    }
  }

  /**
   * Tests the connection to the Coolify server
   * @returns true if server is reachable, false otherwise
   */
  async testConnection(): Promise<boolean> {
    try {
      const testClient = new HttpClient({
        baseUrl: this.baseUrl,
        timeoutMs: 10000,
      });
      await testClient.get('/api/health');
      return true;
    } catch (error) {
      logger.warn('Error testing connection', error);
      return false;
    }
  }
}

export { CoolifyApiError };
