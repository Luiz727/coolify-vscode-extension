import * as vscode from 'vscode';
import { ConfigurationManager } from '../managers/ConfigurationManager';
import { CoolifyService } from '../services/CoolifyService';
import { logger } from '../services/LoggerService';

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

interface CoolifyProviderLike {
  getApplications(): Promise<ApplicationListItem[]>;
  getDeployments(): Promise<DeploymentListItem[]>;
  getServices(): Promise<ServiceListItem[]>;
  getDatabases(): Promise<DatabaseListItem[]>;
  getDeploymentLogs(deploymentId: string): Promise<string>;
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

function normalize(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function extractTarget(prompt: string): string | undefined {
  const quoted = prompt.match(/"([^"]+)"/);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }

  const targetByKeyword = prompt.match(
    /(?:app|aplicacao|aplicação|application)\s+([a-zA-Z0-9._-]+)/i
  );
  if (targetByKeyword?.[1]) {
    return targetByKeyword[1].trim();
  }

  return undefined;
}

  function extractServiceTarget(prompt: string): string | undefined {
    const quoted = prompt.match(/"([^"]+)"/);
    if (quoted?.[1]) {
      return quoted[1].trim();
    }

    const targetByKeyword = prompt.match(
      /(?:service|servico|serviço)\s+([a-zA-Z0-9._-]+)/i
    );
    if (targetByKeyword?.[1]) {
      return targetByKeyword[1].trim();
    }

    return undefined;
  }

  function extractDatabaseTarget(prompt: string): string | undefined {
    const quoted = prompt.match(/"([^"]+)"/);
    if (quoted?.[1]) {
      return quoted[1].trim();
    }

    const targetByKeyword = prompt.match(
      /(?:database|databases|banco|bancos)\s+([a-zA-Z0-9._-]+)/i
    );
    if (targetByKeyword?.[1]) {
      return targetByKeyword[1].trim();
    }

    return undefined;
  }

function findApplication(
  applications: ApplicationListItem[],
  target?: string
): ApplicationListItem | undefined {
  if (!target) {
    return applications.length === 1 ? applications[0] : undefined;
  }

  const normalizedTarget = normalize(target);
  const exact = applications.find(
    (app) =>
      normalize(app.name) === normalizedTarget ||
      normalize(app.id) === normalizedTarget
  );
  if (exact) {
    return exact;
  }

  return applications.find(
    (app) =>
      normalize(app.name).includes(normalizedTarget) ||
      normalize(app.label).includes(normalizedTarget)
  );
}

function looksLikeListIntent(normalizedPrompt: string): boolean {
  return (
    normalizedPrompt.includes('listar') ||
    normalizedPrompt.includes('list') ||
    normalizedPrompt.includes('applications') ||
    normalizedPrompt.includes('aplicacoes') ||
    normalizedPrompt.includes('apps')
  );
}

  function looksLikeApplicationIntent(normalizedPrompt: string): boolean {
    return (
      normalizedPrompt.includes('applications') ||
      normalizedPrompt.includes('aplicacoes') ||
      normalizedPrompt.includes('apps') ||
      normalizedPrompt.includes('app') ||
      normalizedPrompt.includes('aplicacao') ||
      normalizedPrompt.includes('aplicação')
    );
  }

  function looksLikeServiceIntent(normalizedPrompt: string): boolean {
    return (
      normalizedPrompt.includes('service') ||
      normalizedPrompt.includes('servico') ||
      normalizedPrompt.includes('serviço')
    );
  }

  function looksLikeDatabaseIntent(normalizedPrompt: string): boolean {
    return (
      normalizedPrompt.includes('database') ||
      normalizedPrompt.includes('databases') ||
      normalizedPrompt.includes('banco') ||
      normalizedPrompt.includes('bancos')
    );
  }

function looksLikeStatusIntent(normalizedPrompt: string): boolean {
  return normalizedPrompt.includes('status') || normalizedPrompt.includes('estado');
}

function looksLikeDeployIntent(normalizedPrompt: string): boolean {
  return (
    normalizedPrompt.includes('deploy') ||
    normalizedPrompt.includes('implantar') ||
    normalizedPrompt.includes('publicar')
  );
}

function looksLikeLogsIntent(normalizedPrompt: string): boolean {
  return normalizedPrompt.includes('logs') || normalizedPrompt.includes('log');
}

function looksLikeConfigureIntent(normalizedPrompt: string): boolean {
  return (
    normalizedPrompt.includes('configurar') ||
    normalizedPrompt.includes('configure') ||
    normalizedPrompt.includes('api key') ||
    normalizedPrompt.includes('token')
  );
}

function lifecycleAction(
  normalizedPrompt: string
): 'start' | 'stop' | 'restart' | undefined {
  if (
    normalizedPrompt.includes('restart') ||
    normalizedPrompt.includes('reiniciar') ||
    normalizedPrompt.includes('restarted')
  ) {
    return 'restart';
  }

  if (
    normalizedPrompt.includes('stop') ||
    normalizedPrompt.includes('parar') ||
    normalizedPrompt.includes('desligar')
  ) {
    return 'stop';
  }

  if (
    normalizedPrompt.includes('start') ||
    normalizedPrompt.includes('iniciar') ||
    normalizedPrompt.includes('ligar')
  ) {
    return 'start';
  }

  return undefined;
}

function looksLikeHealthIntent(normalizedPrompt: string): boolean {
  return (
    normalizedPrompt.includes('health') ||
    normalizedPrompt.includes('saude') ||
    normalizedPrompt.includes('conexao')
  );
}

function helpText(): string {
  return [
    'Posso executar ações de MVP no Coolify diretamente pelo chat:',
    '- `configurar coolify`',
    '- `listar apps`',
    '- `status da app "nome"`',
    '- `deploy da app "nome"`',
    '- `logs da app "nome"`',
    '- `restart|stop|start da app "nome"`',
    '- `listar serviços`',
    '- `start|stop|restart do serviço "nome"`',
    '- `listar bancos`',
    '- `start|stop|restart do banco "nome"`',
    '- `health check coolify`',
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

export function registerCoolifyChatParticipant(
  configManager: ConfigurationManager,
  getProvider: ProviderResolver
): vscode.Disposable | undefined {
  const chatApi = (vscode as unknown as {
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
  }).chat;

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

        const normalizedPrompt = normalize(prompt);
        const appTarget = extractTarget(prompt);
        const serviceTarget = extractServiceTarget(prompt);
        const databaseTarget = extractDatabaseTarget(prompt);
        const hasServiceIntent = looksLikeServiceIntent(normalizedPrompt);
        const hasDatabaseIntent = looksLikeDatabaseIntent(normalizedPrompt);
        const hasApplicationIntent = looksLikeApplicationIntent(normalizedPrompt);

        if (looksLikeConfigureIntent(normalizedPrompt)) {
          await vscode.commands.executeCommand('coolify.configure');
          writeMarkdown(
            stream,
            'Fluxo de configuração iniciado. Após concluir, posso executar deploy, logs e ações de ciclo de vida.'
          );
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

        if (looksLikeHealthIntent(normalizedPrompt)) {
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

        if (
          looksLikeListIntent(normalizedPrompt) &&
          !looksLikeDeployIntent(normalizedPrompt) &&
          hasServiceIntent
        ) {
          writeProgress(stream, 'Buscando serviços...');
          const services = await provider.getServices();
          if (!services.length) {
            writeMarkdown(stream, 'Nenhum serviço encontrado.');
            return;
          }

          const list = services
            .map((service) => `- ${service.name} (${service.status})`)
            .join('\n');
          writeMarkdown(stream, `Serviços encontrados:\n${list}`);
          return;
        }

        if (
          looksLikeListIntent(normalizedPrompt) &&
          !looksLikeDeployIntent(normalizedPrompt) &&
          hasDatabaseIntent
        ) {
          writeProgress(stream, 'Buscando bancos de dados...');
          const databases = await provider.getDatabases();
          if (!databases.length) {
            writeMarkdown(stream, 'Nenhum banco de dados encontrado.');
            return;
          }

          const list = databases
            .map((database) => `- ${database.name} (${database.status})`)
            .join('\n');
          writeMarkdown(stream, `Bancos de dados encontrados:\n${list}`);
          return;
        }

        if (
          looksLikeListIntent(normalizedPrompt) &&
          !looksLikeDeployIntent(normalizedPrompt)
        ) {
          writeProgress(stream, 'Buscando aplicações...');
          const applications = await provider.getApplications();
          if (!applications.length) {
            writeMarkdown(stream, 'Nenhuma aplicação encontrada.');
            return;
          }

          const list = applications
            .map((app) => `- ${app.name} (${app.status})`)
            .join('\n');
          writeMarkdown(stream, `Aplicações encontradas:\n${list}`);
          return;
        }

        if (looksLikeStatusIntent(normalizedPrompt) && hasServiceIntent) {
          writeProgress(stream, 'Consultando status de serviços...');
          const services = await provider.getServices();
          if (!services.length) {
            writeMarkdown(stream, 'Nenhum serviço encontrado.');
            return;
          }

          const service = findService(services, serviceTarget);
          if (service) {
            writeMarkdown(stream, `Status de ${service.name}: ${service.status}`);
            return;
          }

          const statuses = services
            .map((item) => `- ${item.name}: ${item.status}`)
            .join('\n');
          writeMarkdown(stream, `Status dos serviços:\n${statuses}`);
          return;
        }

        if (looksLikeStatusIntent(normalizedPrompt) && hasDatabaseIntent) {
          writeProgress(stream, 'Consultando status de bancos de dados...');
          const databases = await provider.getDatabases();
          if (!databases.length) {
            writeMarkdown(stream, 'Nenhum banco de dados encontrado.');
            return;
          }

          const database = findDatabase(databases, databaseTarget);
          if (database) {
            writeMarkdown(stream, `Status de ${database.name}: ${database.status}`);
            return;
          }

          const statuses = databases
            .map((item) => `- ${item.name}: ${item.status}`)
            .join('\n');
          writeMarkdown(stream, `Status dos bancos de dados:\n${statuses}`);
          return;
        }

        if (looksLikeStatusIntent(normalizedPrompt)) {
          writeProgress(stream, 'Consultando status...');
          const applications = await provider.getApplications();
          if (!applications.length) {
            writeMarkdown(stream, 'Nenhuma aplicação encontrada.');
            return;
          }

          const app = findApplication(applications, appTarget);
          if (app) {
            writeMarkdown(stream, `Status de ${app.name}: ${app.status}`);
            return;
          }

          const statuses = applications
            .map((application) => `- ${application.name}: ${application.status}`)
            .join('\n');
          writeMarkdown(stream, `Status das aplicações:\n${statuses}`);
          return;
        }

        if (looksLikeDeployIntent(normalizedPrompt)) {
          writeProgress(stream, 'Preparando deploy...');
          const applications = await provider.getApplications();
          if (!applications.length) {
            writeMarkdown(stream, 'Nenhuma aplicação encontrada.');
            return;
          }

          const app = findApplication(applications, appTarget);
          if (!app) {
            writeMarkdown(
              stream,
              'Não consegui identificar a aplicação. Use, por exemplo: `deploy da app "meu-app"`.'
            );
            return;
          }

          await provider.deployApplication(app.id);
          writeMarkdown(stream, `Deploy iniciado para ${app.name}.`);
          return;
        }

        if (looksLikeLogsIntent(normalizedPrompt)) {
          writeProgress(stream, 'Buscando logs de deployment...');
          const deployments = await provider.getDeployments();
          if (!deployments.length) {
            writeMarkdown(stream, 'Nenhum deployment encontrado.');
            return;
          }

          const filtered = appTarget
            ? deployments.filter((deployment) =>
                normalize(deployment.applicationName).includes(normalize(appTarget))
              )
            : deployments;

          if (!filtered.length) {
            writeMarkdown(
              stream,
              'Não encontrei deployment para a aplicação informada.'
            );
            return;
          }

          const latest = [...filtered].sort(
            (a, b) =>
              new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          )[0];

          const logs = await provider.getDeploymentLogs(latest.id);
          const output = logs?.trim()
            ? logs.slice(0, 3500)
            : 'Sem logs disponíveis para este deployment.';

          writeMarkdown(
            stream,
            `Logs do deployment ${latest.id} (${latest.applicationName}):\n\n\`\`\`log
${output}
\`\`\``
          );
          return;
        }

        const action = lifecycleAction(normalizedPrompt);
        if (action) {
          if (hasServiceIntent && !hasApplicationIntent) {
            writeProgress(stream, `Executando ação ${action} no serviço...`);
            const services = await provider.getServices();
            if (!services.length) {
              writeMarkdown(stream, 'Nenhum serviço encontrado.');
              return;
            }

            const service = findService(services, serviceTarget);
            if (!service) {
              writeMarkdown(
                stream,
                `Não consegui identificar o serviço. Use, por exemplo: \`${action} do serviço "meu-servico"\`.`
              );
              return;
            }

            let result = '';
            if (action === 'start') {
              result = await provider.startService(service.id);
            } else if (action === 'stop') {
              result = await provider.stopService(service.id);
            } else {
              result = await provider.restartService(service.id);
            }

            writeMarkdown(stream, result || `Ação ${action} enviada para ${service.name}.`);
            return;
          }

          if (hasDatabaseIntent && !hasApplicationIntent) {
            writeProgress(stream, `Executando ação ${action} no banco de dados...`);
            const databases = await provider.getDatabases();
            if (!databases.length) {
              writeMarkdown(stream, 'Nenhum banco de dados encontrado.');
              return;
            }

            const database = findDatabase(databases, databaseTarget);
            if (!database) {
              writeMarkdown(
                stream,
                `Não consegui identificar o banco de dados. Use, por exemplo: \`${action} do banco "meu-banco"\`.`
              );
              return;
            }

            let result = '';
            if (action === 'start') {
              result = await provider.startDatabase(database.id);
            } else if (action === 'stop') {
              result = await provider.stopDatabase(database.id);
            } else {
              result = await provider.restartDatabase(database.id);
            }

            writeMarkdown(stream, result || `Ação ${action} enviada para ${database.name}.`);
            return;
          }

          writeProgress(stream, `Executando ação ${action}...`);
          const applications = await provider.getApplications();
          if (!applications.length) {
            writeMarkdown(stream, 'Nenhuma aplicação encontrada.');
            return;
          }

          const app = findApplication(applications, appTarget);
          if (!app) {
            writeMarkdown(
              stream,
              `Não consegui identificar a aplicação. Use, por exemplo: \`${action} da app "meu-app"\`.`
            );
            return;
          }

          let result = '';
          if (action === 'start') {
            result = await provider.startApplication(app.id);
          } else if (action === 'stop') {
            result = await provider.stopApplication(app.id);
          } else {
            result = await provider.restartApplication(app.id);
          }

          writeMarkdown(stream, result || `Ação ${action} enviada para ${app.name}.`);
          return;
        }

        writeMarkdown(stream, helpText());
      } catch (error) {
        logger.error('Coolify chat participant failed', error);
        writeMarkdown(
          stream,
          error instanceof Error
            ? `Falha ao processar comando do chat: ${error.message}`
            : 'Falha ao processar comando do chat.'
        );
      }
    }
  );
}

function findService(
  services: ServiceListItem[],
  target?: string
): ServiceListItem | undefined {
  if (!target) {
    return services.length === 1 ? services[0] : undefined;
  }

  const normalizedTarget = normalize(target);
  const exact = services.find(
    (service) =>
      normalize(service.name) === normalizedTarget ||
      normalize(service.id) === normalizedTarget
  );
  if (exact) {
    return exact;
  }

  return services.find((service) =>
    normalize(service.name).includes(normalizedTarget)
  );
}

function findDatabase(
  databases: DatabaseListItem[],
  target?: string
): DatabaseListItem | undefined {
  if (!target) {
    return databases.length === 1 ? databases[0] : undefined;
  }

  const normalizedTarget = normalize(target);
  const exact = databases.find(
    (database) =>
      normalize(database.name) === normalizedTarget ||
      normalize(database.id) === normalizedTarget
  );
  if (exact) {
    return exact;
  }

  return databases.find((database) =>
    normalize(database.name).includes(normalizedTarget)
  );
}