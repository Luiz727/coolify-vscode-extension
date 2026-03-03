import type * as vscode from 'vscode';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class LoggerService {
  private static instance: LoggerService;
  private readonly outputChannel: {
    appendLine(message: string): void;
    show(preserveFocus?: boolean): void;
  };
  private readonly vscodeApi?: typeof vscode;

  private constructor() {
    this.vscodeApi = this.tryGetVscodeApi();

    if (this.vscodeApi) {
      this.outputChannel = this.vscodeApi.window.createOutputChannel(
        'Coolify Extension'
      );
      return;
    }

    this.outputChannel = {
      appendLine: (message: string) => {
        console.log(message);
      },
      show: () => undefined,
    };
  }

  private tryGetVscodeApi(): typeof vscode | undefined {
    try {
      const runtimeRequire = eval('require') as ((id: string) => unknown) | undefined;
      if (!runtimeRequire) {
        return undefined;
      }

      return runtimeRequire('vscode') as typeof vscode;
    } catch {
      return undefined;
    }
  }

  static getInstance(): LoggerService {
    if (!LoggerService.instance) {
      LoggerService.instance = new LoggerService();
    }

    return LoggerService.instance;
  }

  show(): void {
    this.outputChannel.show(true);
  }

  debug(message: string, details?: unknown): void {
    this.write('debug', message, details);
  }

  info(message: string, details?: unknown): void {
    this.write('info', message, details);
  }

  warn(message: string, details?: unknown): void {
    this.write('warn', message, details);
  }

  error(message: string, details?: unknown): void {
    this.write('error', message, details);
  }

  private write(level: LogLevel, message: string, details?: unknown): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const timestamp = new Date().toISOString();
    const safeMessage = this.redact(String(message));
    const safeDetails = this.toSafeDetails(details);

    if (safeDetails) {
      this.outputChannel.appendLine(
        `[${timestamp}] [${level.toUpperCase()}] ${safeMessage} | ${safeDetails}`
      );
      return;
    }

    this.outputChannel.appendLine(
      `[${timestamp}] [${level.toUpperCase()}] ${safeMessage}`
    );
  }

  private shouldLog(level: LogLevel): boolean {
    const configured = this.vscodeApi?.workspace
      .getConfiguration('coolify')
      .get<LogLevel>('logLevel', 'info') ?? 'info';

    return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[configured];
  }

  private toSafeDetails(details?: unknown): string | undefined {
    if (details === undefined || details === null) {
      return undefined;
    }

    if (details instanceof Error) {
      const summary = {
        name: details.name,
        message: details.message,
      };

      return this.redact(JSON.stringify(summary));
    }

    if (typeof details === 'string') {
      return this.redact(details);
    }

    try {
      return this.redact(JSON.stringify(details));
    } catch {
      return this.redact(String(details));
    }
  }

  private redact(value: string): string {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [REDACTED]')
      .replace(/("token"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3')
      .replace(/(token=)([^&\s]+)/gi, '$1[REDACTED]');
  }
}

export const logger = LoggerService.getInstance();
