export interface ParsedEnvVariable {
  key: string;
  value: string;
  line: number;
}

const VARIABLE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseQuotedValue(input: string): string {
  const quote = input[0];
  const endsWithQuote = input.length >= 2 && input[input.length - 1] === quote;
  const core = endsWithQuote ? input.slice(1, -1) : input.slice(1);

  if (quote === '"') {
    return core
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  return core;
}

function parseRawValue(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return parseQuotedValue(trimmed);
  }

  const commentIndex = trimmed.search(/\s+#/);
  if (commentIndex >= 0) {
    return trimmed.slice(0, commentIndex).trimEnd();
  }

  return trimmed;
}

export function parseEnvFile(content: string): ParsedEnvVariable[] {
  const entries: ParsedEnvVariable[] = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const withoutExport = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).trim()
      : trimmed;

    const separatorIndex = withoutExport.indexOf('=');
    if (separatorIndex <= 0) {
      return;
    }

    const key = withoutExport.slice(0, separatorIndex).trim();
    if (!VARIABLE_KEY_PATTERN.test(key)) {
      return;
    }

    const rawValue = withoutExport.slice(separatorIndex + 1);
    const value = parseRawValue(rawValue);

    entries.push({
      key,
      value,
      line: lineIndex + 1,
    });
  });

  return entries;
}
