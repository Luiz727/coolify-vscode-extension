import * as vscode from 'vscode';
import { ConfigurationManager } from './managers/ConfigurationManager';
import { CoolifyWebViewProvider } from './providers/CoolifyWebViewProvider';
import { isValidUrl, normalizeUrl } from './utils/urlValidator';
import { CoolifyService } from './services/CoolifyService';
import type { EnvironmentVariable } from './services/CoolifyService';
import { logger } from './services/LoggerService';

let webviewProvider: CoolifyWebViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  logger.info('Activating Coolify extension');

  // Initialize managers and providers
  const configManager = new ConfigurationManager(context);
  webviewProvider = new CoolifyWebViewProvider(
    context.extensionUri,
    configManager
  );

  // Register the webview provider
  const webviewView = vscode.window.registerWebviewViewProvider(
    'coolify-deployments',
    webviewProvider
  );

  // Function to update configuration state
  async function updateConfigurationState() {
    const isConfigured = await configManager.isConfigured();
    await vscode.commands.executeCommand(
      'setContext',
      'coolify.isConfigured',
      isConfigured
    );

    // Update the webview if it exists
    webviewProvider?.updateView();
  }

  // Initial configuration state
  updateConfigurationState();

  // Register commands
  const configureCommand = vscode.commands.registerCommand(
    'coolify.configure',
    async () => {
      try {
        const activeContextName = await configManager.getActiveContextName();

        // Step 1: Get and validate server URL
        const serverUrl = await vscode.window.showInputBox({
          ignoreFocusOut: true,
          prompt: `Enter your Coolify server URL for context "${activeContextName}"`,
          placeHolder: 'e.g., https://coolify.example.com',
          validateInput: (value) => {
            if (!value) {
              return 'Server URL is required';
            }
            if (!isValidUrl(value)) {
              return 'Invalid URL format';
            }
            return null;
          },
        });

        if (!serverUrl) {
          return;
        }

        const normalizedUrl = normalizeUrl(serverUrl);
        const allowInsecureHttp = vscode.workspace
          .getConfiguration('coolify')
          .get<boolean>('allowInsecureHttp', false);

        const parsedUrl = new URL(normalizedUrl);
        if (parsedUrl.protocol === 'http:' && !allowInsecureHttp) {
          throw new Error(
            'Insecure HTTP is disabled. Use HTTPS or enable coolify.allowInsecureHttp in settings.'
          );
        }

        if (parsedUrl.protocol === 'http:' && allowInsecureHttp) {
          vscode.window.showWarningMessage(
            'You are using an insecure HTTP connection. Your API token may be exposed on the network.'
          );
        }

        // Test server connection
        const testService = new CoolifyService(normalizedUrl, '');
        const isReachable = await testService.testConnection();

        if (!isReachable) {
          throw new Error(
            'Could not connect to the Coolify server. Please check the URL and try again.'
          );
        }

        // Step 2: Get and validate access token
        const token = await vscode.window.showInputBox({
          ignoreFocusOut: true,
          prompt: `Enter your Coolify access token for context "${activeContextName}"`,
          password: true,
          placeHolder: 'Your Coolify API token',
          validateInput: (value) => {
            if (!value) {
              return 'Access token is required';
            }
            return null;
          },
        });

        if (!token) {
          return; // User cancelled
        }

        // Verify token
        const service = new CoolifyService(normalizedUrl, token);
        const isValid = await service.verifyToken();

        if (!isValid) {
          throw new Error(
            'Invalid access token. Please check your token and try again.'
          );
        }

        // Save configuration
        await configManager.setServerUrl(normalizedUrl);
        await configManager.setToken(token);
        await updateConfigurationState();

        vscode.window.showInformationMessage(
          `Coolify context "${activeContextName}" configured successfully!`
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          error instanceof Error
            ? error.message
            : 'Configuration failed. Please try again.'
        );
      }
    }
  );

  const reconfigureCommand = vscode.commands.registerCommand(
    'coolify.reconfigure',
    async () => {
      const activeContextName = await configManager.getActiveContextName();
      const result = await vscode.window.showWarningMessage(
        `This will clear configuration for context "${activeContextName}". Do you want to continue?`,
        'Yes',
        'No'
      );

      if (result === 'Yes') {
        await configManager.clearConfiguration();
        await updateConfigurationState();
        await vscode.commands.executeCommand('coolify.configure');
      }
    }
  );

  const createContextCommand = vscode.commands.registerCommand(
    'coolify.createContext',
    async () => {
      const contextName = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        prompt: 'Enter a name for the new context',
        placeHolder: 'e.g., prod, staging, dev',
        validateInput: (value) => {
          if (!value?.trim()) {
            return 'Context name is required';
          }

          return null;
        },
      });

      if (!contextName) {
        return;
      }

      try {
        await configManager.createContext(contextName);
        await configManager.setActiveContext(contextName);
        await updateConfigurationState();
        await vscode.commands.executeCommand('coolify.configure');
      } catch (error) {
        vscode.window.showErrorMessage(
          error instanceof Error ? error.message : 'Failed to create context'
        );
      }
    }
  );

  const switchContextCommand = vscode.commands.registerCommand(
    'coolify.switchContext',
    async () => {
      const contextNames = await configManager.getContextNames();
      if (contextNames.length === 0) {
        vscode.window.showInformationMessage(
          'No contexts found. Create one with Coolify: Create Context.'
        );
        return;
      }

      const activeContextName = await configManager.getActiveContextName();
      const selected = await vscode.window.showQuickPick(
        contextNames.map((name) => ({
          label: name,
          description: name === activeContextName ? 'active' : '',
        })),
        {
          placeHolder: 'Select the active Coolify context',
          title: 'Switch Coolify Context',
        }
      );

      if (!selected) {
        return;
      }

      await configManager.setActiveContext(selected.label);
      await updateConfigurationState();

      vscode.window.showInformationMessage(
        `Switched active context to "${selected.label}".`
      );
    }
  );

  const deleteContextCommand = vscode.commands.registerCommand(
    'coolify.deleteContext',
    async () => {
      const contextNames = await configManager.getContextNames();
      if (contextNames.length === 0) {
        vscode.window.showInformationMessage('No contexts found.');
        return;
      }

      const selected = await vscode.window.showQuickPick(contextNames, {
        placeHolder: 'Select a context to delete',
        title: 'Delete Coolify Context',
      });

      if (!selected) {
        return;
      }

      const confirmation = await vscode.window.showWarningMessage(
        `Delete context "${selected}"? This removes its saved URL/token.`,
        { modal: true },
        'Delete Context'
      );

      if (confirmation !== 'Delete Context') {
        return;
      }

      await configManager.deleteContext(selected);
      await updateConfigurationState();

      vscode.window.showInformationMessage(`Context "${selected}" deleted.`);
    }
  );

  const refreshApplicationsCommand = vscode.commands.registerCommand(
    'coolify.refreshApplications',
    async () => {
      if (webviewProvider) {
        await webviewProvider.refreshData();
      }
    }
  );

  const startDeploymentCommand = vscode.commands.registerCommand(
    'coolify.startDeployment',
    async () => {
      try {
        if (!webviewProvider) {
          vscode.window.showErrorMessage('Coolify provider not initialized');
          return;
        }
        const applications = await webviewProvider.getApplications();

        if (!applications || applications.length === 0) {
          vscode.window.showInformationMessage('No applications found');
          return;
        }

        const selected = await vscode.window.showQuickPick(
          applications.map((app) => ({
            label: app.name,
            description: app.status,
            detail: `Status: ${app.status}`,
            id: app.id,
          })),
          {
            placeHolder: 'Select an application to deploy',
            title: 'Start Deployment',
          }
        );

        if (selected) {
          await webviewProvider.deployApplication(selected.id);
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          error instanceof Error ? error.message : 'Failed to start deployment'
        );
      }
    }
  );

  async function executeApplicationLifecycleCommand(
    action: 'start' | 'stop' | 'restart'
  ) {
    try {
      if (!webviewProvider) {
        vscode.window.showErrorMessage('Coolify provider not initialized');
        return;
      }

      const applications = await webviewProvider.getApplications();
      if (!applications || applications.length === 0) {
        vscode.window.showInformationMessage('No applications found');
        return;
      }

      const selected = await vscode.window.showQuickPick(
        applications.map((app) => ({
          label: app.name,
          description: app.status,
          detail: `Status: ${app.status}`,
          id: app.id,
        })),
        {
          placeHolder: `Select an application to ${action}`,
          title: `${action.charAt(0).toUpperCase() + action.slice(1)} Application`,
        }
      );

      if (!selected) {
        return;
      }

      let resultMessage = '';
      switch (action) {
        case 'start':
          resultMessage = await webviewProvider.startApplication(selected.id);
          break;
        case 'stop':
          resultMessage = await webviewProvider.stopApplication(selected.id);
          break;
        case 'restart':
          resultMessage = await webviewProvider.restartApplication(selected.id);
          break;
      }

      vscode.window.showInformationMessage(resultMessage);
    } catch (error) {
      vscode.window.showErrorMessage(
        error instanceof Error
          ? error.message
          : `Failed to ${action} application`
      );
    }
  }

  const startApplicationCommand = vscode.commands.registerCommand(
    'coolify.startApplication',
    async () => {
      await executeApplicationLifecycleCommand('start');
    }
  );

  const stopApplicationCommand = vscode.commands.registerCommand(
    'coolify.stopApplication',
    async () => {
      await executeApplicationLifecycleCommand('stop');
    }
  );

  const restartApplicationCommand = vscode.commands.registerCommand(
    'coolify.restartApplication',
    async () => {
      await executeApplicationLifecycleCommand('restart');
    }
  );

  const showLogsCommand = vscode.commands.registerCommand(
    'coolify.showLogs',
    async () => {
      logger.show();
    }
  );

  async function selectApplication(
    presetApplicationId?: string
  ): Promise<{ id: string; name: string } | undefined> {
    if (!webviewProvider) {
      vscode.window.showErrorMessage('Coolify provider not initialized');
      return undefined;
    }

    const applications = await webviewProvider.getApplications();
    if (!applications || applications.length === 0) {
      vscode.window.showInformationMessage('No applications found');
      return undefined;
    }

    if (presetApplicationId) {
      const matched = applications.find((app) => app.id === presetApplicationId);
      if (matched) {
        return { id: matched.id, name: matched.name };
      }
    }

    const selected = await vscode.window.showQuickPick(
      applications.map((app) => ({
        label: app.name,
        description: app.status,
        detail: `Status: ${app.status}`,
        id: app.id,
      })),
      {
        placeHolder: 'Select an application',
        title: 'Coolify Applications',
      }
    );

    if (!selected) {
      return undefined;
    }

    return { id: selected.id, name: selected.label };
  }

  function mapEnvToQuickPickItem(env: EnvironmentVariable) {
    return {
      label: env.key,
      description: env.uuid,
      detail: env.value ? '********' : '(empty)',
      env,
    };
  }

  const listEnvironmentVariablesCommand = vscode.commands.registerCommand(
    'coolify.listEnvironmentVariables',
    async (applicationId?: string) => {
      try {
        if (!webviewProvider) {
          vscode.window.showErrorMessage('Coolify provider not initialized');
          return;
        }

        const selectedApp = await selectApplication(applicationId);
        if (!selectedApp) {
          return;
        }

        const envs = await webviewProvider.listEnvironmentVariables(selectedApp.id);
        if (!envs.length) {
          vscode.window.showInformationMessage(
            `No environment variables found for ${selectedApp.name}.`
          );
          return;
        }

        const document = await vscode.workspace.openTextDocument({
          language: 'json',
          content: JSON.stringify(
            envs.map((env) => ({
              uuid: env.uuid,
              key: env.key,
              value: '********',
              is_buildtime: env.is_buildtime,
              is_runtime: env.is_runtime,
              is_preview: env.is_preview,
            })),
            null,
            2
          ),
        });

        await vscode.window.showTextDocument(document, { preview: true });
      } catch (error) {
        vscode.window.showErrorMessage(
          error instanceof Error
            ? error.message
            : 'Failed to list environment variables'
        );
      }
    }
  );

  const createEnvironmentVariableCommand = vscode.commands.registerCommand(
    'coolify.createEnvironmentVariable',
    async (applicationId?: string) => {
      try {
        if (!webviewProvider) {
          vscode.window.showErrorMessage('Coolify provider not initialized');
          return;
        }

        const selectedApp = await selectApplication(applicationId);
        if (!selectedApp) {
          return;
        }

        const key = await vscode.window.showInputBox({
          ignoreFocusOut: true,
          prompt: `Environment variable key for ${selectedApp.name}`,
          placeHolder: 'e.g., API_KEY',
          validateInput: (value) => (!value?.trim() ? 'Key is required' : null),
        });
        if (!key) {
          return;
        }

        const value = await vscode.window.showInputBox({
          ignoreFocusOut: true,
          prompt: `Environment variable value for ${key}`,
          password: true,
          validateInput: (input) =>
            input === undefined ? 'Value is required' : null,
        });
        if (value === undefined) {
          return;
        }

        await webviewProvider.createEnvironmentVariable(selectedApp.id, {
          key,
          value,
          is_buildtime: true,
          is_runtime: true,
          is_preview: false,
        });

        vscode.window.showInformationMessage(
          `Environment variable "${key}" created for ${selectedApp.name}.`
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          error instanceof Error
            ? error.message
            : 'Failed to create environment variable'
        );
      }
    }
  );

  const updateEnvironmentVariableCommand = vscode.commands.registerCommand(
    'coolify.updateEnvironmentVariable',
    async (applicationId?: string) => {
      try {
        if (!webviewProvider) {
          vscode.window.showErrorMessage('Coolify provider not initialized');
          return;
        }

        const selectedApp = await selectApplication(applicationId);
        if (!selectedApp) {
          return;
        }

        const envs = await webviewProvider.listEnvironmentVariables(selectedApp.id);
        if (!envs.length) {
          vscode.window.showInformationMessage(
            `No environment variables found for ${selectedApp.name}.`
          );
          return;
        }

        const selectedEnvItem = await vscode.window.showQuickPick(
          envs.map(mapEnvToQuickPickItem),
          {
            placeHolder: 'Select an environment variable to update',
            title: 'Update Environment Variable',
          }
        );

        if (!selectedEnvItem) {
          return;
        }

        const nextValue = await vscode.window.showInputBox({
          ignoreFocusOut: true,
          prompt: `New value for ${selectedEnvItem.label}`,
          password: true,
          validateInput: (input) =>
            input === undefined ? 'Value is required' : null,
        });

        if (nextValue === undefined) {
          return;
        }

        await webviewProvider.updateEnvironmentVariable(selectedApp.id, {
          uuid: selectedEnvItem.env.uuid,
          key: selectedEnvItem.env.key,
          value: nextValue,
        });

        vscode.window.showInformationMessage(
          `Environment variable "${selectedEnvItem.label}" updated for ${selectedApp.name}.`
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          error instanceof Error
            ? error.message
            : 'Failed to update environment variable'
        );
      }
    }
  );

  const deleteEnvironmentVariableCommand = vscode.commands.registerCommand(
    'coolify.deleteEnvironmentVariable',
    async (applicationId?: string) => {
      try {
        if (!webviewProvider) {
          vscode.window.showErrorMessage('Coolify provider not initialized');
          return;
        }

        const selectedApp = await selectApplication(applicationId);
        if (!selectedApp) {
          return;
        }

        const envs = await webviewProvider.listEnvironmentVariables(selectedApp.id);
        if (!envs.length) {
          vscode.window.showInformationMessage(
            `No environment variables found for ${selectedApp.name}.`
          );
          return;
        }

        const selectedEnvItem = await vscode.window.showQuickPick(
          envs.map(mapEnvToQuickPickItem),
          {
            placeHolder: 'Select an environment variable to delete',
            title: 'Delete Environment Variable',
          }
        );

        if (!selectedEnvItem) {
          return;
        }

        const confirmation = await vscode.window.showWarningMessage(
          `Delete environment variable "${selectedEnvItem.label}" from ${selectedApp.name}?`,
          { modal: true },
          'Delete Variable'
        );

        if (confirmation !== 'Delete Variable') {
          return;
        }

        await webviewProvider.deleteEnvironmentVariable(
          selectedApp.id,
          selectedEnvItem.env.uuid
        );

        vscode.window.showInformationMessage(
          `Environment variable "${selectedEnvItem.label}" deleted from ${selectedApp.name}.`
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          error instanceof Error
            ? error.message
            : 'Failed to delete environment variable'
        );
      }
    }
  );

  const selectLanguageCommand = vscode.commands.registerCommand(
    'coolify.selectLanguage',
    async () => {
      const selected = await vscode.window.showQuickPick(
        [
          {
            label: 'Português (Brasil)',
            description: 'pt-BR',
            value: 'pt-BR',
          },
          {
            label: 'English',
            description: 'en',
            value: 'en',
          },
        ],
        {
          placeHolder: 'Select the extension language',
          title: 'Coolify Language',
        }
      );

      if (!selected) {
        return;
      }

      await vscode.workspace
        .getConfiguration('coolify')
        .update('language', selected.value, vscode.ConfigurationTarget.Global);

      await updateConfigurationState();

      vscode.window.showInformationMessage(
        selected.value === 'pt-BR'
          ? 'Idioma alterado para Português (Brasil).'
          : 'Language changed to English.'
      );
    }
  );

  const listDeploymentsCommand = vscode.commands.registerCommand(
    'coolify.listDeployments',
    async () => {
      try {
        if (!webviewProvider) {
          vscode.window.showErrorMessage('Coolify provider not initialized');
          return;
        }

        const deployments = await webviewProvider.getDeployments();
        if (!deployments.length) {
          vscode.window.showInformationMessage('No deployments found');
          return;
        }

        const selected = await vscode.window.showQuickPick(
          deployments.map((deployment) => ({
            label: `${deployment.applicationName} (${deployment.status})`,
            description: deployment.id,
            detail: `Started: ${new Date(deployment.createdAt).toLocaleString()}`,
            id: deployment.id,
          })),
          {
            placeHolder: 'Select a deployment to view details',
            title: 'Coolify Deployments',
          }
        );

        if (selected) {
          await vscode.commands.executeCommand(
            'coolify.showDeploymentDetails',
            selected.id
          );
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          error instanceof Error ? error.message : 'Failed to list deployments'
        );
      }
    }
  );

  const showDeploymentDetailsCommand = vscode.commands.registerCommand(
    'coolify.showDeploymentDetails',
    async (deploymentId?: string) => {
      try {
        if (!webviewProvider) {
          vscode.window.showErrorMessage('Coolify provider not initialized');
          return;
        }

        let selectedDeploymentId = deploymentId;

        if (!selectedDeploymentId) {
          const deployments = await webviewProvider.getDeployments();
          if (!deployments.length) {
            vscode.window.showInformationMessage('No deployments found');
            return;
          }

          const selected = await vscode.window.showQuickPick(
            deployments.map((deployment) => ({
              label: `${deployment.applicationName} (${deployment.status})`,
              description: deployment.id,
              detail: `Started: ${new Date(deployment.createdAt).toLocaleString()}`,
              id: deployment.id,
            })),
            {
              placeHolder: 'Select a deployment to inspect',
              title: 'Deployment Details',
            }
          );

          if (!selected) {
            return;
          }

          selectedDeploymentId = selected.id;
        }

        const deployment = await webviewProvider.getDeploymentDetails(
          selectedDeploymentId
        );

        if (!deployment) {
          vscode.window.showErrorMessage('Deployment not found');
          return;
        }

        const document = await vscode.workspace.openTextDocument({
          language: 'json',
          content: JSON.stringify(
            {
              ...deployment,
              startedAt: new Date(deployment.createdAt).toLocaleString(),
            },
            null,
            2
          ),
        });
        await vscode.window.showTextDocument(document, {
          preview: true,
        });
      } catch (error) {
        vscode.window.showErrorMessage(
          error instanceof Error
            ? error.message
            : 'Failed to show deployment details'
        );
      }
    }
  );

  const cancelDeploymentCommand = vscode.commands.registerCommand(
    'coolify.cancelDeployment',
    async () => {
      try {
        if (!webviewProvider) {
          vscode.window.showErrorMessage('Coolify provider not initialized');
          return;
        }

        const deployments = await webviewProvider.getDeployments();
        if (!deployments.length) {
          vscode.window.showInformationMessage('No deployments found');
          return;
        }

        const selected = await vscode.window.showQuickPick(
          deployments.map((deployment) => ({
            label: `${deployment.applicationName} (${deployment.status})`,
            description: deployment.id,
            detail: `Started: ${new Date(deployment.createdAt).toLocaleString()}`,
            id: deployment.id,
          })),
          {
            placeHolder: 'Select a deployment to cancel',
            title: 'Cancel Deployment',
          }
        );

        if (!selected) {
          return;
        }

        const confirmation = await vscode.window.showWarningMessage(
          `Are you sure you want to cancel deployment ${selected.id}?`,
          { modal: true },
          'Cancel Deployment'
        );

        if (confirmation !== 'Cancel Deployment') {
          return;
        }

        await webviewProvider.cancelDeployment(selected.id);
        vscode.window.showInformationMessage(
          `Deployment ${selected.id} cancellation requested.`
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          error instanceof Error
            ? error.message
            : 'Failed to cancel deployment'
        );
      }
    }
  );

  const showDeploymentLogsCommand = vscode.commands.registerCommand(
    'coolify.showDeploymentLogs',
    async () => {
      try {
        if (!webviewProvider) {
          vscode.window.showErrorMessage('Coolify provider not initialized');
          return;
        }

        const deployments = await webviewProvider.getDeployments();
        if (!deployments.length) {
          vscode.window.showInformationMessage('No deployments found');
          return;
        }

        const selected = await vscode.window.showQuickPick(
          deployments.map((deployment) => ({
            label: `${deployment.applicationName} (${deployment.status})`,
            description: deployment.id,
            detail: `Started: ${new Date(deployment.createdAt).toLocaleString()}`,
            id: deployment.id,
          })),
          {
            placeHolder: 'Select a deployment to view logs',
            title: 'Deployment Logs',
          }
        );

        if (!selected) {
          return;
        }

        const logs = await webviewProvider.getDeploymentLogs(selected.id);
        const document = await vscode.workspace.openTextDocument({
          language: 'log',
          content: logs || 'No logs available for this deployment.',
        });
        await vscode.window.showTextDocument(document, {
          preview: true,
        });
      } catch (error) {
        vscode.window.showErrorMessage(
          error instanceof Error
            ? error.message
            : 'Failed to fetch deployment logs'
        );
      }
    }
  );

  // Add to subscriptions
  context.subscriptions.push(
    webviewView,
    configureCommand,
    reconfigureCommand,
    createContextCommand,
    switchContextCommand,
    deleteContextCommand,
    refreshApplicationsCommand,
    startDeploymentCommand,
    startApplicationCommand,
    stopApplicationCommand,
    restartApplicationCommand,
    showLogsCommand,
    listEnvironmentVariablesCommand,
    createEnvironmentVariableCommand,
    updateEnvironmentVariableCommand,
    deleteEnvironmentVariableCommand,
    selectLanguageCommand,
    listDeploymentsCommand,
    showDeploymentDetailsCommand,
    cancelDeploymentCommand,
    showDeploymentLogsCommand,
    webviewProvider
  );
}

export function deactivate() {
  logger.info('Deactivating Coolify extension');

  // Clean up any cached applications and deployment data
  if (webviewProvider) {
    webviewProvider.dispose();
  }
}
