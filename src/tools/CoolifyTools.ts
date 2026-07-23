import * as vscode from 'vscode';
import { ConfigurationManager } from '../managers/ConfigurationManager';
import { CoolifyService } from '../services/CoolifyService';
import type {
  Application as CoolifyApplication,
  DatabaseResource,
  ServerResource,
  ServiceResource,
} from '../services/CoolifyService';
import { logger } from '../services/LoggerService';
import {
  describeResolutionError,
  resolveTarget,
} from '../utils/targetResolver';
import { resolveDeploymentId } from '../utils/deploymentIdentity';
import { parseResourceStatus } from '../utils/resourceStatus';

type PrepareResult = {
  invocationMessage: string;
  confirmationMessages?: { title: string; message: string };
};

type LmTool = {
  invoke: (
    options: { input?: unknown },
    token: vscode.CancellationToken
  ) => Promise<unknown>;
  prepareInvocation?: (
    options: { input?: unknown },
    token: vscode.CancellationToken
  ) => unknown;
};

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

async function getService(
  configManager: ConfigurationManager
): Promise<CoolifyService> {
  const serverUrl = await configManager.getServerUrl();
  const token = await configManager.getToken();

  if (!serverUrl || !token) {
    throw new Error(
      'Coolify não está configurado. Use a ferramenta coolify-configure primeiro.'
    );
  }

  return new CoolifyService(serverUrl, token);
}

function readMessage(prefix: string): PrepareResult {
  return { invocationMessage: prefix };
}

/**
 * Builds a prepare result that forces VS Code to ask the user before running.
 *
 * Every tool that changes state uses this. A chat model must never be able to
 * stop, restart or deploy a production resource without a human seeing exactly
 * which resource, in which context, is about to be touched — the context line
 * matters because the same application name exists in prod and in staging.
 */
async function writeConfirmation(
  configManager: ConfigurationManager,
  invocationMessage: string,
  title: string,
  message: string
): Promise<PrepareResult> {
  const context = await contextLabel(configManager).catch(
    () => 'contexto desconhecido'
  );

  return {
    invocationMessage,
    confirmationMessages: {
      title,
      message: `${message}\n\n**Contexto:** ${context}`,
    },
  };
}

function describeTarget(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '(alvo não informado)';
}

async function contextLabel(configManager: ConfigurationManager): Promise<string> {
  const contextName = await configManager.getActiveContextName();
  const serverUrl = await configManager.getServerUrl();
  return `${contextName} — ${serverUrl || 'servidor não configurado'}`;
}

/** Reads run without friction; writes must name their target explicitly. */
async function findApplication(
  service: CoolifyService,
  input: { appId?: string; appName?: string },
  allowSingleFallback: boolean
): Promise<CoolifyApplication> {
  const applications = await service.getApplications();
  return resolveTarget(applications, input.appId, input.appName, {
    entityLabel: 'aplicação',
    allowSingleFallback,
  });
}

async function findService(
  service: CoolifyService,
  input: { serviceId?: string; serviceName?: string },
  allowSingleFallback: boolean
): Promise<ServiceResource> {
  const services = await service.getServices();
  return resolveTarget(services, input.serviceId, input.serviceName, {
    entityLabel: 'serviço',
    allowSingleFallback,
  });
}

async function findDatabase(
  service: CoolifyService,
  input: { databaseId?: string; databaseName?: string },
  allowSingleFallback: boolean
): Promise<DatabaseResource> {
  const databases = await service.getDatabases();
  return resolveTarget(databases, input.databaseId, input.databaseName, {
    entityLabel: 'banco de dados',
    allowSingleFallback,
  });
}

async function findServer(
  service: CoolifyService,
  input: { serverId?: string; serverName?: string },
  allowSingleFallback: boolean
): Promise<ServerResource> {
  const servers = await service.getServers();
  return resolveTarget(servers, input.serverId, input.serverName, {
    entityLabel: 'servidor',
    allowSingleFallback,
  });
}

/** Wraps a tool body so resolution errors reach the model as readable text. */
function guarded(
  handler: (options: { input?: unknown }) => Promise<unknown>
): (options: { input?: unknown }, token: vscode.CancellationToken) => Promise<unknown> {
  return async (options) => {
    try {
      return await handler(options);
    } catch (error) {
      logger.warn('Coolify tool failed', error);
      return createToolResult({
        ok: false,
        error: describeResolutionError(error),
      });
    }
  };
}

export function registerCoolifyTools(
  configManager: ConfigurationManager
): vscode.Disposable[] {
  const lmApi = (
    vscode as unknown as {
      lm?: {
        registerTool?: (name: string, tool: LmTool) => vscode.Disposable;
      };
    }
  ).lm;

  if (!lmApi?.registerTool) {
    logger.info('VS Code lm.registerTool API is not available in this runtime.');
    return [];
  }

  const tools: Array<[string, LmTool]> = [
    // ---------------------------------------------------------------- setup
    [
      'coolify-configure',
      {
        prepareInvocation: () => readMessage('Iniciando configuração do Coolify...'),
        invoke: guarded(async () => {
          const selected = await vscode.window.showInformationMessage(
            'Deseja abrir o fluxo de configuração do Coolify nesta janela?',
            'Abrir configuração'
          );

          if (selected === 'Abrir configuração') {
            await vscode.commands.executeCommand('coolify.configure');
            return createToolResult({
              ok: true,
              message: 'Fluxo de configuração iniciado nesta janela.',
            });
          }

          return createToolResult({
            ok: false,
            cancelled: true,
            message:
              'Configuração não iniciada. Use o botão Configurar no painel ou o comando Coolify: Configure.',
          });
        }),
      },
    ],
    [
      'coolify-healthCheck',
      {
        prepareInvocation: () => readMessage('Executando health check do Coolify...'),
        invoke: guarded(async () => {
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
        }),
      },
    ],

    // --------------------------------------------------------- applications
    [
      'coolify-listApplications',
      {
        prepareInvocation: () => readMessage('Listando aplicações do Coolify...'),
        invoke: guarded(async () => {
          const service = await getService(configManager);
          const applications = await service.getApplications();

          return createToolResult({
            count: applications.length,
            applications: applications.map((app) => {
              const parsed = parseResourceStatus(app.status);
              return {
                id: app.uuid,
                name: app.name,
                status: app.status,
                statusBucket: parsed.bucket,
                health: parsed.health,
                branch: app.git_branch,
                fqdn: app.fqdn,
              };
            }),
          });
        }),
      },
    ],
    [
      'coolify-getApplicationStatus',
      {
        prepareInvocation: () => readMessage('Consultando status da aplicação...'),
        invoke: guarded(async (options) => {
          const input = (options.input || {}) as { appId?: string; appName?: string };
          const service = await getService(configManager);
          const app = await findApplication(service, input, true);
          const parsed = parseResourceStatus(app.status);

          return createToolResult({
            id: app.uuid,
            name: app.name,
            status: app.status,
            statusBucket: parsed.bucket,
            health: parsed.health,
            branch: app.git_branch,
            commit: app.git_commit_sha,
            fqdn: app.fqdn,
            updatedAt: app.updated_at,
          });
        }),
      },
    ],
    [
      'coolify-getApplicationLogs',
      {
        prepareInvocation: () => readMessage('Obtendo logs do container...'),
        invoke: guarded(async (options) => {
          const input = (options.input || {}) as { appId?: string; appName?: string };
          const service = await getService(configManager);
          const app = await findApplication(service, input, true);
          const logs = await service.getApplicationLogs(app.uuid);

          return createToolResult({
            appId: app.uuid,
            appName: app.name,
            logs: logs || 'Sem logs de runtime disponíveis.',
          });
        }),
      },
    ],
    [
      'coolify-listApplicationEnvs',
      {
        prepareInvocation: () => readMessage('Listando variáveis de ambiente...'),
        invoke: guarded(async (options) => {
          const input = (options.input || {}) as { appId?: string; appName?: string };
          const service = await getService(configManager);
          const app = await findApplication(service, input, true);
          const envs = await service.listEnvironmentVariables(app.uuid);

          // Values are secrets: report presence, never content.
          return createToolResult({
            appId: app.uuid,
            appName: app.name,
            count: envs.length,
            variables: envs.map((env) => ({
              key: env.key,
              hasValue: Boolean(env.value),
              isPreview: env.is_preview === true,
            })),
            note: 'Valores omitidos por segurança.',
          });
        }),
      },
    ],
    [
      'coolify-setApplicationEnv',
      {
        prepareInvocation: (options) => {
          const input = (options.input || {}) as Record<string, unknown>;
          const key = String(input.key || '(sem chave)');
          const target = describeTarget(input, ['appName', 'appId']);
          return writeConfirmation(
            configManager,
            `Definindo variável ${key}...`,
            'Alterar variável de ambiente',
            `Definir **${key}** na aplicação **${target}**.\n\nIsso altera a configuração da aplicação e passa a valer no próximo deploy.`
          );
        },
        invoke: guarded(async (options) => {
          const input = (options.input || {}) as {
            appId?: string;
            appName?: string;
            key?: string;
            value?: string;
            isPreview?: boolean;
          };

          if (!input.key?.trim()) {
            throw new Error('key é obrigatório.');
          }
          if (typeof input.value !== 'string') {
            throw new Error('value é obrigatório.');
          }

          const service = await getService(configManager);
          const app = await findApplication(service, input, false);
          const existing = await service.listEnvironmentVariables(app.uuid);
          const alreadyExists = existing.some((env) => env.key === input.key);

          const payload = {
            key: input.key,
            value: input.value,
            is_preview: input.isPreview === true,
          };

          if (alreadyExists) {
            await service.updateEnvironmentVariable(app.uuid, payload);
          } else {
            await service.createEnvironmentVariable(app.uuid, payload);
          }

          return createToolResult({
            ok: true,
            appId: app.uuid,
            appName: app.name,
            key: input.key,
            operation: alreadyExists ? 'updated' : 'created',
          });
        }),
      },
    ],
    [
      'coolify-startDeployment',
      {
        prepareInvocation: (options) => {
          const input = (options.input || {}) as Record<string, unknown>;
          const target = describeTarget(input, ['appName', 'appId']);
          return writeConfirmation(
            configManager,
            'Iniciando deployment...',
            'Confirmar deployment',
            `Iniciar um novo deployment de **${target}**.\n\nA aplicação será reconstruída e substituída pela nova versão.`
          );
        },
        invoke: guarded(async (options) => {
          const input = (options.input || {}) as {
            appId?: string;
            appName?: string;
            force?: boolean;
          };

          const service = await getService(configManager);
          // A deploy changes production: never guess the target.
          const app = await findApplication(service, input, false);
          await service.startDeployment(app.uuid, input.force === true);

          return createToolResult({
            ok: true,
            message: `Deployment iniciado para ${app.name}.`,
            appId: app.uuid,
            appName: app.name,
          });
        }),
      },
    ],
    [
      'coolify-applicationLifecycle',
      {
        prepareInvocation: (options) => {
          const input = (options.input || {}) as Record<string, unknown>;
          const action = String(input.action || 'start');
          const target = describeTarget(input, ['appName', 'appId']);
          const impact =
            action === 'stop'
              ? 'A aplicação ficará indisponível até ser iniciada novamente.'
              : action === 'restart'
                ? 'A aplicação ficará indisponível durante o reinício.'
                : 'A aplicação será iniciada.';

          return writeConfirmation(
            configManager,
            `Executando ${action} na aplicação...`,
            `Confirmar ${action}`,
            `Executar **${action}** na aplicação **${target}**.\n\n${impact}`
          );
        },
        invoke: guarded(async (options) => {
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
          const app = await findApplication(service, input, false);

          const message =
            action === 'start'
              ? await service.startApplication(app.uuid)
              : action === 'stop'
                ? await service.stopApplication(app.uuid)
                : await service.restartApplication(app.uuid);

          return createToolResult({
            ok: true,
            action,
            appId: app.uuid,
            appName: app.name,
            message,
          });
        }),
      },
    ],

    // ---------------------------------------------------------- deployments
    [
      'coolify-listDeployments',
      {
        prepareInvocation: () => readMessage('Listando deployments...'),
        invoke: guarded(async (options) => {
          const input = (options.input || {}) as {
            appId?: string;
            appName?: string;
            take?: number;
          };

          const service = await getService(configManager);
          const take = Math.min(Math.max(Number(input.take) || 10, 1), 50);

          // /deployments alone only reports what is running right now, so an
          // idle system would look like it never deployed anything.
          if (input.appId || input.appName) {
            const app = await findApplication(service, input, true);
            const deployments = await service.getDeploymentsByApplication(
              app.uuid,
              0,
              take
            );

            return createToolResult({
              appId: app.uuid,
              appName: app.name,
              count: deployments.length,
              deployments: deployments.map((deployment) => ({
                id: resolveDeploymentId(deployment),
                status: deployment.status,
                commit: deployment.commit,
                commitMessage: deployment.commit_message,
                createdAt: deployment.created_at,
              })),
            });
          }

          const applications = await service.getApplications();
          const deployments = await service.getDeploymentHistory(
            applications.map((app) => app.uuid),
            3
          );

          return createToolResult({
            count: deployments.length,
            deployments: deployments.slice(0, take).map((deployment) => ({
              id: resolveDeploymentId(deployment),
              application: deployment.application_name,
              status: deployment.status,
              isRunning: deployment.isRunning === true,
              createdAt: deployment.created_at,
            })),
          });
        }),
      },
    ],
    [
      'coolify-getDeploymentLogs',
      {
        prepareInvocation: () => readMessage('Obtendo logs do deployment...'),
        invoke: guarded(async (options) => {
          const input = (options.input || {}) as {
            deploymentId?: string;
            appId?: string;
            appName?: string;
          };

          const service = await getService(configManager);

          let deploymentId = input.deploymentId?.trim();
          if (!deploymentId) {
            const app = await findApplication(service, input, true);
            const deployments = await service.getDeploymentsByApplication(
              app.uuid,
              0,
              1
            );

            if (!deployments.length) {
              throw new Error(`Nenhum deployment encontrado para ${app.name}.`);
            }

            deploymentId = resolveDeploymentId(deployments[0]);
          }

          const logs = await service.getDeploymentLogs(deploymentId);
          return createToolResult({
            deploymentId,
            logs: logs || 'Sem logs disponíveis para este deployment.',
          });
        }),
      },
    ],
    [
      'coolify-cancelDeployment',
      {
        prepareInvocation: (options) => {
          const input = (options.input || {}) as Record<string, unknown>;
          const target = describeTarget(input, ['deploymentId']);
          return writeConfirmation(
            configManager,
            'Cancelando deployment...',
            'Confirmar cancelamento',
            `Cancelar o deployment **${target}**.\n\nA versão em execução permanece; a nova não será publicada.`
          );
        },
        invoke: guarded(async (options) => {
          const input = (options.input || {}) as { deploymentId?: string };
          if (!input.deploymentId?.trim()) {
            throw new Error('deploymentId é obrigatório.');
          }

          const service = await getService(configManager);
          await service.cancelDeployment(input.deploymentId.trim());

          return createToolResult({
            ok: true,
            deploymentId: input.deploymentId,
            message: 'Cancelamento solicitado.',
          });
        }),
      },
    ],

    // -------------------------------------------------------------- services
    [
      'coolify-listServices',
      {
        prepareInvocation: () => readMessage('Listando serviços do Coolify...'),
        invoke: guarded(async () => {
          const service = await getService(configManager);
          const services = await service.getServices();

          return createToolResult({
            count: services.length,
            services: services.map((item) => {
              const parsed = parseResourceStatus(item.status);
              return {
                id: item.uuid,
                name: item.name,
                status: item.status,
                statusBucket: parsed.bucket,
                description: item.description || '',
              };
            }),
          });
        }),
      },
    ],
    [
      'coolify-serviceLifecycle',
      {
        prepareInvocation: (options) => {
          const input = (options.input || {}) as Record<string, unknown>;
          const action = String(input.action || 'start');
          const target = describeTarget(input, ['serviceName', 'serviceId']);
          return writeConfirmation(
            configManager,
            `Executando ${action} no serviço...`,
            `Confirmar ${action}`,
            `Executar **${action}** no serviço **${target}**.\n\nOs containers do serviço serão afetados.`
          );
        },
        invoke: guarded(async (options) => {
          const input = (options.input || {}) as {
            action?: 'start' | 'stop' | 'restart';
            serviceId?: string;
            serviceName?: string;
          };

          const action = input.action || 'start';
          if (!['start', 'stop', 'restart'].includes(action)) {
            throw new Error('Ação inválida. Use start, stop ou restart.');
          }

          const service = await getService(configManager);
          const target = await findService(service, input, false);

          const message =
            action === 'start'
              ? await service.startService(target.uuid)
              : action === 'stop'
                ? await service.stopService(target.uuid)
                : await service.restartService(target.uuid);

          return createToolResult({
            ok: true,
            action,
            serviceId: target.uuid,
            serviceName: target.name,
            message,
          });
        }),
      },
    ],

    // ------------------------------------------------------------- databases
    [
      'coolify-listDatabases',
      {
        prepareInvocation: () =>
          readMessage('Listando bancos de dados do Coolify...'),
        invoke: guarded(async () => {
          const service = await getService(configManager);
          const databases = await service.getDatabases();

          return createToolResult({
            count: databases.length,
            databases: databases.map((item) => {
              const parsed = parseResourceStatus(item.status);
              return {
                id: item.uuid,
                name: item.name,
                status: item.status,
                statusBucket: parsed.bucket,
                description: item.description || '',
              };
            }),
          });
        }),
      },
    ],
    [
      'coolify-databaseLifecycle',
      {
        prepareInvocation: (options) => {
          const input = (options.input || {}) as Record<string, unknown>;
          const action = String(input.action || 'start');
          const target = describeTarget(input, ['databaseName', 'databaseId']);
          const impact =
            action === 'stop'
              ? 'Todas as aplicações que dependem deste banco vão falhar enquanto ele estiver parado.'
              : action === 'restart'
                ? 'Conexões abertas serão encerradas durante o reinício.'
                : 'O banco será iniciado.';

          return writeConfirmation(
            configManager,
            `Executando ${action} no banco...`,
            `Confirmar ${action} em banco de dados`,
            `Executar **${action}** no banco **${target}**.\n\n${impact}`
          );
        },
        invoke: guarded(async (options) => {
          const input = (options.input || {}) as {
            action?: 'start' | 'stop' | 'restart';
            databaseId?: string;
            databaseName?: string;
          };

          const action = input.action || 'start';
          if (!['start', 'stop', 'restart'].includes(action)) {
            throw new Error('Ação inválida. Use start, stop ou restart.');
          }

          const service = await getService(configManager);
          const target = await findDatabase(service, input, false);

          const message =
            action === 'start'
              ? await service.startDatabase(target.uuid)
              : action === 'stop'
                ? await service.stopDatabase(target.uuid)
                : await service.restartDatabase(target.uuid);

          return createToolResult({
            ok: true,
            action,
            databaseId: target.uuid,
            databaseName: target.name,
            message,
          });
        }),
      },
    ],
    [
      'coolify-listDatabaseBackups',
      {
        prepareInvocation: () => readMessage('Listando agendamentos de backup...'),
        invoke: guarded(async (options) => {
          const input = (options.input || {}) as {
            databaseId?: string;
            databaseName?: string;
          };

          const service = await getService(configManager);
          const target = await findDatabase(service, input, true);
          const schedules = await service.listBackupSchedules(target.uuid);

          const withExecutions = await Promise.all(
            schedules.map(async (schedule) => {
              const executions = await service
                .listBackupExecutions(target.uuid, schedule.uuid)
                .catch(() => []);

              return {
                scheduleId: schedule.uuid,
                frequency: schedule.frequency,
                enabled: schedule.enabled,
                lastExecutions: executions.slice(0, 5).map((execution) => ({
                  status: execution.status,
                  createdAt: execution.createdAt,
                  size: execution.size,
                })),
              };
            })
          );

          return createToolResult({
            databaseId: target.uuid,
            databaseName: target.name,
            schedules: withExecutions,
            note: 'A API do Coolify não expõe restauração de backup; o restore é manual.',
          });
        }),
      },
    ],
    [
      'coolify-runDatabaseBackup',
      {
        prepareInvocation: (options) => {
          const input = (options.input || {}) as Record<string, unknown>;
          const target = describeTarget(input, ['databaseName', 'databaseId']);
          return writeConfirmation(
            configManager,
            'Disparando backup...',
            'Confirmar backup imediato',
            `Executar um backup agora do banco **${target}**.\n\nA operação consome CPU e disco do servidor.`
          );
        },
        invoke: guarded(async (options) => {
          const input = (options.input || {}) as {
            databaseId?: string;
            databaseName?: string;
            scheduleId?: string;
          };

          const service = await getService(configManager);
          const target = await findDatabase(service, input, false);

          let scheduleId = input.scheduleId?.trim();
          if (!scheduleId) {
            const schedules = await service.listBackupSchedules(target.uuid);
            if (schedules.length === 0) {
              throw new Error(
                `O banco ${target.name} não tem agendamento de backup. Crie um antes de disparar.`
              );
            }
            if (schedules.length > 1) {
              throw new Error(
                `O banco ${target.name} tem ${schedules.length} agendamentos. Informe scheduleId.`
              );
            }
            scheduleId = schedules[0].uuid;
          }

          const message = await service.runBackupNow(target.uuid, scheduleId);

          return createToolResult({
            ok: true,
            databaseId: target.uuid,
            databaseName: target.name,
            scheduleId,
            message,
          });
        }),
      },
    ],

    // -------------------------------------------------- projects and servers
    [
      'coolify-listProjects',
      {
        prepareInvocation: () => readMessage('Listando projetos...'),
        invoke: guarded(async () => {
          const service = await getService(configManager);
          const projects = await service.getProjects();

          return createToolResult({
            count: projects.length,
            projects: projects.map((project) => ({
              id: project.uuid,
              name: project.name,
              description: project.description || '',
            })),
          });
        }),
      },
    ],
    [
      'coolify-listServers',
      {
        prepareInvocation: () => readMessage('Consultando servidores...'),
        invoke: guarded(async () => {
          const service = await getService(configManager);
          const servers = await service.getServers();

          const detailed = await Promise.all(
            servers.map(async (server) => {
              const resources = await service
                .getServerResources(server.uuid)
                .catch(() => []);

              return {
                id: server.uuid,
                name: server.name,
                ip: server.ip || '',
                proxyType: server.proxy_type || 'none',
                // These flags are the root-cause signals when several
                // resources go down at the same time.
                reachable: !(
                  server.unreachable_count && server.unreachable_count > 0
                ),
                unreachableCount: Number(server.unreachable_count) || 0,
                highDiskUsage: server.high_disk_usage_notification_sent === true,
                resourceCount: resources.length,
              };
            })
          );

          return createToolResult({ count: detailed.length, servers: detailed });
        }),
      },
    ],
    [
      'coolify-getServerResources',
      {
        prepareInvocation: () => readMessage('Consultando recursos do servidor...'),
        invoke: guarded(async (options) => {
          const input = (options.input || {}) as {
            serverId?: string;
            serverName?: string;
          };

          const service = await getService(configManager);
          const server = await findServer(service, input, true);
          const resources = await service.getServerResources(server.uuid);

          return createToolResult({
            serverId: server.uuid,
            serverName: server.name,
            count: resources.length,
            resources: resources.map((resource) => ({
              ...resource,
              statusBucket: parseResourceStatus(resource.status).bucket,
            })),
          });
        }),
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

  logger.info(`Registered ${disposables.length} Coolify language model tools.`);
  return disposables;
}

// Deletion endpoints (DELETE /applications, /databases, /projects, /servers,
// /security/keys) are intentionally NOT exposed as tools. They are
// irreversible and stay in the Coolify UI, behind its own confirmations.
export { contextLabel };
