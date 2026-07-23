/**
 * Intent routing for the @coolify chat participant.
 *
 * The previous implementation checked intents in an order that let
 * "listar deployments" fall through to the deploy branch: the list guard was
 * `looksLikeList && !looksLikeDeploy`, and the word "deployments" satisfies
 * `looksLikeDeploy`. With a single application registered, the resolver then
 * returned that application and a real deployment was fired.
 *
 * The rules here are explicit and ordered so that reading intents always win
 * over acting intents, and every action requires an explicit target.
 */

export type ResourceKind = 'application' | 'service' | 'database';

export type ChatIntent =
  | { kind: 'help' }
  | { kind: 'configure' }
  | { kind: 'health' }
  | { kind: 'list'; resource: ResourceKind }
  | { kind: 'status'; resource: ResourceKind }
  | { kind: 'logs' }
  | { kind: 'deployments' }
  | { kind: 'deploy' }
  | { kind: 'lifecycle'; action: 'start' | 'stop' | 'restart'; resource: ResourceKind }
  | { kind: 'servers' };

export function normalize(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function hasAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

/** Matches a whole word, so "deployments" never counts as the verb "deploy". */
function hasWord(text: string, words: string[]): boolean {
  return words.some((word) =>
    new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`).test(text)
  );
}

const LIST_WORDS = ['listar', 'liste', 'list', 'mostrar', 'mostre', 'exibir', 'quais'];
const STATUS_WORDS = ['status', 'estado', 'saude do', 'situacao'];
const LOG_WORDS = ['log', 'logs'];
const SERVER_WORDS = ['servidor', 'servidores', 'server', 'servers', 'vps', 'maquina'];
const DEPLOYMENT_NOUNS = ['deployment', 'deployments', 'deploys', 'implantacoes'];
const HEALTH_WORDS = ['health', 'saude', 'conexao', 'conectividade'];
const CONFIGURE_WORDS = ['configurar', 'configure', 'api key', 'token'];

const SERVICE_WORDS = ['service', 'services', 'servico', 'servicos'];
const DATABASE_WORDS = ['database', 'databases', 'banco', 'bancos', 'bd'];

function detectResource(text: string): ResourceKind {
  if (hasAny(text, SERVICE_WORDS)) {
    return 'service';
  }
  if (hasAny(text, DATABASE_WORDS)) {
    return 'database';
  }
  return 'application';
}

function detectLifecycleAction(
  text: string
): 'start' | 'stop' | 'restart' | undefined {
  if (hasWord(text, ['restart', 'reiniciar', 'reinicie', 'reinicia'])) {
    return 'restart';
  }
  if (hasWord(text, ['stop', 'parar', 'pare', 'para', 'desligar', 'desligue'])) {
    return 'stop';
  }
  if (hasWord(text, ['start', 'iniciar', 'inicie', 'ligar', 'ligue', 'subir'])) {
    return 'start';
  }
  return undefined;
}

export function routeIntent(rawPrompt: string): ChatIntent {
  const text = normalize(rawPrompt.trim());

  if (!text) {
    return { kind: 'help' };
  }

  if (hasAny(text, CONFIGURE_WORDS)) {
    return { kind: 'configure' };
  }

  if (hasAny(text, HEALTH_WORDS)) {
    return { kind: 'health' };
  }

  const wantsList = hasAny(text, LIST_WORDS);
  const mentionsDeploymentNoun = hasAny(text, DEPLOYMENT_NOUNS);
  const mentionsLogs = hasAny(text, LOG_WORDS);
  const mentionsServers = hasAny(text, SERVER_WORDS);

  // Reading intents are resolved first and unconditionally. "listar
  // deployments" is a query about history, never a request to deploy.
  if (wantsList || mentionsDeploymentNoun) {
    if (mentionsLogs) {
      return { kind: 'logs' };
    }
    if (mentionsDeploymentNoun) {
      return { kind: 'deployments' };
    }
    if (mentionsServers) {
      return { kind: 'servers' };
    }
    if (wantsList) {
      return { kind: 'list', resource: detectResource(text) };
    }
  }

  if (mentionsServers && !detectLifecycleAction(text)) {
    return { kind: 'servers' };
  }

  if (hasAny(text, STATUS_WORDS)) {
    return { kind: 'status', resource: detectResource(text) };
  }

  if (mentionsLogs) {
    return { kind: 'logs' };
  }

  const action = detectLifecycleAction(text);
  if (action) {
    return { kind: 'lifecycle', action, resource: detectResource(text) };
  }

  // Only a bare verb reaches the deploy branch, and only as a whole word.
  if (hasWord(text, ['deploy', 'deployar', 'implantar', 'publicar', 'publique'])) {
    return { kind: 'deploy' };
  }

  return { kind: 'help' };
}

/**
 * Extracts the resource name from the prompt.
 * Quoted names win; otherwise a keyword-anchored token is accepted.
 */
export function extractTarget(prompt: string): string | undefined {
  const quoted = prompt.match(/"([^"]+)"/) || prompt.match(/'([^']+)'/);
  if (quoted?.[1]?.trim()) {
    return quoted[1].trim();
  }

  const patterns = [
    /(?:app|aplicacao|aplicação|application)\s+(?:")?([a-zA-Z0-9._-]+)/i,
    /(?:service|servico|serviço)\s+(?:")?([a-zA-Z0-9._-]+)/i,
    /(?:database|banco|bd)\s+(?:de\s+dados\s+)?(?:")?([a-zA-Z0-9._-]+)/i,
    /(?:servidor|server)\s+(?:")?([a-zA-Z0-9._-]+)/i,
  ];

  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    const value = match?.[1]?.trim();
    // Guard against capturing a stop word that follows the keyword.
    if (value && !['de', 'do', 'da', 'the', 'a', 'o'].includes(value.toLowerCase())) {
      return value;
    }
  }

  return undefined;
}
