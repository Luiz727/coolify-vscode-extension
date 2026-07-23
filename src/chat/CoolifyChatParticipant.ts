import * as vscode from 'vscode';
import { ConfigurationManager } from '../managers/ConfigurationManager';
import { CoolifyService } from '../services/CoolifyService';
import { logger } from '../services/LoggerService';
import {
  ChatIntent,
  ResourceKind,
  extractTarget,
  routeIntent,
} from './intentRouter';
import {
  describeResolutionError,
  resolveTarget,
} from '../utils/targetResolver';
import { parseResourceStatus } from '../utils/resourceStatus';

type ChatStreamLike = {
  markdown?: (value: string) => void;
  progress?: (value: string) => void;
};

type ChatRequestLike = {
  prompt?: string;
};

interface ApplicationListItem {
  id: string;
  name: string;
  status: string;
  label: string;
}

interface DeploymentListItem {
  id: string;
  applicationId: string;
  applicationName: string;
  status: string;
  createdAt: string;
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

interface ServerListItem {
  id: string;
  name: string;
  ip: string;
  reachable: boolean;
  unreachableCount: number;
  highDiskUsage: boolean;
}

interface CoolifyProviderLike {
  getApplications(): Promise<ApplicationListItem[]>;
  getDeployments(): Promise<DeploymentListItem[]>;
  getDeploymentsByApplication(
    applicationId: string,
    skip?: number,
    take?: number
  ): Promise<DeploymentListItem[]>;
  getServices(): Promise<ServiceListItem[]>;
  getDatabases(): Promise<DatabaseListItem[]>;
  getServers(): Promise<ServerListItem[]>;
  getDeploymentLogs(deploymentId: string): Promise<string>;
  getApplicationRuntimeLogs(applicationId: string): Promise<string>;
  deployApplication(applicationId: string): Promise<void>;
  startApplication(applicationId: string): Promise<string>;
  stopApplication(applicationId: string): Promise<string>;
  restartApplication(applicationId: string): Promise<string>;
  startService(serviceId: string): Promise<string>;
  stopService(serviceId: string): Promise<string>;
  restartService(serviceId: string): Promise<string>;
  startDatabase(databaseId: string): Promise<string>;
  stopDatabase(databaseId: string): Promise<string>;
  restartDatabase(databaseId: string): Promise<string>;
}

type ProviderResolver = () => CoolifyProviderLike | undefined;

function writeMarkdown(stream: ChatStreamLike, text: string): void {
  if (typeof stream.markdown === 'function') {
    stream.markdown(text);
  }
}

function writeProgress(stream: ChatStreamLike, text: string): void {
  if (typeof stream.progress === 'function') {
    stream.progress(text);
  }
}

/** Adds a visible marker when a container is up but failing its healthcheck. */
function describeStatus(status: string): string {
  const parsed = parseResourceStatus(status);
  if (parsed.bucket === 'degraded') {
    return `${status} ⚠️ healthcheck falhando`;
  }
  return status;
}

function helpText(): string {
  return [
    'Posso operar o Coolify pelo chat. Consultas são livres; ações que mudam estado pedem confirmação e exigem que você diga qual recurso.',
    '',
    '**Consultar**',
    '- `listar apps` · `listar serviços` · `listar bancos` · `listar servidores`',
    '- `status da app "nome"`',
    '- `listar deployments da app "nome"`',
    '- `logs da app "nome"`',
    '- `health check coolify`',
    '',
    '**Alterar** (sempre com o nome entre aspas)',
    '- `deploy da app "nome"`',
    '- `restart|stop|start da app "nome"`',
    '- `restart|stop|start do serviço "nome"`',
    '- `restart|stop|start do banco "nome"`',
  ].join('\n');
}

async function ensureConfigured(
  configManager: ConfigurationManager,
  stream: ChatStreamLike
): Promise<boolean> {
  const configured = await configManager.isConfigured();
  if (!configured) {
    writeMarkdown(
      stream,
      'A extensão não está configurada. Peça `configurar coolify` ou execute o comando `Coolify: Configure`.'
    );
    return false;
  }

  return true;
}

/**
 * Confirms a state-changing action with the user.
 *
 * A chat message is an ambiguous instrument: the model may have misread the
 * target, or the user may have been imprecise. Anything that stops, restarts
 * or deploys goes through a modal naming the resource and the context.
 */
async function confirmAction(
  configManager: ConfigurationManager,
  action: string,
  resourceLabel: string,
  impact: string
): Promise<boolean> {
  const contextName = await configManager.getActiveContextName();
  const serverUrl = await configManager.getServerUrl();

  const choice = await vscode.window.showWarningMessage(
    `Confirmar "${action}" em ${resourceLabel}?`,
    {
      modal: true,
      detail: `${impact}\n\nContexto: ${contextName} (${serverUrl || 'sem servidor'})`,
    },
    'Confirmar'
  );

  return choice === 'Confirmar';
}

function lifecycleImpact(action: string, resource: ResourceKind): string {
  if (action === 'stop') {
    return resource === 'database'
      ? 'Todas as aplicações que dependem deste banco vão falhar enquanto ele estiver parado.'
      : 'O recurso ficará indisponível até ser iniciado novamente.';
  }
  if (action === 'restart') {
    return 'O recurso ficará indisponível durante o reinício.';
  }
  return 'O recurso será iniciado.';
}

export function registerCoolifyChatParticipant(
  configManager: ConfigurationManager,
  getProvider: ProviderResolver
): vscode.Disposable | undefined {
  const chatApi = (
    vscode as unknown as {
      chat?: {
        createChatParticipant?: (
          id: string,
          handler: (
            request: ChatRequestLike,
            context: unknown,
            stream: ChatStreamLike,
            token: vscode.CancellationToken
          ) => Promise<void>
        ) => vscode.Disposable;
      };
    }
  ).chat;

  if (!chatApi?.createChatParticipant) {
    logger.info('VS Code chat API is not available in this runtime.');
    return undefined;
  }

  return chatApi.createChatParticipant(
    'coolify.chat',
    async (request, _context, stream, cancellationToken) => {
      try {
        if (cancellationToken.isCancellationRequested) {
          return;
        }

        const prompt = (request.prompt || '').trim();
        if (!prompt) {
          writeMarkdown(stream, helpText());
          return;
        }

        const intent = routeIntent(prompt);
        const target = extractTarget(prompt);

        if (intent.kind === 'help') {
          writeMarkdown(stream, helpText());
          return;
        }

        if (intent.kind === 'configure') {
          const selected = await vscode.window.showInformationMessage(
            'Deseja abrir o fluxo de configuração do Coolify nesta janela?',
            'Abrir configuração'
          );

          if (selected === 'Abrir configuração') {
            await vscode.commands.executeCommand('coolify.configure');
            writeMarkdown(stream, 'Fluxo de configuração iniciado nesta janela.');
          } else {
            writeMarkdown(
              stream,
              'Configuração não iniciada. Use o botão `Configurar` no painel ou o comando `Coolify: Configure`.'
            );
          }
          return;
        }

        const provider = getProvider();
        if (!provider) {
          writeMarkdown(
            stream,
            'Provider do Coolify ainda não está pronto. Abra o painel do Coolify e tente novamente.'
          );
          return;
        }

        if (!(await ensureConfigured(configManager, stream))) {
          return;
        }

        await handleIntent(
          intent,
          target,
          provider,
          configManager,
          stream
        );
      } catch (error) {
        logger.error('Coolify chat participant failed', error);
        writeMarkdown(stream, describeResolutionError(error));
      }
    }
  );
}

async function handleIntent(
  intent: ChatIntent,
  target: string | undefined,
  provider: CoolifyProviderLike,
  configManager: ConfigurationManager,
  stream: ChatStreamLike
): Promise<void> {
  switch (intent.kind) {
    case 'health': {
      writeProgress(stream, 'Executando health checks...');
      const serverUrl = await configManager.getServerUrl();
      const token = await configManager.getToken();

      if (!serverUrl || !token) {
        writeMarkdown(stream, 'Configuração incompleta.');
        return;
      }

      const service = new CoolifyService(serverUrl, token);
      const [reachable, validToken] = await Promise.all([
        service.testConnection(),
        service.verifyToken(),
      ]);

      writeMarkdown(
        stream,
        [
          `Servidor: ${serverUrl}`,
          `Conectividade: ${reachable ? 'ok' : 'falhou'}`,
          `Token API: ${validToken ? 'válido' : 'inválido'}`,
        ].join('\n')
      );
      return;
    }

    case 'servers': {
      writeProgress(stream, 'Consultando servidores...');
      const servers = await provider.getServers();
      if (!servers.length) {
        writeMarkdown(stream, 'Nenhum servidor encontrado.');
        return;
      }

      const lines = servers.map((server) => {
        const flags: string[] = [];
        if (!server.reachable) {
          flags.push(`⛔ inacessível (${server.unreachableCount} falhas)`);
        }
        if (server.highDiskUsage) {
          flags.push('⚠️ disco cheio');
        }
        const suffix = flags.length ? ` — ${flags.join(', ')}` : ' — ok';
        return `- **${server.name}** (${server.ip || 'sem ip'})${suffix}`;
      });

      writeMarkdown(stream, `Servidores:\n${lines.join('\n')}`);
      return;
    }

    case 'list': {
      writeProgress(stream, 'Buscando recursos...');
      const items = await listByResource(provider, intent.resource);

      if (!items.length) {
        writeMarkdown(stream, 'Nenhum recurso encontrado.');
        return;
      }

      const list = items
        .map((item) => `- ${item.name} (${describeStatus(item.status)})`)
        .join('\n');
      writeMarkdown(stream, `Encontrados ${items.length}:\n${list}`);
      return;
    }

    case 'status': {
      writeProgress(stream, 'Consultando status...');
      const items = await listByResource(provider, intent.resource);

      if (!items.length) {
        writeMarkdown(stream, 'Nenhum recurso encontrado.');
        return;
      }

      if (!target) {
        const statuses = items
          .map((item) => `- ${item.name}: ${describeStatus(item.status)}`)
          .join('\n');
        writeMarkdown(stream, `Status:\n${statuses}`);
        return;
      }

      // Reads may fall back to the single resource; this is safe.
      const item = resolveTarget(items, undefined, target, {
        entityLabel: intent.resource,
        allowSingleFallback: true,
      });
      writeMarkdown(
        stream,
        `Status de ${item.name}: ${describeStatus(item.status)}`
      );
      return;
    }

    case 'deployments': {
      writeProgress(stream, 'Buscando histórico de deployments...');
      const applications = await provider.getApplications();
      if (!applications.length) {
        writeMarkdown(stream, 'Nenhuma aplicação encontrada.');
        return;
      }

      const app = resolveTarget(toResolvable(applications), undefined, target, {
        entityLabel: 'aplicação',
        allowSingleFallback: true,
      });

      // /deployments only lists what is running now; history lives per app.
      const deployments = await provider.getDeploymentsByApplication(app.uuid, 0, 10);
      if (!deployments.length) {
        writeMarkdown(stream, `Nenhum deployment encontrado para ${app.name}.`);
        return;
      }

      const list = deployments
        .map(
          (deployment) =>
            `- \`${deployment.status}\` — ${
              deployment.createdAt
                ? new Date(deployment.createdAt).toLocaleString('pt-BR')
                : 'sem data'
            } (id: ${deployment.id})`
        )
        .join('\n');

      writeMarkdown(stream, `Deployments de **${app.name}**:\n${list}`);
      return;
    }

    case 'logs': {
      writeProgress(stream, 'Buscando logs...');
      const applications = await provider.getApplications();
      if (!applications.length) {
        writeMarkdown(stream, 'Nenhuma aplicação encontrada.');
        return;
      }

      const app = resolveTarget(toResolvable(applications), undefined, target, {
        entityLabel: 'aplicação',
        allowSingleFallback: true,
      });

      const runtimeLogs = await provider
        .getApplicationRuntimeLogs(app.uuid)
        .catch(() => '');

      if (runtimeLogs.trim()) {
        writeMarkdown(
          stream,
          `Logs do container **${app.name}**:\n\n\`\`\`log\n${runtimeLogs.slice(-3500)}\n\`\`\``
        );
        return;
      }

      const deployments = await provider.getDeploymentsByApplication(app.uuid, 0, 1);
      if (!deployments.length) {
        writeMarkdown(
          stream,
          `Sem logs de runtime e nenhum deployment registrado para ${app.name}.`
        );
        return;
      }

      const logs = await provider.getDeploymentLogs(deployments[0].id);
      const output = logs?.trim()
        ? logs.slice(-3500)
        : 'Sem logs disponíveis para este deployment.';

      writeMarkdown(
        stream,
        `Logs do último deployment de **${app.name}** (${deployments[0].status}):\n\n\`\`\`log\n${output}\n\`\`\``
      );
      return;
    }

    case 'deploy': {
      const applications = await provider.getApplications();
      if (!applications.length) {
        writeMarkdown(stream, 'Nenhuma aplicação encontrada.');
        return;
      }

      // A deploy changes production. No single-application fallback here: the
      // user must name the target, otherwise an ambiguous message could ship.
      const app = resolveTarget(toResolvable(applications), undefined, target, {
        entityLabel: 'aplicação',
        allowSingleFallback: false,
      });

      const confirmed = await confirmAction(
        configManager,
        'deploy',
        app.name,
        'Uma nova versão será construída e publicada, substituindo a atual.'
      );

      if (!confirmed) {
        writeMarkdown(stream, 'Deploy cancelado.');
        return;
      }

      writeProgress(stream, 'Iniciando deploy...');
      await provider.deployApplication(app.uuid);
      writeMarkdown(stream, `Deploy iniciado para **${app.name}**.`);
      return;
    }

    case 'lifecycle': {
      const items = await listByResource(provider, intent.resource);
      if (!items.length) {
        writeMarkdown(stream, 'Nenhum recurso encontrado.');
        return;
      }

      const item = resolveTarget(items, undefined, target, {
        entityLabel: intent.resource,
        allowSingleFallback: false,
      });

      const confirmed = await confirmAction(
        configManager,
        intent.action,
        item.name,
        lifecycleImpact(intent.action, intent.resource)
      );

      if (!confirmed) {
        writeMarkdown(stream, `Ação ${intent.action} cancelada.`);
        return;
      }

      writeProgress(stream, `Executando ${intent.action}...`);
      const result = await runLifecycle(
        provider,
        intent.resource,
        intent.action,
        item.uuid
      );

      writeMarkdown(
        stream,
        result || `Ação ${intent.action} enviada para ${item.name}.`
      );
      return;
    }

    default:
      writeMarkdown(stream, helpText());
  }
}

/** Adapts the provider list items to the shape the resolver expects. */
function toResolvable(
  items: Array<{ id: string; name: string; status?: string }>
): Array<{ uuid: string; name: string; status: string }> {
  return items.map((item) => ({
    uuid: item.id,
    name: item.name,
    status: item.status || 'unknown',
  }));
}

async function listByResource(
  provider: CoolifyProviderLike,
  resource: ResourceKind
): Promise<Array<{ uuid: string; name: string; status: string }>> {
  if (resource === 'service') {
    return toResolvable(await provider.getServices());
  }
  if (resource === 'database') {
    return toResolvable(await provider.getDatabases());
  }
  return toResolvable(await provider.getApplications());
}

async function runLifecycle(
  provider: CoolifyProviderLike,
  resource: ResourceKind,
  action: 'start' | 'stop' | 'restart',
  id: string
): Promise<string> {
  if (resource === 'service') {
    if (action === 'start') {
      return provider.startService(id);
    }
    if (action === 'stop') {
      return provider.stopService(id);
    }
    return provider.restartService(id);
  }

  if (resource === 'database') {
    if (action === 'start') {
      return provider.startDatabase(id);
    }
    if (action === 'stop') {
      return provider.stopDatabase(id);
    }
    return provider.restartDatabase(id);
  }

  if (action === 'start') {
    return provider.startApplication(id);
  }
  if (action === 'stop') {
    return provider.stopApplication(id);
  }
  return provider.restartApplication(id);
}
