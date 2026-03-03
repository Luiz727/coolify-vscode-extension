export type ApiErrorType =
  | 'auth'
  | 'forbidden'
  | 'not-found'
  | 'validation'
  | 'timeout'
  | 'network'
  | 'server'
  | 'unknown';

export class CoolifyApiError extends Error {
  constructor(
    message: string,
    public readonly type: ApiErrorType,
    public readonly statusCode?: number,
    public readonly endpoint?: string
  ) {
    super(message);
    this.name = 'CoolifyApiError';
  }
}

interface HttpClientOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10000;

export class HttpClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'GET' });
  }

  async request<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const url = `${this.baseUrl}${endpoint}`;

    try {
      const headers = new Headers(init.headers);
      if (this.token) {
        headers.set('Authorization', `Bearer ${this.token}`);
      }

      const response = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw this.toApiError(response, endpoint);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return (await response.json()) as T;
      }

      return (await response.text()) as T;
    } catch (error) {
      if (error instanceof CoolifyApiError) {
        throw error;
      }

      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new CoolifyApiError(
          'Connection timed out while communicating with Coolify server.',
          'timeout',
          undefined,
          endpoint
        );
      }

      throw new CoolifyApiError(
        'Network error while communicating with Coolify server.',
        'network',
        undefined,
        endpoint
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private toApiError(response: Response, endpoint: string): CoolifyApiError {
    const status = response.status;

    if (status === 401) {
      return new CoolifyApiError(
        'Authentication failed. Please verify your API token.',
        'auth',
        status,
        endpoint
      );
    }

    if (status === 403) {
      return new CoolifyApiError(
        'Permission denied for this action in Coolify.',
        'forbidden',
        status,
        endpoint
      );
    }

    if (status === 404) {
      return new CoolifyApiError(
        'Requested Coolify resource was not found.',
        'not-found',
        status,
        endpoint
      );
    }

    if (status === 422) {
      return new CoolifyApiError(
        'Invalid request data sent to Coolify API.',
        'validation',
        status,
        endpoint
      );
    }

    if (status >= 500) {
      return new CoolifyApiError(
        'Coolify server is unavailable or returned an internal error.',
        'server',
        status,
        endpoint
      );
    }

    return new CoolifyApiError(
      `Unexpected API error (${status}).`,
      'unknown',
      status,
      endpoint
    );
  }
}