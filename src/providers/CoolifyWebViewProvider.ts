import * as vscode from 'vscode';
import { ConfigurationManager } from '../managers/ConfigurationManager';
import { CoolifyApiError, CoolifyService } from '../services/CoolifyService';
import type {
  Application as CoolifyApplication,
  CreateBackupScheduleRequest,
  DatabaseBackupExecution,
  DatabaseBackupSchedule,
  DatabaseResource,
  Deployment as CoolifyDeployment,
  EnvironmentVariable,
  EnvironmentVariableCreateRequest,
  EnvironmentVariableUpdateRequest,
  ProjectResource,
  ServerResource,
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
import {
  formatTimestamp,
  mergeDeployments,
  resolveDeploymentId,
} from '../utils/deploymentIdentity';

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
  /** Distinguishes a live deployment from a historical one. */
  isRunning?: boolean;
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

/** Server health as shown in the sidebar — the VPS-level root-cause signals. */
interface ServerListItem {
  id: string;
  name: string;
  ip: string;
  proxyType: string;
  reachable: boolean;
  unreachableCount: number;
  highDiskUsage: boolean;
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
    | 'fetch-deployment-logs'
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
    | 'run-database-backup'
    | 'fetch-backup-executions'
    | 'fetch-app-runtime-logs'
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
  scheduleId?: string;
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
  servers: ServerListItem[];
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
  schedules: Array<{
    uuid: string;
    frequency: string;
    enabled: boolean;
    saveS3: boolean;
  }>;
}

interface BackupExecutionsMessage {
  type: 'backup-executions-data';
  databaseId: string;
  scheduleId: string;
  executions: Array<{
    uuid: string;
    status: string;
    createdAt: string;
    size: string;
    message: string;
  }>;
}

interface ApplicationRuntimeLogsMessage {
  type: 'app-runtime-logs-data';
  applicationId: string;
  logs: string;
}

interface ProjectDetailsMessage {
  type: 'project-details-data';
  projectId: string;
  details: Array<{
    key: string;
    value: string;
  }>;
}

interface DeploymentLogsMessage {
  type: 'deployment-logs-data';
  deploymentId: string;
  logs: string;
}

type WebViewOutgoingMessage =
  | RefreshDataMessage
  | DeploymentStatusMessage
  | AppEnvironmentVariablesMessage
  | ServiceDetailsMessage
  | DatabaseDetailsMessage
  | DatabaseBackupsMessage
  | BackupExecutionsMessage
  | ApplicationRuntimeLogsMessage
  | ProjectDetailsMessage
  | DeploymentLogsMessage
  | UiStateMessage;
type CoolifyLanguage = 'en' | 'pt-BR';

// Constants
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: 10000,
};

/**
 * Poll interval.
 *
 * At 5s with five endpoints per cycle a single open window issued ~60 requests
 * per minute against the VPS. 15s keeps the panel responsive at a third of the
 * cost, and refreshData is still called explicitly after every action.
 */
const REFRESH_INTERVAL = 15000;

/** Backoff ceiling while the API keeps failing. */
const REFRESH_BACKOFF_MAX_MS = 120000;

/** Recent deployments fetched per application to build the history view. */
const DEPLOYMENT_HISTORY_PER_APP = 5;

/**
 * Deployment history costs one request per application, so it must not run on
 * every cycle. Running deployments (a single request) stay live each refresh,
 * and the history is additionally invalidated the moment a deployment finishes
 * — so this ceiling only governs how long unchanged history is reused.
 */
const DEPLOYMENT_HISTORY_TTL_MS = 300000;

/** Projects and servers change rarely; no reason to re-read them every cycle. */
const SLOW_RESOURCE_TTL_MS = 60000;

const DEPLOYMENT_HISTORY_CACHE_KEY = 'deployment-history';

export class CoolifyWebViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private refreshInterval?: NodeJS.Timeout;
  private messageHandler?: vscode.Disposable;
  private isDisposed = false;
  private deployingApplications = new Set<string>();
  private pendingRefresh?: NodeJS.Timeout;
  /** Lives for the whole provider (configuration listener). */
  private disposables: vscode.Disposable[] = [];
  /** Rebound on every resolveWebviewView; cleared to avoid duplicates. */
  private viewDisposables: vscode.Disposable[] = [];
  private currentUiState: UiState = 'loading';
  private lastRefreshErrorMessage = '';
  private consecutiveRefreshFailures = 0;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private configManager: ConfigurationManager
  ) {
    this.initializeConfigurationListener();
  }

  /**
   * Time-based cache for data that does not need to be re-read every cycle.
   *
   * Fetching the deployment history of every application on each refresh made
   * the request count grow with the number of applications — at 20 apps it
   * cost more than the original 5s polling it was meant to replace.
   */
  private slowCache = new Map<string, { value: unknown; storedAt: number }>();

  /** Used to detect the moment a deployment stops running (i.e. finishes). */
  private previousRunningDeploymentIds = new Set<string>();

  private async readCached<T>(
    key: string,
    ttlMs: number,
    load: () => Promise<T>
  ): Promise<T> {
    const cached = this.slowCache.get(key);
    if (cached && Date.now() - cached.storedAt < ttlMs) {
      return cached.value as T;
    }

    const value = await load();
    this.slowCache.set(key, { value, storedAt: Date.now() });
    return value;
  }

  /** Forces the next refresh to re-read everything (used after a write). */
  private invalidateSlowCache(): void {
    this.slowCache.clear();
  }

  /**
   * Builds a configured API client for the active context.
   * Centralises the "is it configured?" check that every public method needs.
   */
  private async createService(): Promise<CoolifyService> {
    const serverUrl = await this.configManager.getServerUrl();
    const token = await this.configManager.getToken();

    if (!serverUrl || !token) {
      throw new Error('Extension not configured properly');
    }

    return new CoolifyService(serverUrl, token);
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

  /**
   * Retries an operation with exponential backoff.
   *
   * Only safe for READ operations. A write (deploy, start/stop, backup) that
   * times out may well have been accepted by the server, so retrying it would
   * queue a duplicate — which is how a single timeout used to become three
   * deployments of the same application.
   */
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
    // An unclassified error is usually a bug in our own code (a TypeError, a
    // bad payload). Repeating it three times just repeats the bug.
    if (!(error instanceof CoolifyApiError)) {
      return false;
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
      clearTimeout(this.refreshInterval);
      this.refreshInterval = undefined;
    }
  }

  /**
   * Self-scheduling refresh loop with exponential backoff.
   *
   * A fixed interval kept hammering a struggling server every few seconds, and
   * giving up entirely after three failures left the panel permanently frozen
   * until the user noticed. Backing off recovers on its own once the API does.
   */
  private startRefreshInterval(): void {
    this.stopRefreshInterval();
    this.consecutiveRefreshFailures = 0;

    const scheduleNext = () => {
      if (this.isDisposed) {
        return;
      }

      const delay =
        this.consecutiveRefreshFailures === 0
          ? REFRESH_INTERVAL
          : Math.min(
              REFRESH_INTERVAL * 2 ** this.consecutiveRefreshFailures,
              REFRESH_BACKOFF_MAX_MS
            );

      this.refreshInterval = setTimeout(async () => {
        try {
          await this.refreshData();
          this.consecutiveRefreshFailures = 0;
        } catch (error) {
          this.consecutiveRefreshFailures += 1;
          logger.warn('Auto-refresh failed', {
            attempt: this.consecutiveRefreshFailures,
            error,
          });
        }

        scheduleNext();
      }, delay);
    };

    scheduleNext();
  }

  // Data Management
  public async refreshData(): Promise<void> {
    if (!this.isViewValid()) {
      return;
    }

    this.lastRefreshErrorMessage = '';

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
        const applications = await service.getApplications();

        // /deployments alone only reports what is running right now, so the
        // panel would be empty on an idle system. Compose it with the recent
        // history of each application.
        // Running deployments are one cheap request and must be live.
        const running = await service.getRunningDeployments().catch((error) => {
          logger.warn('Failed to list running deployments', error);
          return [] as CoolifyDeployment[];
        });

        // A deployment leaving the running list means it just finished, so the
        // history is stale right now regardless of its TTL. Refreshing on that
        // signal keeps the list correct without paying for a fan-out every cycle.
        const runningIds = new Set(running.map((item) => resolveDeploymentId(item)));
        const finishedSinceLastCycle = [...this.previousRunningDeploymentIds].some(
          (id) => !runningIds.has(id)
        );
        if (finishedSinceLastCycle) {
          this.slowCache.delete(DEPLOYMENT_HISTORY_CACHE_KEY);
        }
        this.previousRunningDeploymentIds = runningIds;

        const applicationUuids = applications.map((application) => application.uuid);
        const history = await this.readCached(
          DEPLOYMENT_HISTORY_CACHE_KEY,
          DEPLOYMENT_HISTORY_TTL_MS,
          () =>
            service.getDeploymentHistoryOnly(
              applicationUuids,
              DEPLOYMENT_HISTORY_PER_APP
            )
        );

        const deployments = mergeDeployments(running, history);

        const [servicesResult, databasesResult, projectsResult, serversResult] =
          await Promise.allSettled([
            service.getServices(),
            service.getDatabases(),
            this.readCached('projects', SLOW_RESOURCE_TTL_MS, () =>
              service.getProjects()
            ),
            this.readCached('servers', SLOW_RESOURCE_TTL_MS, () =>
              service.getServers()
            ),
          ]);

        const services =
          servicesResult.status === 'fulfilled' ? servicesResult.value : [];
        const databases =
          databasesResult.status === 'fulfilled' ? databasesResult.value : [];
        const projects =
          projectsResult.status === 'fulfilled' ? projectsResult.value : [];
        const servers =
          serversResult.status === 'fulfilled' ? serversResult.value : [];

        if (servicesResult.status === 'rejected') {
          logger.warn('Failed to load services for sidebar', servicesResult.reason);
        }

        if (databasesResult.status === 'rejected') {
          logger.warn('Failed to load databases for sidebar', databasesResult.reason);
        }

        if (projectsResult.status === 'rejected') {
          logger.warn('Failed to load projects for sidebar', projectsResult.reason);
        }

        if (serversResult.status === 'rejected') {
          logger.warn('Failed to load servers for sidebar', serversResult.reason);
        }

        await this.updateWebViewState(
          applications,
          deployments,
          services,
          databases,
          projects,
          servers,
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
        servers: [],
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
    servers: ServerResource[],
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
    const uiServers = this.mapServersToUI(servers);

    this._view!.webview.postMessage({
      type: 'refresh-data',
      applications: uiApplications,
      deployments: uiDeployments,
      services: uiServices,
      databases: uiDatabases,
      projects: uiProjects,
      servers: uiServers,
      contextNames,
      activeContextName,
      envSyncConflictStrategy,
    } as WebViewOutgoingMessage);

    this.lastRefreshErrorMessage = '';

    await this.transitionUiState('ready');
  }

  public getLastRefreshErrorMessage(): string {
    return this.lastRefreshErrorMessage;
  }

  /**
   * Refreshes without letting a display failure be mistaken for an action
   * failure. Use after a write has already been accepted by the server.
   */
  private async refreshDataQuietly(): Promise<void> {
    try {
      await this.refreshData();
    } catch (error) {
      logger.warn('Refresh after action failed; the action itself succeeded', error);
    }
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
    await vscode.commands.executeCommand(
      'setContext',
      'coolify.viewState',
      nextState
    );

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
    return deployments.map((d) => {
      // The API addresses deployments by UUID; the numeric id yields 404 on
      // /deployments/{uuid} and /deployments/{uuid}/cancel.
      const id = resolveDeploymentId(d);
      // application_id arrives as a number, which the string sanitizer drops —
      // converting first keeps the deployment linked to its application.
      const applicationId = sanitizeDisplayTextOrFallback(
        d.application_id === undefined || d.application_id === null
          ? ''
          : String(d.application_id),
        ''
      );

      return {
        id,
        applicationId,
        applicationName: sanitizeDisplayTextOrFallback(
          d.application_name,
          applicationId || id
        ),
        status: sanitizeDisplayTextOrFallback(d.status, 'unknown'),
        commit:
          sanitizeDisplayText(d.commit_message) ||
          `Deploying ${sanitizeDisplayText(d.commit).slice(0, 7) || 'latest'} commit`,
        // formatTimestamp returns '' instead of the string "Invalid Date".
        startedAt: formatTimestamp(sanitizeDisplayText(d.created_at)),
        externalUrl: this.normalizeExternalUrl(d.deployment_url),
        isRunning: d.isRunning === true,
      };
    });
  }

  // The in-memory cache of recently failed deployments was removed: real
  // history now comes from /deployments/applications/{uuid}, which survives
  // reloads and does not distort ordering by pinning stale entries on top.

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

  private mapServersToUI(servers: ServerResource[]): ServerListItem[] {
    return servers.map((item) => ({
      id: item.uuid,
      name: sanitizeDisplayTextOrFallback(item.name, item.uuid),
      ip: sanitizeDisplayText(item.ip),
      proxyType: sanitizeDisplayTextOrFallback(item.proxy_type, 'none'),
      // Coolify counts consecutive SSH failures; anything above zero means the
      // machine is not answering reliably.
      reachable: !(item.unreachable_count && item.unreachable_count > 0),
      unreachableCount: Number(item.unreachable_count) || 0,
      highDiskUsage: item.high_disk_usage_notification_sent === true,
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
      // Deliberately NOT wrapped in withRetry: /deploy is not idempotent, and a
      // timed-out request may already have been queued server-side. Retrying
      // would start the same application two or three times.
      const service = await this.createService();
      await service.startDeployment(applicationId);

      // The deployment already succeeded at this point. A failing refresh is a
      // display problem, not a deployment problem, so it must not surface as
      // "Failed to start deployment".
      await this.refreshDataQuietly();

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

    await this.refreshDataQuietly();
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

    await this.refreshDataQuietly();
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

    await this.refreshDataQuietly();
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

  /**
   * Disposes the listeners bound to the previous webview instance.
   *
   * resolveWebviewView runs again on every updateView(), so without this the
   * visibility and disposal handlers accumulated on each call — duplicated
   * listeners meant duplicated refreshes.
   */
  private cleanupExistingView(): void {
    if (this.messageHandler) {
      this.messageHandler.dispose();
      this.messageHandler = undefined;
    }

    this.viewDisposables.forEach((disposable) => disposable.dispose());
    this.viewDisposables = [];
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
      case 'fetch-deployment-logs':
        if (message.deploymentId && this.isViewValid()) {
          let logs = '';
          try {
            logs = await this.getDeploymentLogs(message.deploymentId);
          } catch (error) {
            logger.warn('Failed to fetch deployment logs for sidebar panel', {
              deploymentId: message.deploymentId,
              error,
            });
          }

          this._view!.webview.postMessage({
            type: 'deployment-logs-data',
            deploymentId: message.deploymentId,
            logs,
          } as WebViewOutgoingMessage);
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
          await this.postBackupSchedules(message.databaseId);
        }
        break;
      case 'create-database-backup':
        if (message.databaseId && this.isViewValid()) {
          // `frequency` is mandatory in the API, so ask for it instead of
          // sending an empty body that always answers 422.
          const frequency = await vscode.window.showQuickPick(
            [
              { label: 'Diario', value: 'daily' },
              { label: 'A cada hora', value: 'hourly' },
              { label: 'Semanal', value: 'weekly' },
              { label: 'Mensal', value: 'monthly' },
            ],
            {
              placeHolder: 'Frequencia do backup agendado',
              title: 'Criar agendamento de backup',
            }
          );

          if (!frequency) {
            break;
          }

          const runNow = await vscode.window.showQuickPick(['Sim', 'Nao'], {
            placeHolder: 'Executar um backup imediatamente apos criar?',
          });

          const result = await this.createBackupSchedule(message.databaseId, {
            frequency: frequency.value,
            enabled: true,
            backup_now: runNow === 'Sim',
          });
          vscode.window.showInformationMessage(result);
          await this.postBackupSchedules(message.databaseId);
        }
        break;
      case 'run-database-backup':
        if (message.databaseId && message.scheduleId && this.isViewValid()) {
          const result = await this.runBackupNow(
            message.databaseId,
            message.scheduleId
          );
          vscode.window.showInformationMessage(result);
          await this.postBackupSchedules(message.databaseId);
        }
        break;
      case 'fetch-app-runtime-logs':
        if (message.applicationId && this.isViewValid()) {
          const logs = await this.getApplicationRuntimeLogs(message.applicationId);
          this._view!.webview.postMessage({
            type: 'app-runtime-logs-data',
            applicationId: message.applicationId,
            logs,
          } as WebViewOutgoingMessage);
        }
        break;
      case 'fetch-backup-executions':
        if (message.databaseId && message.scheduleId && this.isViewValid()) {
          const executions = await this.getBackupExecutions(
            message.databaseId,
            message.scheduleId
          );
          this._view!.webview.postMessage({
            type: 'backup-executions-data',
            databaseId: message.databaseId,
            scheduleId: message.scheduleId,
            executions,
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
    // Bound to the current view instance; cleared by cleanupExistingView.
    this.viewDisposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.refreshData().catch((error) => {
            logger.error('Failed to refresh on visibility change', error);
          });
          this.startRefreshInterval();
        } else {
          // Nobody is looking at the panel: stop paying for it.
          this.stopRefreshInterval();
        }
      })
    );
  }

  private setupDisposalHandler(webviewView: vscode.WebviewView): void {
    this.viewDisposables.push(
      webviewView.onDidDispose(() => {
        this.dispose();
      })
    );
  }

  private async handleUnconfiguredWebView(
    webviewView: vscode.WebviewView
  ): Promise<void> {
    this.currentUiState = 'unconfigured';
    await vscode.commands.executeCommand(
      'setContext',
      'coolify.viewState',
      'unconfigured'
    );
    this.stopRefreshInterval();
    if (this.isViewValid()) {
      webviewView.webview.html = await this.getWelcomeHtml();
    }
  }

  private async initializeConfiguredWebView(
    webviewView: vscode.WebviewView
  ): Promise<void> {
    this.currentUiState = 'loading';
    await vscode.commands.executeCommand(
      'setContext',
      'coolify.viewState',
      'loading'
    );
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

  /**
   * Handles a 401 from Coolify.
   *
   * Deliberately does NOT wipe the stored credentials: a 401 is frequently
   * transient (Coolify restarting, a proxy in front returning 401, a brief
   * clock skew). Destroying the token on every occurrence forced a full
   * reconfiguration over a hiccup. The user is told what happened and decides.
   */
  private async handleAuthenticationError(): Promise<void> {
    const message =
      'Authentication failed. Your Coolify token was rejected. Reconfigure if the problem persists.';
    this.lastRefreshErrorMessage = message;

    await this.transitionUiState('error', message);

    if (this.isViewValid()) {
      const choice = await vscode.window.showErrorMessage(
        message,
        'Reconfigure',
        'Retry',
        'Dismiss'
      );

      if (choice === 'Reconfigure') {
        await this.configManager.clearConfiguration();
        await vscode.commands.executeCommand(
          'setContext',
          'coolify.isConfigured',
          false
        );
        await vscode.commands.executeCommand('coolify.configure');
      } else if (choice === 'Retry') {
        await this.refreshData().catch(() => undefined);
      }
    }
  }

  private async handleRefreshError(error: unknown): Promise<void> {
    if (this.isAuthenticationError(error)) {
      await this.handleAuthenticationError();
    } else {
      const errorMessage =
        error instanceof CoolifyApiError
          ? error.message
          : 'Failed to refresh data. Please try again.';

      this.lastRefreshErrorMessage = errorMessage;

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

  /**
   * Scheduled backup configurations (frequency, target), not backup files.
   * The actual runs come from getBackupExecutions.
   */
  public async getBackupSchedules(
    databaseId: string
  ): Promise<
    Array<{
      uuid: string;
      frequency: string;
      enabled: boolean;
      saveS3: boolean;
    }>
  > {
    try {
      const service = await this.createService();
      const schedules = await service.listBackupSchedules(databaseId);

      return schedules.map((schedule: DatabaseBackupSchedule) => ({
        uuid: sanitizeDisplayTextOrFallback(schedule.uuid, 'unknown'),
        frequency: sanitizeDisplayTextOrFallback(schedule.frequency, 'nao definida'),
        enabled: schedule.enabled !== false,
        saveS3: schedule.saveS3 === true,
      }));
    } catch (error) {
      logger.error('Failed to get backup schedules', { databaseId, error });
      return [];
    }
  }

  public async getBackupExecutions(
    databaseId: string,
    scheduleUuid: string
  ): Promise<
    Array<{
      uuid: string;
      status: string;
      createdAt: string;
      size: string;
      message: string;
    }>
  > {
    try {
      const service = await this.createService();
      const executions = await service.listBackupExecutions(
        databaseId,
        scheduleUuid
      );

      return executions.map((execution: DatabaseBackupExecution) => ({
        uuid: sanitizeDisplayTextOrFallback(execution.uuid, 'unknown'),
        status: sanitizeDisplayTextOrFallback(execution.status, 'unknown'),
        createdAt: sanitizeDisplayText(execution.createdAt),
        size: sanitizeDisplayText(execution.size),
        message: sanitizeDisplayText(execution.message),
      }));
    } catch (error) {
      logger.error('Failed to get backup executions', {
        databaseId,
        scheduleUuid,
        error,
      });
      return [];
    }
  }

  public async getServers(): Promise<ServerListItem[]> {
    try {
      const service = await this.createService();
      const servers = await service.getServers();
      return this.mapServersToUI(servers);
    } catch (error) {
      logger.error('Failed to get servers', error);
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

  private async postBackupSchedules(databaseId: string): Promise<void> {
    if (!this.isViewValid()) {
      return;
    }

    const schedules = await this.getBackupSchedules(databaseId);
    this._view!.webview.postMessage({
      type: 'database-backups-data',
      databaseId,
      schedules,
    } as WebViewOutgoingMessage);
  }

  /** Runtime container logs for an application. */
  public async getApplicationRuntimeLogs(applicationId: string): Promise<string> {
    try {
      const service = await this.createService();
      return await service.getApplicationLogs(applicationId);
    } catch (error) {
      logger.warn('Failed to fetch application runtime logs', {
        applicationId,
        error,
      });
      return '';
    }
  }

  public async updateEnvironmentVariablesBulk(
    applicationId: string,
    variables: EnvironmentVariableUpdateRequest[]
  ): Promise<void> {
    const service = await this.createService();
    await service.updateEnvironmentVariablesBulk(applicationId, variables);
  }

  public async createBackupSchedule(
    databaseId: string,
    request: CreateBackupScheduleRequest
  ): Promise<string> {
    const service = await this.createService();
    const result = await service.createBackupSchedule(databaseId, request);
    await this.refreshDataQuietly();
    return result;
  }

  /** Triggers an immediate run of an existing schedule. */
  public async runBackupNow(
    databaseId: string,
    scheduleUuid: string
  ): Promise<string> {
    const service = await this.createService();
    return service.runBackupNow(databaseId, scheduleUuid);
  }

  // NOTE: Coolify's API has no restore endpoint. Restoring a database backup
  // is a manual procedure — see docs/OPERATIONAL_GUIDE.md. Do not reintroduce
  // a restore button that cannot work.

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
    try {
      return await service.getDeploymentLogs(deploymentId);
    } catch (error) {
      logger.warn('Primary deployment logs lookup failed, trying fallback identifier', {
        deploymentId,
        error,
      });

      const deployments = await service.getDeployments();
      const match = deployments.find(
        (deployment) =>
          String(deployment.id) === deploymentId ||
          String(deployment.deployment_uuid || '') === deploymentId
      );

      const fallbackId =
        match?.deployment_uuid && String(match.deployment_uuid) !== deploymentId
          ? String(match.deployment_uuid)
          : undefined;

      if (!fallbackId) {
        throw error;
      }

      return service.getDeploymentLogs(fallbackId);
    }
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
      await this.refreshDataQuietly();
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

    this.viewDisposables.forEach((d) => d.dispose());
    this.viewDisposables = [];

    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];

    this._view = undefined;
    this.deployingApplications.clear();
  }
}
