import { CoolifyApiError, HttpClient } from './HttpClient';

interface Application {
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

interface Deployment {
  id: string;
  application_id: string;
  application_name: string;
  status: string;
  commit: string;
  created_at: string;
  deployment_url: string;
  commit_message: string;
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

  async startDeployment(uuid: string): Promise<boolean> {
    try {
      await this.client.get(`/api/v1/deploy?uuid=${uuid}`);

      return true;
    } catch (error) {
      console.error('Error starting deployment:', error);
      throw error;
    }
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
      console.error('Error verifying token:', error);
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
      console.error('Error testing connection:', error);
      return false;
    }
  }
}

export { CoolifyApiError };
