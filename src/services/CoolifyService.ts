import { CoolifyApiError, HttpClient } from './HttpClient';
import { logger } from './LoggerService';

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

  async getApplications(): Promise<Application[]> {
    return this.fetchWithAuth<Application[]>('/api/v1/applications');
  }

  async getDeployments(): Promise<Deployment[]> {
    return this.fetchWithAuth<Deployment[]>('/api/v1/deployments');
  }

  async getDeployment(deploymentId: string): Promise<Deployment> {
    return this.fetchWithAuth<Deployment>(`/api/v1/deployments/${deploymentId}`);
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
    const response = await this.client.get<ApplicationLifecycleResponse>(
      `/api/v1/applications/${applicationId}/${action}`
    );

    return response?.message || `Application ${action} request queued.`;
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

  async listEnvironmentVariables(
    applicationId: string
  ): Promise<EnvironmentVariable[]> {
    return this.fetchWithAuth<EnvironmentVariable[]>(
      `/api/v1/applications/${applicationId}/envs`
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
