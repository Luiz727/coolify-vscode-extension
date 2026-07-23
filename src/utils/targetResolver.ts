/**
 * Resolves a user- or model-supplied reference to exactly one resource.
 *
 * The previous behaviour silently guessed: an unknown id fell through to name
 * matching, a partial match returned whichever candidate happened to come
 * first, and when everything failed it used "the only application" — which
 * meant an ambiguous chat message could stop or deploy production.
 *
 * The rules here are deliberately strict for anything that changes state:
 *   - an explicit id that does not exist is an error, never a fallback;
 *   - more than one partial match is an error listing the candidates;
 *   - the "single resource" shortcut is allowed only for read operations.
 */

export interface ResolvableResource {
  uuid: string;
  name: string;
}

export class TargetResolutionError extends Error {
  constructor(
    message: string,
    public readonly candidates: string[] = []
  ) {
    super(message);
    this.name = 'TargetResolutionError';
  }
}

export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export interface ResolveOptions {
  /** Human label used in error messages, e.g. "aplicação". */
  entityLabel: string;
  /** Read operations may fall back to the only resource; writes may not. */
  allowSingleFallback: boolean;
}

export function resolveTarget<T extends ResolvableResource>(
  resources: T[],
  id: string | undefined,
  name: string | undefined,
  options: ResolveOptions
): T {
  const { entityLabel, allowSingleFallback } = options;

  if (resources.length === 0) {
    throw new TargetResolutionError(
      `Nenhum(a) ${entityLabel} encontrado(a) no Coolify.`
    );
  }

  if (id?.trim()) {
    const trimmedId = id.trim();
    const byId = resources.find((item) => item.uuid === trimmedId);
    if (byId) {
      return byId;
    }

    // An explicit identifier that does not exist is a mistake worth surfacing.
    // Falling back to a name or to "the only one" would act on the wrong thing.
    throw new TargetResolutionError(
      `${entityLabel} com id "${trimmedId}" nao existe. Verifique o identificador.`,
      resources.slice(0, 10).map((item) => `${item.name} (${item.uuid})`)
    );
  }

  if (name?.trim()) {
    const target = normalizeName(name);

    const exactMatches = resources.filter(
      (item) => normalizeName(item.name) === target
    );
    if (exactMatches.length === 1) {
      return exactMatches[0];
    }
    if (exactMatches.length > 1) {
      throw new TargetResolutionError(
        `Existe mais de um(a) ${entityLabel} chamado(a) "${name}". Informe o id.`,
        exactMatches.map((item) => `${item.name} (${item.uuid})`)
      );
    }

    const partialMatches = resources.filter((item) =>
      normalizeName(item.name).includes(target)
    );

    if (partialMatches.length === 1) {
      return partialMatches[0];
    }

    if (partialMatches.length > 1) {
      // "api" matching both api-prod and api-staging must never silently pick
      // the first one — especially not for a stop or a deploy.
      throw new TargetResolutionError(
        `"${name}" corresponde a ${partialMatches.length} ${entityLabel}s. Seja mais especifico ou informe o id.`,
        partialMatches.map((item) => `${item.name} (${item.uuid})`)
      );
    }

    throw new TargetResolutionError(
      `Nenhum(a) ${entityLabel} corresponde a "${name}".`,
      resources.slice(0, 10).map((item) => `${item.name} (${item.uuid})`)
    );
  }

  if (allowSingleFallback && resources.length === 1) {
    return resources[0];
  }

  throw new TargetResolutionError(
    allowSingleFallback
      ? `Informe qual ${entityLabel} voce quer consultar.`
      : `Informe explicitamente qual ${entityLabel} deve ser alterado(a). Acoes que mudam estado nao assumem um alvo padrao.`,
    resources.slice(0, 10).map((item) => `${item.name} (${item.uuid})`)
  );
}

/** Formats a resolution error for display in chat or a tool result. */
export function describeResolutionError(error: unknown): string {
  if (!(error instanceof TargetResolutionError)) {
    return error instanceof Error ? error.message : String(error);
  }

  if (error.candidates.length === 0) {
    return error.message;
  }

  return `${error.message}\n\nOpcoes:\n${error.candidates
    .map((candidate) => `- ${candidate}`)
    .join('\n')}`;
}
