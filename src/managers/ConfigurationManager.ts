import * as vscode from 'vscode';

interface CoolifyContextConfig {
  name: string;
  serverUrl: string;
}

export class ConfigurationManager {
  private static readonly SERVER_URL_KEY = 'serverUrl';
  private static readonly TOKEN_KEY = 'coolifyToken';
  private static readonly CONTEXTS_KEY = 'coolifyContexts';
  private static readonly ACTIVE_CONTEXT_KEY = 'coolifyActiveContext';
  private static readonly DEFAULT_CONTEXT_NAME = 'default';

  private migrationPromise?: Promise<void>;

  constructor(private context: vscode.ExtensionContext) {}

  private async ensureMigrated(): Promise<void> {
    if (!this.migrationPromise) {
      this.migrationPromise = this.migrateLegacyConfigurationIfNeeded();
    }

    await this.migrationPromise;
  }

  private getTokenKeyForContext(contextName: string): string {
    return `${ConfigurationManager.TOKEN_KEY}:${contextName}`;
  }

  private normalizeContextName(name: string): string {
    return name.trim();
  }

  private async getStoredContexts(): Promise<CoolifyContextConfig[]> {
    await this.ensureMigrated();
    return (
      this.context.globalState.get<CoolifyContextConfig[]>(
        ConfigurationManager.CONTEXTS_KEY
      ) || []
    );
  }

  private async setStoredContexts(
    contexts: CoolifyContextConfig[]
  ): Promise<void> {
    await this.context.globalState.update(ConfigurationManager.CONTEXTS_KEY, contexts);
  }

  private async migrateLegacyConfigurationIfNeeded(): Promise<void> {
    const contexts = this.context.globalState.get<CoolifyContextConfig[]>(
      ConfigurationManager.CONTEXTS_KEY
    );

    if (contexts && contexts.length > 0) {
      return;
    }

    const legacyUrl = this.context.globalState.get<string>(
      ConfigurationManager.SERVER_URL_KEY
    );
    const legacyToken = await this.context.secrets.get(
      ConfigurationManager.TOKEN_KEY
    );

    if (!legacyUrl || !legacyToken) {
      return;
    }

    const defaultContext: CoolifyContextConfig = {
      name: ConfigurationManager.DEFAULT_CONTEXT_NAME,
      serverUrl: legacyUrl,
    };

    await this.context.globalState.update(ConfigurationManager.CONTEXTS_KEY, [defaultContext]);
    await this.context.globalState.update(
      ConfigurationManager.ACTIVE_CONTEXT_KEY,
      ConfigurationManager.DEFAULT_CONTEXT_NAME
    );
    await this.context.secrets.store(
      this.getTokenKeyForContext(ConfigurationManager.DEFAULT_CONTEXT_NAME),
      legacyToken
    );

    await this.context.globalState.update(ConfigurationManager.SERVER_URL_KEY, undefined);
    await this.context.secrets.delete(ConfigurationManager.TOKEN_KEY);
  }

  async getActiveContextName(): Promise<string> {
    await this.ensureMigrated();

    const storedActiveContext = this.context.globalState.get<string>(
      ConfigurationManager.ACTIVE_CONTEXT_KEY
    );
    if (storedActiveContext) {
      return storedActiveContext;
    }

    const contexts = await this.getStoredContexts();
    if (contexts.length > 0) {
      const firstContext = contexts[0].name;
      await this.context.globalState.update(
        ConfigurationManager.ACTIVE_CONTEXT_KEY,
        firstContext
      );
      return firstContext;
    }

    await this.context.globalState.update(
      ConfigurationManager.ACTIVE_CONTEXT_KEY,
      ConfigurationManager.DEFAULT_CONTEXT_NAME
    );
    return ConfigurationManager.DEFAULT_CONTEXT_NAME;
  }

  async setActiveContext(contextName: string): Promise<void> {
    const normalizedName = this.normalizeContextName(contextName);
    if (!normalizedName) {
      throw new Error('Context name is required.');
    }

    await this.ensureMigrated();
    await this.context.globalState.update(
      ConfigurationManager.ACTIVE_CONTEXT_KEY,
      normalizedName
    );
  }

  async getContextNames(): Promise<string[]> {
    const contexts = await this.getStoredContexts();
    return contexts.map((contextConfig) => contextConfig.name);
  }

  async createContext(contextName: string): Promise<void> {
    const normalizedName = this.normalizeContextName(contextName);
    if (!normalizedName) {
      throw new Error('Context name is required.');
    }

    const contexts = await this.getStoredContexts();
    const exists = contexts.some((contextConfig) => contextConfig.name === normalizedName);
    if (exists) {
      throw new Error(`Context "${normalizedName}" already exists.`);
    }

    contexts.push({
      name: normalizedName,
      serverUrl: '',
    });

    await this.setStoredContexts(contexts);
  }

  async deleteContext(contextName: string): Promise<void> {
    const normalizedName = this.normalizeContextName(contextName);
    const contexts = await this.getStoredContexts();
    const filteredContexts = contexts.filter(
      (contextConfig) => contextConfig.name !== normalizedName
    );

    await this.setStoredContexts(filteredContexts);
    await this.context.secrets.delete(this.getTokenKeyForContext(normalizedName));

    const activeContextName = await this.getActiveContextName();
    if (activeContextName === normalizedName) {
      const nextContext =
        filteredContexts[0]?.name || ConfigurationManager.DEFAULT_CONTEXT_NAME;
      await this.context.globalState.update(
        ConfigurationManager.ACTIVE_CONTEXT_KEY,
        nextContext
      );
    }
  }

  private async getActiveContextConfig(): Promise<CoolifyContextConfig | undefined> {
    const activeContextName = await this.getActiveContextName();
    const contexts = await this.getStoredContexts();

    return contexts.find((contextConfig) => contextConfig.name === activeContextName);
  }

  async isConfigured(): Promise<boolean> {
    const serverUrl = await this.getServerUrl();
    const token = await this.getToken();
    return !!serverUrl && !!token;
  }

  async getServerUrl(): Promise<string | undefined> {
    const activeContextConfig = await this.getActiveContextConfig();
    return activeContextConfig?.serverUrl || undefined;
  }

  async getToken(): Promise<string | undefined> {
    const activeContextName = await this.getActiveContextName();
    return this.context.secrets.get(this.getTokenKeyForContext(activeContextName));
  }

  async setServerUrl(url: string): Promise<void> {
    const activeContextName = await this.getActiveContextName();
    const contexts = await this.getStoredContexts();
    const existingIndex = contexts.findIndex(
      (contextConfig) => contextConfig.name === activeContextName
    );

    if (existingIndex >= 0) {
      contexts[existingIndex] = {
        ...contexts[existingIndex],
        serverUrl: url,
      };
    } else {
      contexts.push({
        name: activeContextName,
        serverUrl: url,
      });
    }

    await this.setStoredContexts(contexts);
  }

  async setToken(token: string): Promise<void> {
    const activeContextName = await this.getActiveContextName();
    await this.context.secrets.store(
      this.getTokenKeyForContext(activeContextName),
      token
    );
  }

  async clearConfiguration(): Promise<void> {
    const activeContextName = await this.getActiveContextName();
    const contexts = await this.getStoredContexts();
    const updatedContexts = contexts.map((contextConfig) =>
      contextConfig.name === activeContextName
        ? { ...contextConfig, serverUrl: '' }
        : contextConfig
    );

    await this.setStoredContexts(updatedContexts);
    await this.context.secrets.delete(this.getTokenKeyForContext(activeContextName));
  }
}
