import { CoolifyApiError, HttpClient } from './HttpClient';
import { logger } from './LoggerService';
import {
  isValidApplicationLifecycleResponse,
  isValidCoolifyApplication,
  isValidCoolifyDeployment,
  isValidCoolifyDatabase,
  isValidCoolifyService,
  isValidEnvironmentVariable,
  parseArrayPayload,
  parseObjectPayload,
} from '../utils/payloadGuards';

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

export interface DatabaseBackupResource {
  id: string;
  name?: string;
  status?: string;
  created_at?: string;
  size?: string;
}

export interface ApplicationLifecycleResponse {
  message?: string;
  deployment_uuid?: string;
}

export interface EnvironmentVariable {
  uuid: string;
  key: string;
  value: string;
  is_buildtime?: boolean;
  is_preview?: boolean;
  is_literal?: boolean;
  is_multiline?: boolean;
  is_runtime?: boolean;
}

export interface EnvironmentVariableCreateRequest {
  key: string;
  value: string;
  is_buildtime?: boolean;
  is_preview?: boolean;
  is_literal?: boolean;
  is_multiline?: boolean;
  is_runtime?: boolean;
}

export interface EnvironmentVariableUpdateRequest {
  uuid: string;
  key?: string;
  value?: string;
  is_buildtime?: boolean;
  is_preview?: boolean;
  is_literal?: boolean;
  is_multiline?: boolean;
  is_runtime?: boolean;
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

  private extractBackupId(value: unknown): string {
    if (!value || typeof value !== 'object') {
      return '';
    }

    const candidate = value as Record<string, unknown>;
    const idCandidates = [
      candidate.id,
      candidate.uuid,
      candidate.backup_uuid,
      candidate.backup_id,
      candidate.filename,
      candidate.name,
    ];

    for (const idCandidate of idCandidates) {
      if (typeof idCandidate === 'string' && idCandidate.trim().length > 0) {
        return idCandidate;
      }
      if (typeof idCandidate === 'number' && Number.isFinite(idCandidate)) {
        return String(idCandidate);
      }
    }

    return '';
  }

  private mapBackupItem(value: unknown): DatabaseBackupResource | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const candidate = value as Record<string, unknown>;
    const id = this.extractBackupId(candidate);
    if (!id) {
      return undefined;
    }

    return {
      id,
      name:
        typeof candidate.name === 'string'
          ? candidate.name
          : typeof candidate.filename === 'string'
            ? candidate.filename
            : undefined,
      status:
        typeof candidate.status === 'string'
          ? candidate.status
          : typeof candidate.state === 'string'
            ? candidate.state
            : undefined,
      created_at:
        typeof candidate.created_at === 'string'
          ? candidate.created_at
          : typeof candidate.createdAt === 'string'
            ? candidate.createdAt
            : undefined,
      size:
        typeof candidate.size === 'string'
          ? candidate.size
          : typeof candidate.file_size === 'string'
            ? candidate.file_size
            : undefined,
    };
  }

  private normalizeBackupCollection(payload: unknown): DatabaseBackupResource[] {
    if (Array.isArray(payload)) {
      return payload
        .map((item) => this.mapBackupItem(item))
        .filter((item): item is DatabaseBackupResource => !!item);
    }

    if (payload && typeof payload === 'object') {
      const candidate = payload as Record<string, unknown>;
      const arrayLike = [candidate.backups, candidate.items, candidate.data].find(
        (value) => Array.isArray(value)
      );

      if (Array.isArray(arrayLike)) {
        return arrayLike
          .map((item) => this.mapBackupItem(item))
          .filter((item): item is DatabaseBackupResource => !!item);
      }
    }

    return [];
  }

  private async requestWithFallback<T>(
    paths: string[],
    options: RequestInit
  ): Promise<T> {
    let lastError: unknown;

    for (const path of paths) {
      try {
        return await this.client.request<T>(path, options);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError;
  }

  async getApplications(): Promise<Application[]> {
    return this.fetchValidatedArray(
      '/api/v1/applications',
      isValidCoolifyApplication,
      'applications'
    );
  }

  async getDeployments(): Promise<Deployment[]> {
    return this.fetchValidatedArray(
      '/api/v1/deployments',
      isValidCoolifyDeployment,
      'deployments'
    );
  }

  async getDeploymentsByApplication(
    applicationUuid: string,
    skip = 0,
    take = 10
  ): Promise<Deployment[]> {
    const safeSkip = Number.isFinite(skip) ? Math.max(0, skip) : 0;
    const safeTake = Number.isFinite(take) ? Math.max(1, take) : 10;

    return this.fetchValidatedArray(
      `/api/v1/deployments/applications/${applicationUuid}?skip=${safeSkip}&take=${safeTake}`,
      isValidCoolifyDeployment,
      'application deployments'
    );
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
    return deployment.logs || '';
  }

  async startDeployment(uuid: string): Promise<boolean> {
    try {
      await this.client.get(`/api/v1/deploy?uuid=${uuid}`);

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

  async listDatabaseBackups(
    databaseUuid: string
  ): Promise<DatabaseBackupResource[]> {
    const candidates = [
      `/api/v1/databases/${databaseUuid}/backups`,
      `/api/v1/databases/${databaseUuid}/backup`,
    ];

    let lastError: unknown;
    for (const endpoint of candidates) {
      try {
        const payload = await this.fetchWithAuth<unknown>(endpoint);
        const backups = this.normalizeBackupCollection(payload);
        if (backups.length > 0 || endpoint.endsWith('/backups')) {
          return backups;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    return [];
  }

  async createDatabaseBackup(databaseUuid: string): Promise<string> {
    const response = await this.requestWithFallback<unknown>(
      [
        `/api/v1/databases/${databaseUuid}/backups`,
        `/api/v1/databases/${databaseUuid}/backup`,
      ],
      {
        method: 'POST',
      }
    );

    if (isValidApplicationLifecycleResponse(response)) {
      return response.message || 'Database backup requested.';
    }

    return 'Database backup requested.';
  }

  async restoreDatabaseBackup(
    databaseUuid: string,
    backupId: string
  ): Promise<string> {
    const encodedBackupId = encodeURIComponent(backupId);
    const response = await this.requestWithFallback<unknown>(
      [
        `/api/v1/databases/${databaseUuid}/backups/${encodedBackupId}/restore`,
        `/api/v1/databases/${databaseUuid}/backups/restore?backup_uuid=${encodedBackupId}`,
        `/api/v1/databases/${databaseUuid}/restore?backup_uuid=${encodedBackupId}`,
      ],
      {
        method: 'POST',
      }
    );

    if (isValidApplicationLifecycleResponse(response)) {
      return response.message || 'Database restore requested.';
    }

    return 'Database restore requested.';
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
