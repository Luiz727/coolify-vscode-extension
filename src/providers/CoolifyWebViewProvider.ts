import * as vscode from 'vscode';
import { ConfigurationManager } from '../managers/ConfigurationManager';
import { CoolifyApiError, CoolifyService } from '../services/CoolifyService';
import type {
  Application as CoolifyApplication,
  DatabaseBackupResource,
  DatabaseResource,
  Deployment as CoolifyDeployment,
  EnvironmentVariable,
  EnvironmentVariableCreateRequest,
  EnvironmentVariableUpdateRequest,
  ProjectResource,
  ServiceResource,
} from '../services/CoolifyService';
import { logger } from '../services/LoggerService';
import {
  isValidCoolifyApplication,
  isValidCoolifyDeployment,
} from '../utils/payloadGuards';
import {
  sanitizeDisplayText,
  sanitizeDisplayTextOrFallback,
} from '../utils/displaySanitizer';
import {
  isUiStateTransitionAllowed,
  UiState,
} from '../utils/uiStateMachine';

// Types and Interfaces
interface RetryConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
}

interface WebViewState {
  applications: Application[];
  deployments: Deployment[];
  services: ServiceListItem[];
  databases: DatabaseListItem[];
  projects: ProjectListItem[];
  contextNames: string[];
  activeContextName: string;
  envSyncConflictStrategy: EnvSyncConflictStrategy;
}

type EnvSyncConflictStrategy = 'prompt' | 'file-all' | 'remote-all' | 'per-key';

interface Application {
  id: string;
  name: string;
  status: string;
  fqdn: string;
  externalUrl?: string;
  git_repository: string;
  git_branch: string;
  updated_at: string;
}

interface Deployment {
  id: string;
  applicationId: string;
  applicationName: string;
  status: string;
  commit: string;
  startedAt: string;
  externalUrl?: string;
}

interface DeploymentListItem {
  id: string;
  deploymentUuid?: string;
  applicationId: string;
  applicationName: string;
  status: string;
  commit: string;
  createdAt: string;
  deploymentUrl?: string;
  commitMessage?: string;
  logs?: string;
}

interface ApplicationListItem {
  id: string;
  name: string;
  status: string;
  label: string;
}

interface ServiceListItem {
  id: string;
  name: string;
  status: string;
  description: string;
}

interface DatabaseListItem {
  id: string;
  name: string;
  status: string;
  description: string;
}

interface ProjectListItem {
  id: string;
  name: string;
  description: string;
}

interface WebViewMessage {
  type:
    | 'refresh'
    | 'deploy'
    | 'start-app'
    | 'stop-app'
    | 'restart-app'
    | 'start-service'
    | 'stop-service'
    | 'restart-service'
    | 'start-database'
    | 'stop-database'
    | 'restart-database'
    | 'show-deployment-details'
    | 'show-deployment-logs'
    | 'cancel-deployment'
    | 'list-app-envs'
    | 'create-app-env'
    | 'update-app-env'
    | 'delete-app-env'
    | 'fetch-app-envs'
    | 'fetch-service-details'
    | 'fetch-database-details'
    | 'fetch-project-details'
    | 'fetch-database-backups'
    | 'create-database-backup'
    | 'restore-database-backup'
    | 'sync-app-envs'
    | 'set-env-sync-conflict-strategy'
    | 'open-external-url'
    | 'switch-context'
    | 'create-context'
    | 'delete-context'
    | 'configure'
    | 'reconfigure';
  applicationId?: string;
  serviceId?: string;
  databaseId?: string;
  projectId?: string;
  deploymentId?: string;
  backupId?: string;
  contextName?: string;
  environmentVariableUuid?: string;
  environmentVariableKey?: string;
  conflictStrategy?: EnvSyncConflictStrategy;
  url?: string;
}

interface RefreshDataMessage {
  type: 'refresh-data';
  applications: Application[];
  deployments: Deployment[];
  services: ServiceListItem[];
  databases: DatabaseListItem[];
  projects: ProjectListItem[];
  contextNames: string[];
  activeContextName: string;
  envSyncConflictStrategy: EnvSyncConflictStrategy;
}

interface UiStateMessage {
  type: 'ui-state';
  state: UiState;
  message?: string;
}

interface DeploymentStatusMessage {
  type: 'deployment-status';
  status: string;
  applicationId: string;
}

interface AppEnvironmentVariablesMessage {
  type: 'app-envs-data';
  applicationId: string;
  envs: Array<{
    uuid: string;
    key: string;
    value: string;
  }>;
}

interface ServiceDetailsMessage {
  type: 'service-details-data';
  serviceId: string;
  details: Array<{
    key: string;
    value: string;
  }>;
}

interface DatabaseDetailsMessage {
  type: 'database-details-data';
  databaseId: string;
  details: Array<{
    key: string;
    value: string;
  }>;
}

interface DatabaseBackupsMessage {
  type: 'database-backups-data';
  databaseId: string;
  backups: Array<{
    id: string;
    name: string;
    status: string;
    createdAt: string;
    size: string;
  }>;
}

interface ProjectDetailsMessage {
  type: 'project-details-data';
  projectId: string;
  details: Array<{
    key: string;
    value: string;
  }>;
}

type WebViewOutgoingMessage =
  | RefreshDataMessage
  | DeploymentStatusMessage
  | AppEnvironmentVariablesMessage
  | ServiceDetailsMessage
  | DatabaseDetailsMessage
  | DatabaseBackupsMessage
  | ProjectDetailsMessage
  | UiStateMessage;
type CoolifyLanguage = 'en' | 'pt-BR';

// Constants
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: 10000,
};

const REFRESH_INTERVAL = 5000;

export class CoolifyWebViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private refreshInterval?: NodeJS.Timeout;
  private messageHandler?: vscode.Disposable;
  private retryCount = 0;
  private isDisposed = false;
  private deployingApplications = new Set<string>();
  private pendingRefresh?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private currentUiState: UiState = 'loading';

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private configManager: ConfigurationManager
  ) {
    this.initializeConfigurationListener();
  }

  // Initialization Methods
  private initializeConfigurationListener(): void {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration('coolify')) {
          await this.handleConfigurationChange();
        }
      })
    );
  }

  private async handleConfigurationChange(): Promise<void> {
    const isConfigured = await this.configManager.isConfigured();
    if (!isConfigured) {
      this.stopRefreshInterval();
    }
    await this.updateView();
  }

  // View Management Methods
  private isViewValid(): boolean {
    return !!this._view && !this.isDisposed;
  }

  public async updateView(): Promise<void> {
    if (this.pendingRefresh) {
      clearTimeout(this.pendingRefresh);
    }

    this.pendingRefresh = setTimeout(async () => {
      if (!this.isViewValid()) {
        return;
      }

      try {
        this._view!.webview.html = '';
        await this.resolveWebviewView(
          this._view!,
          { state: undefined },
          new vscode.CancellationTokenSource().token
        );
      } catch (error) {
        this.handleError('Failed to update view', error);
      }
    }, 100);
  }

  // Retry Logic
  private async withRetry<T>(
    operation: () => Promise<T>,
    retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        const canRetry = this.shouldRetryError(error);

        if (!canRetry || attempt === retryConfig.maxAttempts) {
          throw lastError;
        }

        const delay = Math.min(
          retryConfig.baseDelay * Math.pow(2, attempt - 1),
          retryConfig.maxDelay
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  private shouldRetryError(error: unknown): boolean {
    if (!(error instanceof CoolifyApiError)) {
      return true;
    }

    return (
      error.type === 'timeout' ||
      error.type === 'network' ||
      error.type === 'server'
    );
  }

  // Refresh Management
  private stopRefreshInterval(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
  }

  private startRefreshInterval(): void {
    this.stopRefreshInterval();
    this.retryCount = 0;

    this.refreshInterval = setInterval(async () => {
      try {
        await this.refreshData();
        this.retryCount = 0;
      } catch (error) {
        this.retryCount++;
        logger.warn('Auto-refresh failed', error);

        if (this.retryCount >= DEFAULT_RETRY_CONFIG.maxAttempts) {
          this.stopRefreshInterval();
          if (this.isViewValid()) {
            vscode.window.showErrorMessage(
              'Auto-refresh stopped due to repeated errors. Click refresh to try again.'
            );
          }
        }
      }
    }, REFRESH_INTERVAL);
  }

  // Data Management
  public async refreshData(): Promise<void> {
    if (!this.isViewValid()) {
      return;
    }

    await this.transitionUiState('loading');

    try {
      await this.withRetry(async () => {
        const serverUrl = await this.configManager.getServerUrl();
        const token = await this.configManager.getToken();
        const contextNames = await this.configManager.getContextNames();
        const activeContextName = await this.configManager.getActiveContextName();
        const envSyncConflictStrategy = vscode.workspace
          .getConfiguration('coolify')
          .get<EnvSyncConflictStrategy>('envSyncConflictStrategy', 'prompt');

        if (!serverUrl || !token) {
          await this.handleUnconfiguredState();
          return;
        }

        const service = new CoolifyService(serverUrl, token);
        const [applications, deployments] = await Promise.all([
          service.getApplications(),
          service.getDeployments(),
        ]);

        const [servicesResult, databasesResult, projectsResult] = await Promise.allSettled([
          service.getServices(),
          service.getDatabases(),
          service.getProjects(),
        ]);

        const services =
          servicesResult.status === 'fulfilled' ? servicesResult.value : [];
        const databases =
          databasesResult.status === 'fulfilled' ? databasesResult.value : [];
        const projects =
          projectsResult.status === 'fulfilled' ? projectsResult.value : [];

        if (servicesResult.status === 'rejected') {
          logger.warn('Failed to load services for sidebar', servicesResult.reason);
        }

        if (databasesResult.status === 'rejected') {
          logger.warn('Failed to load databases for sidebar', databasesResult.reason);
        }

        if (projectsResult.status === 'rejected') {
          logger.warn('Failed to load projects for sidebar', projectsResult.reason);
        }

        await this.updateWebViewState(
          applications,
          deployments,
          services,
          databases,
          projects,
          contextNames,
          activeContextName,
          serverUrl,
          envSyncConflictStrategy
        );
      });
    } catch (error) {
      await this.handleRefreshError(error);
    }
  }

  private async handleUnconfiguredState(): Promise<void> {
    await this.transitionUiState(
      'unconfigured',
      'Coolify is not configured. Please configure the extension.'
    );

    await vscode.commands.executeCommand(
      'setContext',
      'coolify.isConfigured',
      false
    );

    if (this.isViewValid()) {
      this._view!.webview.postMessage({
        type: 'refresh-data',
        applications: [],
        deployments: [],
        services: [],
        databases: [],
        projects: [],
        contextNames: [],
        activeContextName: '',
        envSyncConflictStrategy: 'prompt',
      } as WebViewOutgoingMessage);
    }
  }

  private async updateWebViewState(
    applications: CoolifyApplication[],
    deployments: CoolifyDeployment[],
    services: ServiceResource[],
    databases: DatabaseResource[],
    projects: ProjectResource[],
    contextNames: string[],
    activeContextName: string,
    serverUrl: string,
    envSyncConflictStrategy: EnvSyncConflictStrategy
  ): Promise<void> {
    if (!this.isViewValid()) {
      return;
    }

    const validApplications = applications.filter(isValidCoolifyApplication);
    const invalidApplicationsCount = applications.length - validApplications.length;
    if (invalidApplicationsCount > 0) {
      logger.warn('Ignoring invalid application items from API response', {
        invalidApplicationsCount,
      });
    }

    const validDeployments = deployments.filter(isValidCoolifyDeployment);
    const invalidDeploymentsCount = deployments.length - validDeployments.length;
    if (invalidDeploymentsCount > 0) {
      logger.warn('Ignoring invalid deployment items from API response', {
        invalidDeploymentsCount,
      });
    }

    const uiApplications = this.mapApplicationsToUI(validApplications, serverUrl);
    const uiDeployments = this.mapDeploymentsToUI(validDeployments);
    const uiServices = this.mapServicesToUI(services);
    const uiDatabases = this.mapDatabasesToUI(databases);
    const uiProjects = this.mapProjectsToUI(projects);

    this._view!.webview.postMessage({
      type: 'refresh-data',
      applications: uiApplications,
      deployments: uiDeployments,
      services: uiServices,
      databases: uiDatabases,
      projects: uiProjects,
      contextNames,
      activeContextName,
      envSyncConflictStrategy,
    } as WebViewOutgoingMessage);

    await this.transitionUiState('ready');
  }

  private async transitionUiState(
    nextState: UiState,
    message?: string
  ): Promise<void> {
    const previousState = this.currentUiState;
    if (!isUiStateTransitionAllowed(previousState, nextState)) {
      logger.warn('Ignoring invalid UI state transition', {
        previousState,
        nextState,
      });
      return;
    }

    this.currentUiState = nextState;

    if (this.isViewValid()) {
      this._view!.webview.postMessage({
        type: 'ui-state',
        state: nextState,
        message,
      } as WebViewOutgoingMessage);
    }
  }

  private mapApplicationsToUI(
    applications: CoolifyApplication[],
    serverUrl: string
  ): Application[] {
    return applications.map((app) => ({
      id: app.uuid,
      name: sanitizeDisplayTextOrFallback(app.name, app.uuid),
      status: sanitizeDisplayTextOrFallback(app.status, 'unknown'),
      fqdn: sanitizeDisplayText(app.fqdn),
      externalUrl:
        this.normalizeExternalUrl(sanitizeDisplayText(app.fqdn)) ||
        this.normalizeExternalUrl(`${serverUrl}/resources/${app.uuid}`),
      git_repository: sanitizeDisplayText(app.git_repository),
      git_branch: sanitizeDisplayText(app.git_branch),
      updated_at: sanitizeDisplayText(app.updated_at),
    }));
  }

  private mapDeploymentsToUI(deployments: CoolifyDeployment[]): Deployment[] {
    return deployments.map((d) => ({
      id: String(d.id ?? ''),
      applicationId: sanitizeDisplayTextOrFallback(
        d.application_id,
        String(d.id ?? '')
      ),
      applicationName: sanitizeDisplayTextOrFallback(
        d.application_name,
        sanitizeDisplayTextOrFallback(d.application_id, String(d.id ?? ''))
      ),
      status: sanitizeDisplayTextOrFallback(d.status, 'unknown'),
      commit:
        sanitizeDisplayText(d.commit_message) ||
        `Deploying ${sanitizeDisplayText(d.commit).slice(0, 7) || 'latest'} commit`,
      startedAt: sanitizeDisplayText(d.created_at)
        ? new Date(sanitizeDisplayText(d.created_at)).toLocaleString()
        : '',
      externalUrl: this.normalizeExternalUrl(d.deployment_url),
    }));
  }

  private mapServicesToUI(services: ServiceResource[]): ServiceListItem[] {
    return services.map((item) => ({
      id: item.uuid,
      name: sanitizeDisplayTextOrFallback(item.name, item.uuid),
      status: sanitizeDisplayTextOrFallback(item.status, 'unknown'),
      description: sanitizeDisplayText(item.description),
    }));
  }

  private mapDatabasesToUI(databases: DatabaseResource[]): DatabaseListItem[] {
    return databases.map((item) => ({
      id: item.uuid,
      name: sanitizeDisplayTextOrFallback(item.name, item.uuid),
      status: sanitizeDisplayTextOrFallback(item.status, 'unknown'),
      description: sanitizeDisplayText(item.description),
    }));
  }

  private mapProjectsToUI(projects: ProjectResource[]): ProjectListItem[] {
    return projects.map((item) => ({
      id: item.uuid,
      name: sanitizeDisplayTextOrFallback(item.name, item.uuid),
      description: sanitizeDisplayText(item.description),
    }));
  }

  private mapDeploymentToListItem(deployment: CoolifyDeployment): DeploymentListItem {
    return {
      id: String(deployment.deployment_uuid || deployment.id || ''),
      deploymentUuid: deployment.deployment_uuid
        ? String(deployment.deployment_uuid)
        : undefined,
      applicationId: sanitizeDisplayTextOrFallback(
        deployment.application_id,
        String(deployment.id ?? '')
      ),
      applicationName: sanitizeDisplayTextOrFallback(
        deployment.application_name,
        sanitizeDisplayTextOrFallback(
          deployment.application_id,
          String(deployment.id ?? '')
        )
      ),
      status: sanitizeDisplayTextOrFallback(deployment.status, 'unknown'),
      commit: sanitizeDisplayText(deployment.commit),
      createdAt: sanitizeDisplayText(deployment.created_at),
      deploymentUrl: deployment.deployment_url,
      commitMessage: sanitizeDisplayText(deployment.commit_message),
      logs: deployment.logs,
    };
  }

  private toTimestamp(value: string): number {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  private normalizeExternalUrl(rawUrl: string | undefined): string | undefined {
    if (!rawUrl) {
      return undefined;
    }

    const trimmed = String(rawUrl).trim();
    if (!trimmed) {
      return undefined;
    }

    const withScheme = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;

    try {
      const parsed = new URL(withScheme);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return undefined;
      }
      return parsed.toString();
    } catch {
      return undefined;
    }
  }

  // Deployment Management
  public async deployApplication(applicationId: string): Promise<void> {
    if (this.deployingApplications.has(applicationId)) {
      vscode.window.showInformationMessage('Deployment already in progress');
      return;
    }

    this.deployingApplications.add(applicationId);

    try {
      await this.withRetry(async () => {
        const serverUrl = await this.configManager.getServerUrl();
        const token = await this.configManager.getToken();

        if (!serverUrl || !token) {
          throw new Error('Extension not configured properly');
        }

        const service = new CoolifyService(serverUrl, token);
        await service.startDeployment(applicationId);
      });

      await this.refreshData();

      if (this.isViewValid()) {
        vscode.window.showInformationMessage('Deployment started successfully');
      }
    } catch (error) {
      this.handleError('Failed to start deployment', error);
    } finally {
      this.deployingApplications.delete(applicationId);
    }
  }

  public async startApplication(applicationId: string): Promise<string> {
    return this.executeApplicationAction(applicationId, 'start');
  }

  public async stopApplication(applicationId: string): Promise<string> {
    return this.executeApplicationAction(applicationId, 'stop');
  }

  public async restartApplication(applicationId: string): Promise<string> {
    return this.executeApplicationAction(applicationId, 'restart');
  }

  public async startService(serviceId: string): Promise<string> {
    return this.executeServiceAction(serviceId, 'start');
  }

  public async stopService(serviceId: string): Promise<string> {
    return this.executeServiceAction(serviceId, 'stop');
  }

  public async restartService(serviceId: string): Promise<string> {
    return this.executeServiceAction(serviceId, 'restart');
  }

  private async executeServiceAction(
    serviceId: string,
    action: 'start' | 'stop' | 'restart'
  ): Promise<string> {
    const serverUrl = await this.configManager.getServerUrl();
    const token = await this.configManager.getToken();

    if (!serverUrl || !token) {
      throw new Error('Extension not configured properly');
    }

    const service = new CoolifyService(serverUrl, token);

    let message = '';
    switch (action) {
      case 'start':
        message = await service.startService(serviceId);
        break;
      case 'stop':
        message = await service.stopService(serviceId);
        break;
      case 'restart':
        message = await service.restartService(serviceId);
        break;
    }

    await this.refreshData();
    return message;
  }

  public async startDatabase(databaseId: string): Promise<string> {
    return this.executeDatabaseAction(databaseId, 'start');
  }

  public async stopDatabase(databaseId: string): Promise<string> {
    return this.executeDatabaseAction(databaseId, 'stop');
  }

  public async restartDatabase(databaseId: string): Promise<string> {
    return this.executeDatabaseAction(databaseId, 'restart');
  }

  private async executeDatabaseAction(
    databaseId: string,
    action: 'start' | 'stop' | 'restart'
  ): Promise<string> {
    const serverUrl = await this.configManager.getServerUrl();
    const token = await this.configManager.getToken();

    if (!serverUrl || !token) {
      throw new Error('Extension not configured properly');
    }

    const service = new CoolifyService(serverUrl, token);

    let message = '';
    switch (action) {
      case 'start':
        message = await service.startDatabase(databaseId);
        break;
      case 'stop':
        message = await service.stopDatabase(databaseId);
        break;
      case 'restart':
        message = await service.restartDatabase(databaseId);
        break;
    }

    await this.refreshData();
    return message;
  }

  private async executeApplicationAction(
    applicationId: string,
    action: 'start' | 'stop' | 'restart'
  ): Promise<string> {
    const serverUrl = await this.configManager.getServerUrl();
    const token = await this.configManager.getToken();

    if (!serverUrl || !token) {
      throw new Error('Extension not configured properly');
    }

    const service = new CoolifyService(serverUrl, token);

    let message = '';
    switch (action) {
      case 'start':
        message = await service.startApplication(applicationId);
        break;
      case 'stop':
        message = await service.stopApplication(applicationId);
        break;
      case 'restart':
        message = await service.restartApplication(applicationId);
        break;
    }

    await this.refreshData();
    return message;
  }

  // WebView Resolution
  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.cleanupExistingView();
    this.initializeNewView(webviewView);

    try {
      await this.setupWebView(webviewView);
    } catch (error) {
      this.handleError('Error initializing webview', error);
    }
  }

  private cleanupExistingView(): void {
    if (this.messageHandler) {
      this.messageHandler.dispose();
      this.messageHandler = undefined;
    }
  }

  private initializeNewView(webviewView: vscode.WebviewView): void {
    this.isDisposed = false;
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
      enableCommandUris: false,
    };
  }

  private async setupWebView(webviewView: vscode.WebviewView): Promise<void> {
    this.setupMessageHandler(webviewView);
    this.setupVisibilityHandler(webviewView);
    this.setupDisposalHandler(webviewView);

    const isConfigured = await this.configManager.isConfigured();
    if (!isConfigured) {
      this.handleUnconfiguredWebView(webviewView);
      return;
    }

    await this.initializeConfiguredWebView(webviewView);
  }

  private setupMessageHandler(webviewView: vscode.WebviewView): void {
    this.messageHandler = webviewView.webview.onDidReceiveMessage(
      async (data: WebViewMessage) => {
        if (!this.isViewValid()) {
          return;
        }

        try {
          await this.handleWebViewMessage(data);
        } catch (error) {
          logger.error('Error handling webview message', error);
        }
      }
    );
  }

  private async handleWebViewMessage(message: WebViewMessage): Promise<void> {
    switch (message.type) {
      case 'refresh':
        await this.refreshData();
        break;
      case 'deploy':
        if (message.applicationId) {
          await this.deployApplication(message.applicationId);
        }
        break;
      case 'start-app':
        if (message.applicationId) {
          const result = await this.startApplication(message.applicationId);
          if (this.isViewValid()) {
            vscode.window.showInformationMessage(result);
          }
        }
        break;
      case 'stop-app':
        if (message.applicationId) {
          const result = await this.stopApplication(message.applicationId);
          if (this.isViewValid()) {
            vscode.window.showInformationMessage(result);
          }
        }
        break;
      case 'restart-app':
        if (message.applicationId) {
          const result = await this.restartApplication(message.applicationId);
          if (this.isViewValid()) {
            vscode.window.showInformationMessage(result);
          }
        }
        break;
      case 'start-service':
        if (message.serviceId) {
          const result = await this.startService(message.serviceId);
          if (this.isViewValid()) {
            vscode.window.showInformationMessage(result);
          }
        }
        break;
      case 'stop-service':
        if (message.serviceId) {
          const result = await this.stopService(message.serviceId);
          if (this.isViewValid()) {
            vscode.window.showInformationMessage(result);
          }
        }
        break;
      case 'restart-service':
        if (message.serviceId) {
          const result = await this.restartService(message.serviceId);
          if (this.isViewValid()) {
            vscode.window.showInformationMessage(result);
          }
        }
        break;
      case 'start-database':
        if (message.databaseId) {
          const result = await this.startDatabase(message.databaseId);
          if (this.isViewValid()) {
            vscode.window.showInformationMessage(result);
          }
        }
        break;
      case 'stop-database':
        if (message.databaseId) {
          const result = await this.stopDatabase(message.databaseId);
          if (this.isViewValid()) {
            vscode.window.showInformationMessage(result);
          }
        }
        break;
      case 'restart-database':
        if (message.databaseId) {
          const result = await this.restartDatabase(message.databaseId);
          if (this.isViewValid()) {
            vscode.window.showInformationMessage(result);
          }
        }
        break;
      case 'show-deployment-details':
        if (message.deploymentId) {
          await vscode.commands.executeCommand(
            'coolify.showDeploymentDetails',
            message.deploymentId
          );
        }
        break;
      case 'show-deployment-logs':
        if (message.deploymentId) {
          const logs = await this.getDeploymentLogs(message.deploymentId);
          const document = await vscode.workspace.openTextDocument({
            language: 'log',
            content: logs || 'No logs available for this deployment.',
          });
          await vscode.window.showTextDocument(document, {
            preview: true,
          });
        }
        break;
      case 'cancel-deployment':
        if (message.deploymentId) {
          const confirmation = await vscode.window.showWarningMessage(
            `Are you sure you want to cancel deployment ${message.deploymentId}?`,
            { modal: true },
            'Cancel Deployment'
          );

          if (confirmation === 'Cancel Deployment') {
            await this.cancelDeployment(message.deploymentId);
            if (this.isViewValid()) {
              vscode.window.showInformationMessage(
                `Deployment ${message.deploymentId} cancellation requested.`
              );
            }
          }
        }
        break;
      case 'list-app-envs':
        if (message.applicationId) {
          await vscode.commands.executeCommand(
            'coolify.listEnvironmentVariables',
            message.applicationId
          );
        }
        break;
      case 'create-app-env':
        if (message.applicationId) {
          await vscode.commands.executeCommand(
            'coolify.createEnvironmentVariable',
            message.applicationId
          );
          if (this.isViewValid()) {
            const envs = await this.listEnvironmentVariables(message.applicationId);
            this._view!.webview.postMessage({
              type: 'app-envs-data',
              applicationId: message.applicationId,
              envs: envs.map((env) => ({
                uuid: env.uuid,
                key: env.key,
                value: env.value,
              })),
            } as WebViewOutgoingMessage);
          }
        }
        break;
      case 'sync-app-envs':
        if (message.applicationId) {
          await vscode.commands.executeCommand(
            'coolify.syncEnvironmentVariablesFromFile',
            {
              applicationId: message.applicationId,
              conflictStrategy: message.conflictStrategy,
            }
          );
          if (this.isViewValid()) {
            const envs = await this.listEnvironmentVariables(message.applicationId);
            this._view!.webview.postMessage({
              type: 'app-envs-data',
              applicationId: message.applicationId,
              envs: envs.map((env) => ({
                uuid: env.uuid,
                key: env.key,
                value: env.value,
              })),
            } as WebViewOutgoingMessage);
          }
        }
        break;
      case 'set-env-sync-conflict-strategy':
        if (message.conflictStrategy) {
          await vscode.workspace
            .getConfiguration('coolify')
            .update(
              'envSyncConflictStrategy',
              message.conflictStrategy,
              vscode.ConfigurationTarget.Global
            );

          await this.refreshData();
        }
        break;
      case 'update-app-env':
        if (message.applicationId) {
          await vscode.commands.executeCommand(
            'coolify.updateEnvironmentVariable',
            {
              applicationId: message.applicationId,
              environmentVariableUuid: message.environmentVariableUuid,
              environmentVariableKey: message.environmentVariableKey,
            }
          );
          if (this.isViewValid()) {
            const envs = await this.listEnvironmentVariables(message.applicationId);
            this._view!.webview.postMessage({
              type: 'app-envs-data',
              applicationId: message.applicationId,
              envs: envs.map((env) => ({
                uuid: env.uuid,
                key: env.key,
                value: env.value,
              })),
            } as WebViewOutgoingMessage);
          }
        }
        break;
      case 'delete-app-env':
        if (message.applicationId) {
          await vscode.commands.executeCommand(
            'coolify.deleteEnvironmentVariable',
            {
              applicationId: message.applicationId,
              environmentVariableUuid: message.environmentVariableUuid,
              environmentVariableKey: message.environmentVariableKey,
            }
          );
          if (this.isViewValid()) {
            const envs = await this.listEnvironmentVariables(message.applicationId);
            this._view!.webview.postMessage({
              type: 'app-envs-data',
              applicationId: message.applicationId,
              envs: envs.map((env) => ({
                uuid: env.uuid,
                key: env.key,
                value: env.value,
              })),
            } as WebViewOutgoingMessage);
          }
        }
        break;
      case 'fetch-app-envs':
        if (message.applicationId && this.isViewValid()) {
          const envs = await this.listEnvironmentVariables(message.applicationId);
          this._view!.webview.postMessage({
            type: 'app-envs-data',
            applicationId: message.applicationId,
            envs: envs.map((env) => ({
              uuid: env.uuid,
              key: env.key,
              value: env.value,
            })),
          } as WebViewOutgoingMessage);
        }
        break;
      case 'fetch-service-details':
        if (message.serviceId && this.isViewValid()) {
          const details = await this.getServiceDetails(message.serviceId);
          this._view!.webview.postMessage({
            type: 'service-details-data',
            serviceId: message.serviceId,
            details,
          } as WebViewOutgoingMessage);
        }
        break;
      case 'fetch-database-details':
        if (message.databaseId && this.isViewValid()) {
          const details = await this.getDatabaseDetails(message.databaseId);
          this._view!.webview.postMessage({
            type: 'database-details-data',
            databaseId: message.databaseId,
            details,
          } as WebViewOutgoingMessage);
        }
        break;
      case 'fetch-project-details':
        if (message.projectId && this.isViewValid()) {
          const details = await this.getProjectDetails(message.projectId);
          this._view!.webview.postMessage({
            type: 'project-details-data',
            projectId: message.projectId,
            details,
          } as WebViewOutgoingMessage);
        }
        break;
      case 'fetch-database-backups':
        if (message.databaseId && this.isViewValid()) {
          const backups = await this.getDatabaseBackups(message.databaseId);
          this._view!.webview.postMessage({
            type: 'database-backups-data',
            databaseId: message.databaseId,
            backups,
          } as WebViewOutgoingMessage);
        }
        break;
      case 'create-database-backup':
        if (message.databaseId && this.isViewValid()) {
          const result = await this.createDatabaseBackup(message.databaseId);
          vscode.window.showInformationMessage(result);
          const backups = await this.getDatabaseBackups(message.databaseId);
          this._view!.webview.postMessage({
            type: 'database-backups-data',
            databaseId: message.databaseId,
            backups,
          } as WebViewOutgoingMessage);
        }
        break;
      case 'restore-database-backup':
        if (message.databaseId && message.backupId && this.isViewValid()) {
          const result = await this.restoreDatabaseBackup(
            message.databaseId,
            message.backupId
          );
          vscode.window.showInformationMessage(result);
          const backups = await this.getDatabaseBackups(message.databaseId);
          this._view!.webview.postMessage({
            type: 'database-backups-data',
            databaseId: message.databaseId,
            backups,
          } as WebViewOutgoingMessage);
        }
        break;
      case 'open-external-url':
        if (message.url) {
          const normalizedUrl = this.normalizeExternalUrl(message.url);
          if (!normalizedUrl) {
            vscode.window.showErrorMessage('Invalid URL to open.');
            break;
          }

          await vscode.env.openExternal(vscode.Uri.parse(normalizedUrl));
        }
        break;
      case 'switch-context':
        if (message.contextName) {
          await vscode.commands.executeCommand(
            'coolify.switchContext',
            message.contextName
          );
        }
        break;
      case 'create-context':
        await vscode.commands.executeCommand('coolify.createContext');
        break;
      case 'delete-context':
        await vscode.commands.executeCommand('coolify.deleteContext');
        break;
      case 'configure':
        await vscode.commands.executeCommand('coolify.configure');
        break;
      case 'reconfigure':
        await vscode.commands.executeCommand('coolify.reconfigure');
    }
  }

  private setupVisibilityHandler(webviewView: vscode.WebviewView): void {
    this.disposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.refreshData().catch((error) => {
            logger.error('Failed to refresh on visibility change', error);
          });
          this.startRefreshInterval();
        } else {
          this.stopRefreshInterval();
        }
      })
    );
  }

  private setupDisposalHandler(webviewView: vscode.WebviewView): void {
    this.disposables.push(
      webviewView.onDidDispose(() => {
        this.dispose();
      })
    );
  }

  private async handleUnconfiguredWebView(
    webviewView: vscode.WebviewView
  ): Promise<void> {
    this.currentUiState = 'unconfigured';
    this.stopRefreshInterval();
    if (this.isViewValid()) {
      webviewView.webview.html = await this.getWelcomeHtml();
    }
  }

  private async initializeConfiguredWebView(
    webviewView: vscode.WebviewView
  ): Promise<void> {
    this.currentUiState = 'loading';
    if (this.isViewValid()) {
      webviewView.webview.html = await this.getWebViewHtml();
      if (webviewView.visible) {
        this.startRefreshInterval();
      }
      await this.refreshData();
    }
  }

  // HTML Generation
  private getConfiguredLanguage(): CoolifyLanguage {
    const configured = vscode.workspace
      .getConfiguration('coolify')
      .get<string>('language', 'en');

    return configured === 'pt-BR' ? 'pt-BR' : 'en';
  }

  private async getWebViewHtml(): Promise<string> {
    const nonce = this.generateNonce();
    const cspSource = this._view?.webview.cspSource || '';
    const language = this.getConfiguredLanguage();
    const htmlPath = vscode.Uri.joinPath(
      this._extensionUri,
      'dist',
      'templates',
      'webview.html'
    );
    const fileData = await vscode.workspace.fs.readFile(htmlPath);
    let html = Buffer.from(fileData).toString('utf-8');
    html = html.replace(/\$\{nonce\}/g, nonce);
    html = html.replace(/\$\{cspSource\}/g, cspSource);
    html = html.replace(/\$\{uiLanguage\}/g, language);
    return html;
  }

  private async getWelcomeHtml(): Promise<string> {
    const nonce = this.generateNonce();
    const cspSource = this._view?.webview.cspSource || '';
    const language = this.getConfiguredLanguage();
    const logoUri = this._view?.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'public', 'logo.svg')
    );

    // Load welcome template and replace logo URI
    const welcomePath = vscode.Uri.joinPath(
      this._extensionUri,
      'dist',
      'templates',
      'welcome.html'
    );
    const fileData = await vscode.workspace.fs.readFile(welcomePath);
    let html = Buffer.from(fileData).toString('utf-8');
    html = html.replace('${logoUri}', logoUri?.toString() || '');
    html = html.replace(/\$\{nonce\}/g, nonce);
    html = html.replace(/\$\{cspSource\}/g, cspSource);
    html = html.replace(/\$\{uiLanguage\}/g, language);

    return html;
  }

  private generateNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
      nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
  }

  // Error Handling
  private handleError(message: string, error: unknown): void {
    logger.error(message, error);
    if (this.isViewValid()) {
      if (this.isAuthenticationError(error)) {
        this.handleAuthenticationError();
      } else if (error instanceof CoolifyApiError) {
        vscode.window.showErrorMessage(error.message);
      } else {
        vscode.window.showErrorMessage(`${message}. Please try again.`);
      }
    }
  }

  private isAuthenticationError(error: unknown): boolean {
    return error instanceof CoolifyApiError && error.type === 'auth';
  }

  private async handleAuthenticationError(): Promise<void> {
    await this.configManager.clearConfiguration();
    await vscode.commands.executeCommand(
      'setContext',
      'coolify.isConfigured',
      false
    );
    if (this.isViewValid()) {
      vscode.window.showErrorMessage(
        'Authentication failed. Please reconfigure the extension.'
      );
    }

    await this.transitionUiState(
      'unconfigured',
      'Authentication failed. Please reconfigure the extension.'
    );
  }

  private async handleRefreshError(error: unknown): Promise<void> {
    if (this.isAuthenticationError(error)) {
      await this.handleAuthenticationError();
    } else {
      const errorMessage =
        error instanceof CoolifyApiError
          ? error.message
          : 'Failed to refresh data. Please try again.';

      await this.transitionUiState('error', errorMessage);

      if (this.isViewValid()) {
        if (error instanceof CoolifyApiError) {
          vscode.window.showErrorMessage(error.message);
        } else {
          vscode.window.showErrorMessage(
            'Failed to refresh data. Please try again.'
          );
        }
      }
    }
    throw error;
  }

  public async getApplications(): Promise<ApplicationListItem[]> {
    try {
      const serverUrl = await this.configManager.getServerUrl();
      const token = await this.configManager.getToken();

      if (!serverUrl || !token) {
        throw new Error('Extension not configured properly');
      }

      const service = new CoolifyService(serverUrl, token);
      const applications = await service.getApplications();

      return applications.map((app) => ({
        id: app.uuid,
        name: sanitizeDisplayTextOrFallback(app.name, app.uuid),
        status: sanitizeDisplayTextOrFallback(app.status, 'unknown'),
        label: `${sanitizeDisplayTextOrFallback(app.name, app.uuid)} (${sanitizeDisplayText(app.git_repository)}:${sanitizeDisplayText(app.git_branch)})`,
      }));
    } catch (error) {
      logger.error('Failed to get applications', error);
      throw error;
    }
  }

  public async getDeployments(): Promise<DeploymentListItem[]> {
    try {
      const serverUrl = await this.configManager.getServerUrl();
      const token = await this.configManager.getToken();

      if (!serverUrl || !token) {
        throw new Error('Extension not configured properly');
      }

      const service = new CoolifyService(serverUrl, token);
      const deployments = await service.getDeployments();

      return deployments
        .map((deployment) => this.mapDeploymentToListItem(deployment))
        .sort((a, b) => this.toTimestamp(b.createdAt) - this.toTimestamp(a.createdAt));
    } catch (error) {
      logger.error('Failed to get deployments', error);
      throw error;
    }
  }

  public async getDeploymentsByApplication(
    applicationId: string,
    skip = 0,
    take = 20
  ): Promise<DeploymentListItem[]> {
    try {
      const serverUrl = await this.configManager.getServerUrl();
      const token = await this.configManager.getToken();

      if (!serverUrl || !token) {
        throw new Error('Extension not configured properly');
      }

      const service = new CoolifyService(serverUrl, token);
      const deployments = await service.getDeploymentsByApplication(
        applicationId,
        skip,
        take
      );

      return deployments
        .map((deployment) => this.mapDeploymentToListItem(deployment))
        .sort((a, b) => this.toTimestamp(b.createdAt) - this.toTimestamp(a.createdAt));
    } catch (error) {
      logger.error('Failed to get deployments by application', {
        applicationId,
        error,
      });
      throw error;
    }
  }

  public async getServices(): Promise<ServiceListItem[]> {
    try {
      const serverUrl = await this.configManager.getServerUrl();
      const token = await this.configManager.getToken();

      if (!serverUrl || !token) {
        throw new Error('Extension not configured properly');
      }

      const service = new CoolifyService(serverUrl, token);
      const services = await service.getServices();

      return services.map((item: ServiceResource) => ({
        id: item.uuid,
        name: sanitizeDisplayTextOrFallback(item.name, item.uuid),
        status: sanitizeDisplayTextOrFallback(item.status, 'unknown'),
        description: sanitizeDisplayText(item.description),
      }));
    } catch (error) {
      logger.error('Failed to get services', error);
      throw error;
    }
  }

  public async getServiceDetails(
    serviceId: string
  ): Promise<Array<{ key: string; value: string }>> {
    try {
      const serverUrl = await this.configManager.getServerUrl();
      const token = await this.configManager.getToken();

      if (!serverUrl || !token) {
        throw new Error('Extension not configured properly');
      }

      const service = new CoolifyService(serverUrl, token);
      const details = await service.getService(serviceId);
      const raw = details as unknown as Record<string, unknown>;

      return Object.entries(raw)
        .filter(([key]) => typeof key === 'string' && key.trim().length > 0)
        .map(([key, value]) => {
          const normalizedValue =
            value === null || value === undefined
              ? ''
              : typeof value === 'string'
                ? sanitizeDisplayText(value)
                : typeof value === 'number' || typeof value === 'boolean'
                  ? String(value)
                  : sanitizeDisplayText(JSON.stringify(value));

          return {
            key: sanitizeDisplayTextOrFallback(key, 'field'),
            value: sanitizeDisplayText(normalizedValue),
          };
        });
    } catch (error) {
      logger.error('Failed to get service details', {
        serviceId,
        error,
      });
      return [];
    }
  }

  public async getDatabases(): Promise<DatabaseListItem[]> {
    try {
      const serverUrl = await this.configManager.getServerUrl();
      const token = await this.configManager.getToken();

      if (!serverUrl || !token) {
        throw new Error('Extension not configured properly');
      }

      const service = new CoolifyService(serverUrl, token);
      const databases = await service.getDatabases();

      return databases.map((item: DatabaseResource) => ({
        id: item.uuid,
        name: sanitizeDisplayTextOrFallback(item.name, item.uuid),
        status: sanitizeDisplayTextOrFallback(item.status, 'unknown'),
        description: sanitizeDisplayText(item.description),
      }));
    } catch (error) {
      logger.error('Failed to get databases', error);
      throw error;
    }
  }

  public async getDatabaseDetails(
    databaseId: string
  ): Promise<Array<{ key: string; value: string }>> {
    try {
      const serverUrl = await this.configManager.getServerUrl();
      const token = await this.configManager.getToken();

      if (!serverUrl || !token) {
        throw new Error('Extension not configured properly');
      }

      const service = new CoolifyService(serverUrl, token);
      const details = await service.getDatabase(databaseId);
      const raw = details as unknown as Record<string, unknown>;

      return Object.entries(raw)
        .filter(([key]) => typeof key === 'string' && key.trim().length > 0)
        .map(([key, value]) => {
          const normalizedValue =
            value === null || value === undefined
              ? ''
              : typeof value === 'string'
                ? sanitizeDisplayText(value)
                : typeof value === 'number' || typeof value === 'boolean'
                  ? String(value)
                  : sanitizeDisplayText(JSON.stringify(value));

          return {
            key: sanitizeDisplayTextOrFallback(key, 'field'),
            value: sanitizeDisplayText(normalizedValue),
          };
        });
    } catch (error) {
      logger.error('Failed to get database details', {
        databaseId,
        error,
      });
      return [];
    }
  }

  public async getDatabaseBackups(
    databaseId: string
  ): Promise<
    Array<{
      id: string;
      name: string;
      status: string;
      createdAt: string;
      size: string;
    }>
  > {
    try {
      const serverUrl = await this.configManager.getServerUrl();
      const token = await this.configManager.getToken();

      if (!serverUrl || !token) {
        throw new Error('Extension not configured properly');
      }

      const service = new CoolifyService(serverUrl, token);
      const backups = await service.listDatabaseBackups(databaseId);

      return backups.map((backup: DatabaseBackupResource) => ({
        id: sanitizeDisplayTextOrFallback(backup.id, 'unknown'),
        name: sanitizeDisplayTextOrFallback(backup.name, 'backup'),
        status: sanitizeDisplayTextOrFallback(backup.status, 'unknown'),
        createdAt: sanitizeDisplayText(backup.created_at),
        size: sanitizeDisplayText(backup.size),
      }));
    } catch (error) {
      logger.error('Failed to get database backups', {
        databaseId,
        error,
      });
      return [];
    }
  }

  public async getProjects(): Promise<ProjectListItem[]> {
    try {
      const serverUrl = await this.configManager.getServerUrl();
      const token = await this.configManager.getToken();

      if (!serverUrl || !token) {
        throw new Error('Extension not configured properly');
      }

      const service = new CoolifyService(serverUrl, token);
      const projects = await service.getProjects();

      return projects.map((item: ProjectResource) => ({
        id: item.uuid,
        name: sanitizeDisplayTextOrFallback(item.name, item.uuid),
        description: sanitizeDisplayText(item.description),
      }));
    } catch (error) {
      logger.error('Failed to get projects', error);
      return [];
    }
  }

  public async getProjectDetails(
    projectId: string
  ): Promise<Array<{ key: string; value: string }>> {
    try {
      const serverUrl = await this.configManager.getServerUrl();
      const token = await this.configManager.getToken();

      if (!serverUrl || !token) {
        throw new Error('Extension not configured properly');
      }

      const service = new CoolifyService(serverUrl, token);
      const details = await service.getProject(projectId);
      const raw = details as unknown as Record<string, unknown>;

      const baseEntries = Object.entries(raw)
        .filter(([key]) => typeof key === 'string' && key.trim().length > 0)
        .map(([key, value]) => {
          const normalizedValue =
            value === null || value === undefined
              ? ''
              : typeof value === 'string'
                ? sanitizeDisplayText(value)
                : typeof value === 'number' || typeof value === 'boolean'
                  ? String(value)
                  : sanitizeDisplayText(JSON.stringify(value));

          return {
            key: sanitizeDisplayTextOrFallback(key, 'field'),
            value: sanitizeDisplayText(normalizedValue),
          };
        });

      const environments = Array.isArray(raw.environments)
        ? raw.environments
            .map((item) => {
              if (item && typeof item === 'object') {
                const env = item as Record<string, unknown>;
                const envName = env.name;
                if (typeof envName === 'string' && envName.trim().length > 0) {
                  return sanitizeDisplayText(envName);
                }
              }
              return '';
            })
            .filter((name) => !!name)
        : [];

      if (environments.length > 0) {
        baseEntries.push({
          key: 'environments',
          value: environments.join(', '),
        });
      }

      return baseEntries;
    } catch (error) {
      logger.error('Failed to get project details', {
        projectId,
        error,
      });
      return [];
    }
  }

  public async createDatabaseBackup(databaseId: string): Promise<string> {
    const serverUrl = await this.configManager.getServerUrl();
    const token = await this.configManager.getToken();

    if (!serverUrl || !token) {
      throw new Error('Extension not configured properly');
    }

    const service = new CoolifyService(serverUrl, token);
    const result = await service.createDatabaseBackup(databaseId);
    await this.refreshData();
    return result;
  }

  public async restoreDatabaseBackup(
    databaseId: string,
    backupId: string
  ): Promise<string> {
    const serverUrl = await this.configManager.getServerUrl();
    const token = await this.configManager.getToken();

    if (!serverUrl || !token) {
      throw new Error('Extension not configured properly');
    }

    const service = new CoolifyService(serverUrl, token);
    const result = await service.restoreDatabaseBackup(databaseId, backupId);
    await this.refreshData();
    return result;
  }

  public async getDeploymentDetails(
    deploymentId: string
  ): Promise<DeploymentListItem | undefined> {
    try {
      const serverUrl = await this.configManager.getServerUrl();
      const token = await this.configManager.getToken();

      if (!serverUrl || !token) {
        throw new Error('Extension not configured properly');
      }

      const service = new CoolifyService(serverUrl, token);
      const deployment = await service.getDeployment(deploymentId);

      return this.mapDeploymentToListItem(deployment);
    } catch (error) {
      logger.warn('Failed to get deployment details from details endpoint', {
        deploymentId,
        error,
      });
      const deployments = await this.getDeployments();
      return deployments.find((deployment) => deployment.id === deploymentId);
    }
  }

  public async getDeploymentLogs(deploymentId: string): Promise<string> {
    const serverUrl = await this.configManager.getServerUrl();
    const token = await this.configManager.getToken();

    if (!serverUrl || !token) {
      throw new Error('Extension not configured properly');
    }

    const service = new CoolifyService(serverUrl, token);
    return service.getDeploymentLogs(deploymentId);
  }

  public async cancelDeployment(deploymentId: string): Promise<void> {
    try {
      const serverUrl = await this.configManager.getServerUrl();
      const token = await this.configManager.getToken();

      if (!serverUrl || !token) {
        throw new Error('Extension not configured properly');
      }

      const service = new CoolifyService(serverUrl, token);
      await service.cancelDeployment(deploymentId);
      await this.refreshData();
    } catch (error) {
      logger.error('Failed to cancel deployment', error);
      throw error;
    }
  }

  public async listEnvironmentVariables(
    applicationId: string
  ): Promise<EnvironmentVariable[]> {
    const serverUrl = await this.configManager.getServerUrl();
    const token = await this.configManager.getToken();

    if (!serverUrl || !token) {
      throw new Error('Extension not configured properly');
    }

    const service = new CoolifyService(serverUrl, token);
    return service.listEnvironmentVariables(applicationId);
  }

  public async createEnvironmentVariable(
    applicationId: string,
    request: EnvironmentVariableCreateRequest
  ): Promise<EnvironmentVariable> {
    const serverUrl = await this.configManager.getServerUrl();
    const token = await this.configManager.getToken();

    if (!serverUrl || !token) {
      throw new Error('Extension not configured properly');
    }

    const service = new CoolifyService(serverUrl, token);
    return service.createEnvironmentVariable(applicationId, request);
  }

  public async updateEnvironmentVariable(
    applicationId: string,
    request: EnvironmentVariableUpdateRequest
  ): Promise<EnvironmentVariable> {
    const serverUrl = await this.configManager.getServerUrl();
    const token = await this.configManager.getToken();

    if (!serverUrl || !token) {
      throw new Error('Extension not configured properly');
    }

    const service = new CoolifyService(serverUrl, token);
    return service.updateEnvironmentVariable(applicationId, request);
  }

  public async deleteEnvironmentVariable(
    applicationId: string,
    environmentVariableUuid: string
  ): Promise<void> {
    const serverUrl = await this.configManager.getServerUrl();
    const token = await this.configManager.getToken();

    if (!serverUrl || !token) {
      throw new Error('Extension not configured properly');
    }

    const service = new CoolifyService(serverUrl, token);
    await service.deleteEnvironmentVariable(applicationId, environmentVariableUuid);
  }

  // Cleanup
  public dispose(): void {
    this.isDisposed = true;
    this.stopRefreshInterval();

    if (this.pendingRefresh) {
      clearTimeout(this.pendingRefresh);
      this.pendingRefresh = undefined;
    }

    if (this.messageHandler) {
      this.messageHandler.dispose();
      this.messageHandler = undefined;
    }

    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];

    this._view = undefined;
    this.deployingApplications.clear();
  }
}
