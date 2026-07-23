import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';

const MAX_BUFFER_ENTRIES = Number(process.env.AUDIT_BUFFER_ENTRIES || 500);
const MAX_FILE_BYTES = Number(process.env.AUDIT_MAX_FILE_BYTES || 16 * 1024 * 1024);
const MAX_ROTATED_FILES = Number(process.env.AUDIT_MAX_ROTATED_FILES || 5);

/**
 * Ring buffer of recent entries.
 *
 * The console polls the audit trail every few seconds. Re-reading the whole
 * JSONL file on each poll turns into megabytes of disk I/O per minute once the
 * log has been running for a few months, so reads are served from memory and
 * the file is only appended to.
 */
let buffer = [];
let auditLogPath = '';
let writeChain = Promise.resolve();

export function getAuditLogPath() {
  return auditLogPath;
}

export async function initAuditLog(configuredPath, logger = console) {
  auditLogPath = path.resolve(
    process.cwd(),
    configuredPath || './data/audit.log.jsonl'
  );

  await fs.mkdir(path.dirname(auditLogPath), { recursive: true });
  buffer = await readTailEntries(auditLogPath, MAX_BUFFER_ENTRIES, logger);

  logger.log?.(
    `[audit] trilha em ${auditLogPath} (${buffer.length} eventos carregados em memoria)`
  );
}

/**
 * Streams the file and keeps only the last N parsed lines, so startup cost
 * stays bounded no matter how large the log grew.
 */
async function readTailEntries(filePath, limit, logger) {
  try {
    await fs.access(filePath);
  } catch {
    return [];
  }

  return new Promise((resolve) => {
    const entries = [];
    let pending = '';

    const stream = createReadStream(filePath, { encoding: 'utf8' });

    const pushLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      try {
        entries.push(JSON.parse(trimmed));
        if (entries.length > limit) {
          entries.shift();
        }
      } catch {
        // Corrupted line: skip it rather than losing the whole trail.
      }
    };

    stream.on('data', (chunk) => {
      const parts = (pending + chunk).split('\n');
      pending = parts.pop() ?? '';
      for (const part of parts) {
        pushLine(part);
      }
    });

    stream.on('end', () => {
      pushLine(pending);
      resolve(entries);
    });

    stream.on('error', (error) => {
      logger.warn?.('[audit] falha ao ler trilha existente', error.message);
      resolve([]);
    });
  });
}

async function rotateIfNeeded(logger) {
  try {
    const stats = await fs.stat(auditLogPath);
    if (stats.size < MAX_FILE_BYTES) {
      return;
    }

    for (let index = MAX_ROTATED_FILES - 1; index >= 1; index -= 1) {
      const from = `${auditLogPath}.${index}`;
      const to = `${auditLogPath}.${index + 1}`;
      await fs.rename(from, to).catch(() => undefined);
    }

    await fs.rename(auditLogPath, `${auditLogPath}.1`).catch(() => undefined);
    logger.log?.('[audit] trilha rotacionada por limite de tamanho');
  } catch {
    // File may not exist yet — nothing to rotate.
  }
}

export function appendAuditEntry(entry, logger = console) {
  const record = { ...entry, timestamp: new Date().toISOString() };

  buffer.push(record);
  if (buffer.length > MAX_BUFFER_ENTRIES) {
    buffer.shift();
  }

  // Serialize writes so concurrent actions cannot interleave partial lines.
  writeChain = writeChain
    .then(async () => {
      await rotateIfNeeded(logger);
      await fs.appendFile(auditLogPath, `${JSON.stringify(record)}\n`, 'utf8');
    })
    .catch((error) => {
      logger.error?.('[audit] falha ao gravar evento', error.message);
    });

  return record;
}

export function readAuditEntries(take = 100) {
  const safeTake = Number.isFinite(Number(take))
    ? Math.max(1, Math.min(MAX_BUFFER_ENTRIES, Math.trunc(Number(take))))
    : 100;

  return buffer.slice(-safeTake).reverse();
}

export const auditInternals = {
  reset() {
    buffer = [];
  },
  get size() {
    return buffer.length;
  },
};
