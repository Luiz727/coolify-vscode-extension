import * as assert from 'assert';
import { CoolifyApiError, HttpClient } from '../services/HttpClient';

type MockFetch = (
  input: unknown,
  init?: RequestInit
) => Promise<Response>;

suite('HttpClient Tests', () => {
  const originalFetch = globalThis.fetch;

  teardown(() => {
    globalThis.fetch = originalFetch;
  });

  test('get returns parsed JSON on success', async () => {
    const mockFetch: MockFetch = async () => {
      return new Response(JSON.stringify({ version: '4.0.0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    globalThis.fetch = mockFetch;

    const client = new HttpClient({ baseUrl: 'https://coolify.example.com' });
    const data = await client.get<{ version: string }>('/api/v1/version');

    assert.strictEqual(data.version, '4.0.0');
  });

  test('request throws auth error on 401', async () => {
    const mockFetch: MockFetch = async () => {
      return new Response('Unauthorized', { status: 401 });
    };

    globalThis.fetch = mockFetch;

    const client = new HttpClient({
      baseUrl: 'https://coolify.example.com',
      token: 'invalid',
    });

    await assert.rejects(async () => client.get('/api/v1/applications'), (error: unknown) => {
      assert.ok(error instanceof CoolifyApiError);
      assert.strictEqual(error.type, 'auth');
      assert.strictEqual(error.statusCode, 401);
      return true;
    });
  });

  test('request throws server error on 5xx', async () => {
    const mockFetch: MockFetch = async () => {
      return new Response('Internal Server Error', { status: 500 });
    };

    globalThis.fetch = mockFetch;

    const client = new HttpClient({ baseUrl: 'https://coolify.example.com' });

    await assert.rejects(async () => client.get('/api/v1/applications'), (error: unknown) => {
      assert.ok(error instanceof CoolifyApiError);
      assert.strictEqual(error.type, 'server');
      assert.strictEqual(error.statusCode, 500);
      return true;
    });
  });

  test('request throws timeout error on AbortError', async () => {
    const mockFetch: MockFetch = async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    };

    globalThis.fetch = mockFetch;

    const client = new HttpClient({ baseUrl: 'https://coolify.example.com' });

    await assert.rejects(async () => client.get('/api/health'), (error: unknown) => {
      assert.ok(error instanceof CoolifyApiError);
      assert.strictEqual(error.type, 'timeout');
      return true;
    });
  });

  test('request throws network error on non-abort fetch failure', async () => {
    const mockFetch: MockFetch = async () => {
      throw new Error('socket hang up');
    };

    globalThis.fetch = mockFetch;

    const client = new HttpClient({ baseUrl: 'https://coolify.example.com' });

    await assert.rejects(async () => client.get('/api/health'), (error: unknown) => {
      assert.ok(error instanceof CoolifyApiError);
      assert.strictEqual(error.type, 'network');
      return true;
    });
  });
});
