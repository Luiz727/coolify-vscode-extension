const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F]/g;

export function sanitizeDisplayText(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(CONTROL_CHARS_REGEX, '').trim();
}

export function sanitizeDisplayTextOrFallback(
  value: unknown,
  fallback: string
): string {
  const sanitized = sanitizeDisplayText(value);
  return sanitized.length > 0 ? sanitized : fallback;
}