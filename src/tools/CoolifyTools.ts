import * as vscode from 'vscode';
import { ConfigurationManager } from '../managers/ConfigurationManager';
import { CoolifyService } from '../services/CoolifyService';
import type {
  Application as CoolifyApplication,
} from '../services/CoolifyService';
import { logger } from '../services/LoggerService';

type LmTool = {
  invoke: (options: { input?: unknown }, token: vscode.CancellationToken) => Promise<unknown>;
  prepareInvocation?: (options: { input?: unknown }, token: vscode.CancellationToken) => unknown;
};

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function toText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function createToolResult(value: unknown): unknown {
  const vscodeAny = vscode as unknown as {
    LanguageModelTextPart?: new (value: string) => unknown;
    LanguageModelToolResult?: new (content: unknown[]) => unknown;
  };

  if (vscodeAny.LanguageModelTextPart && vscodeAny.LanguageModelToolResult) {
    return new vscodeAny.LanguageModelToolResult([
      new vscodeAny.LanguageModelTextPart(toText(value)),
    ]);
  }

  return { content: [{ value: toText(value) }] };
}

async function getService(configManager: ConfigurationManager): Promise<CoolifyService> {
  const serverUrl = await configManager.getServerUrl();
  const token = await configManager.getToken();

  if (!serverUrl || !token) {
    throw new Error(
      'Coolify não está configurado. Use a ferramenta coolify.configure primeiro.'
    );
  }

  return new CoolifyService(serverUrl, token);
}

async function findApplicationByInput(
  service: CoolifyService,
  appId?: string,
  appName?: string
): Promise<CoolifyApplication> {
  const applications = await service.getApplications();
  if (!applications.length) {
    throw new Error('Nenhuma aplicação encontrada no Coolify.');
  }

  if (appId) {
    const byId = applications.find((app) => app.uuid === appId);
    if (byId) {
      return byId;
    }
  }

  if (appName) {
    const target = normalize(appName);
    const exact = applications.find((app) => normalize(app.name) === target);
    if (exact) {
      return exact;
    }

    const partial = applications.find((app) => normalize(app.name).includes(target));
    if (partial) {
      return partial;
    }
  }

  if (applications.length === 1) {
    return applications[0];
  }

  throw new Error(
    'Aplicação não encontrada. Informe appId ou appName com um valor válido.'
  );
}

function toolPrepareMessage(message: string): unknown {
  return {
    invocationMessage: message,
  };
}

export function registerCoolifyTools(
  configManager: ConfigurationManager
): vscode.Disposable[] {
  const lmApi = (vscode as unknown as {
    lm?: {
      registerTool?: (name: string, tool: LmTool) => vscode.Disposable;
    };
  }).lm;

  if (!lmApi?.registerTool) {
    logger.info('VS Code lm.registerTool API is not available in this runtime.');
    return [];
  }

  const tools: Array<[string, LmTool]> = [
    [
      'coolify-configure',
      {
        prepareInvocation: () => toolPrepareMessage('Iniciando configuração do Coolify...'),
        invoke: async () => {
          await vscode.commands.executeCommand('coolify.configure');
          return createToolResult({
            ok: true,
            message: 'Fluxo de configuração iniciado.',
          });
        },
      },
    ],
    [
      'coolify-healthCheck',
      {
        prepareInvocation: () => toolPrepareMessage('Executando health check do Coolify...'),
        invoke: async () => {
          const serverUrl = await configManager.getServerUrl();
          const token = await configManager.getToken();

          if (!serverUrl || !token) {
            return createToolResult({
              ok: false,
              configured: false,
              message: 'Coolify não configurado.',
            });
          }

          const service = new CoolifyService(serverUrl, token);
          const [reachable, tokenValid] = await Promise.all([
            service.testConnection(),
            service.verifyToken(),
          ]);

          return createToolResult({
            ok: reachable && tokenValid,
            configured: true,
            serverUrl,
            reachable,
            tokenValid,
          });
        },
      },
    ],
    [
      'coolify-listApplications',
      {
        prepareInvocation: () => toolPrepareMessage('Listando aplicações do Coolify...'),
        invoke: async () => {
          const service = await getService(configManager);
          const applications = await service.getApplications();

          return createToolResult({
            count: applications.length,
            applications: applications.map((app) => ({
              id: app.uuid,
              name: app.name,
              status: app.status,
              branch: app.git_branch,
              fqdn: app.fqdn,
            })),
          });
        },
      },
    ],
    [
      'coolify-getApplicationStatus',
      {
        prepareInvocation: () => toolPrepareMessage('Consultando status da aplicação...'),
        invoke: async (options) => {
          const input = (options.input || {}) as {
            appId?: string;
            appName?: string;
          };

          const service = await getService(configManager);
          const app = await findApplicationByInput(service, input.appId, input.appName);

          return createToolResult({
            id: app.uuid,
            name: app.name,
            status: app.status,
            branch: app.git_branch,
            fqdn: app.fqdn,
          });
        },
      },
    ],
    [
      'coolify-startDeployment',
      {
        prepareInvocation: () => toolPrepareMessage('Iniciando deployment da aplicação...'),
        invoke: async (options) => {
          const input = (options.input || {}) as {
            appId?: string;
            appName?: string;
          };

          const service = await getService(configManager);
          const app = await findApplicationByInput(service, input.appId, input.appName);
          await service.startDeployment(app.uuid);

          return createToolResult({
            ok: true,
            message: `Deployment iniciado para ${app.name}.`,
            appId: app.uuid,
            appName: app.name,
          });
        },
      },
    ],
    [
      'coolify-applicationLifecycle',
      {
        prepareInvocation: (options) => {
          const input = (options.input || {}) as { action?: string };
          const action = input.action || 'start';
          return toolPrepareMessage(`Executando ação ${action} na aplicação...`);
        },
        invoke: async (options) => {
          const input = (options.input || {}) as {
            appId?: string;
            appName?: string;
            action?: 'start' | 'stop' | 'restart';
          };

          const action = input.action || 'start';
          if (!['start', 'stop', 'restart'].includes(action)) {
            throw new Error('Ação inválida. Use start, stop ou restart.');
          }

          const service = await getService(configManager);
          const app = await findApplicationByInput(service, input.appId, input.appName);

          let message = '';
          if (action === 'start') {
            message = await service.startApplication(app.uuid);
          } else if (action === 'stop') {
            message = await service.stopApplication(app.uuid);
          } else {
            message = await service.restartApplication(app.uuid);
          }

          return createToolResult({
            ok: true,
            action,
            appId: app.uuid,
            appName: app.name,
            message,
          });
        },
      },
    ],
    [
      'coolify-getDeploymentLogs',
      {
        prepareInvocation: () => toolPrepareMessage('Obtendo logs do deployment...'),
        invoke: async (options) => {
          const input = (options.input || {}) as {
            deploymentId?: string;
            appId?: string;
            appName?: string;
          };

          const service = await getService(configManager);

          let deploymentId = input.deploymentId;
          if (!deploymentId) {
            const deployments = await service.getDeployments();

            if (!deployments.length) {
              throw new Error('Nenhum deployment encontrado.');
            }

            let targetName: string | undefined;
            if (input.appId || input.appName) {
              const app = await findApplicationByInput(service, input.appId, input.appName);
              targetName = app.name;
            }

            const filtered = targetName
              ? deployments.filter(
                  (deployment) =>
                    normalize(deployment.application_name) === normalize(targetName)
                )
              : deployments;

            if (!filtered.length) {
              throw new Error('Nenhum deployment encontrado para a aplicação informada.');
            }

            deploymentId = [...filtered].sort(
              (a, b) =>
                new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
            )[0].id;
          }

          const logs = await service.getDeploymentLogs(deploymentId);
          return createToolResult({
            deploymentId,
            logs: logs || 'Sem logs disponíveis para este deployment.',
          });
        },
      },
    ],
  ];

  const disposables: vscode.Disposable[] = [];
  for (const [name, tool] of tools) {
    try {
      disposables.push(lmApi.registerTool(name, tool));
    } catch (error) {
      logger.error(`Failed to register tool ${name}`, error);
    }
  }

  return disposables;
}