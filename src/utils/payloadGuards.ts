import type {
  Application as CoolifyApplication,
  Deployment as CoolifyDeployment,
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