import type {
  Application as CoolifyApplication,
  ApplicationLifecycleResponse,
  Deployment as CoolifyDeployment,
  EnvironmentVariable,
} from '../services/CoolifyService';

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isValidCoolifyApplication(
  value: unknown
): value is CoolifyApplication {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.uuid) &&
    isNonEmptyString(candidate.name) &&
    isNonEmptyString(candidate.status)
  );
}

export function isValidCoolifyDeployment(
  value: unknown
): value is CoolifyDeployment {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.id) &&
    isNonEmptyString(candidate.application_id) &&
    isNonEmptyString(candidate.application_name) &&
    isNonEmptyString(candidate.status)
  );
}

export function isValidEnvironmentVariable(
  value: unknown
): value is EnvironmentVariable {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.uuid) &&
    isNonEmptyString(candidate.key) &&
    typeof candidate.value === 'string'
  );
}

export function isValidApplicationLifecycleResponse(
  value: unknown
): value is ApplicationLifecycleResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  const hasValidMessage =
    candidate.message === undefined || typeof candidate.message === 'string';
  const hasValidDeploymentUuid =
    candidate.deployment_uuid === undefined ||
    typeof candidate.deployment_uuid === 'string';

  return hasValidMessage && hasValidDeploymentUuid;
}

export function parseArrayPayload<T>(
  payload: unknown,
  guard: (value: unknown) => value is T,
  entityName: string
): { items: T[]; invalidCount: number } {
  if (!Array.isArray(payload)) {
    throw new Error(`Invalid ${entityName} payload: expected array.`);
  }

  const items = payload.filter(guard);
  return {
    items,
    invalidCount: payload.length - items.length,
  };
}

export function parseObjectPayload<T>(
  payload: unknown,
  guard: (value: unknown) => value is T,
  entityName: string
): T {
  if (!guard(payload)) {
    throw new Error(`Invalid ${entityName} payload: expected object shape.`);
  }

  return payload;
}