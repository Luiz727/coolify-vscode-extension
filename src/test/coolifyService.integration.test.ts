import * as assert from 'assert';
import { CoolifyService } from '../services/CoolifyService';

type FetchCall = {
  input: unknown;
  init?: RequestInit;
};

type MockFetch = (
  input: unknown,
  init?: RequestInit
) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

suite('CoolifyService Integration (Mock API)', () => {
  const originalFetch = globalThis.fetch;

  teardown(() => {
    globalThis.fetch = originalFetch;
  });

  test('listEnvironmentVariables calls expected endpoint with auth header', async () => {
    const calls: FetchCall[] = [];

    const mockFetch: MockFetch = async (input, init) => {
      calls.push({ input, init });
      return jsonResponse([
        {
          uuid: 'env-1',
          key: 'API_KEY',
          value: 'secret',
          is_buildtime: true,
          is_runtime: true,
          is_preview: false,
        },
      ]);
    };

    globalThis.fetch = mockFetch;

    const service = new CoolifyService('https://coolify.example.com', 'token-123');
    const envs = await service.listEnvironmentVariables('app-1');

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(
      String(calls[0].input),
      'https://coolify.example.com/api/v1/applications/app-1/envs'
    );
    const headers = new Headers(calls[0].init?.headers);
    assert.strictEqual(headers.get('authorization'), 'Bearer token-123');
    assert.strictEqual(envs[0].key, 'API_KEY');
  });

  test('create/update/delete env vars use correct methods and endpoints', async () => {
    const calls: FetchCall[] = [];

    const mockFetch: MockFetch = async (input, init) => {
      calls.push({ input, init });

      if (calls.length === 1) {
        return jsonResponse({
          uuid: 'env-1',
          key: 'API_KEY',
          value: 'value-1',
          is_buildtime: true,
          is_runtime: true,
          is_preview: false,
        });
      }

      if (calls.length === 2) {
        return jsonResponse({
          uuid: 'env-1',
          key: 'API_KEY',
          value: 'value-2',
          is_buildtime: true,
          is_runtime: true,
          is_preview: false,
        });
      }

      return new Response(null, { status: 204 });
    };

    globalThis.fetch = mockFetch;

    const service = new CoolifyService('https://coolify.example.com', 'token-123');

    await service.createEnvironmentVariable('app-1', {
      key: 'API_KEY',
      value: 'value-1',
      is_buildtime: true,
      is_runtime: true,
      is_preview: false,
    });

    await service.updateEnvironmentVariable('app-1', {
      uuid: 'env-1',
      key: 'API_KEY',
      value: 'value-2',
    });

    await service.deleteEnvironmentVariable('app-1', 'env-1');

    assert.strictEqual(calls.length, 3);

    assert.strictEqual(
      String(calls[0].input),
      'https://coolify.example.com/api/v1/applications/app-1/envs'
    );
    assert.strictEqual(calls[0].init?.method, 'POST');

    assert.strictEqual(
      String(calls[1].input),
      'https://coolify.example.com/api/v1/applications/app-1/envs'
    );
    assert.strictEqual(calls[1].init?.method, 'PATCH');

    assert.strictEqual(
      String(calls[2].input),
      'https://coolify.example.com/api/v1/applications/app-1/envs/env-1'
    );
    assert.strictEqual(calls[2].init?.method, 'DELETE');
  });

  test('deployment and lifecycle endpoints are wired correctly', async () => {
    const calls: FetchCall[] = [];

    const mockFetch: MockFetch = async (input, init) => {
      calls.push({ input, init });

      const url = String(input);
      if (url.includes('/deployments/deploy-1/cancel')) {
        return jsonResponse({ ok: true });
      }

      if (url.endsWith('/applications/app-1/start')) {
        return jsonResponse({ message: 'Application start request queued.' });
      }

      return jsonResponse({ ok: true });
    };

    globalThis.fetch = mockFetch;

    const service = new CoolifyService('https://coolify.example.com', 'token-123');
    await service.startDeployment('app-1');
    await service.cancelDeployment('deploy-1');
    const message = await service.startApplication('app-1');

    assert.strictEqual(message, 'Application start request queued.');

    assert.strictEqual(
      String(calls[0].input),
      'https://coolify.example.com/api/v1/deploy?uuid=app-1'
    );
    assert.strictEqual(calls[0].init?.method, 'GET');

    assert.strictEqual(
      String(calls[1].input),
      'https://coolify.example.com/api/v1/deployments/deploy-1/cancel'
    );
    assert.strictEqual(calls[1].init?.method, 'POST');

    assert.strictEqual(
      String(calls[2].input),
      'https://coolify.example.com/api/v1/applications/app-1/start'
    );
    assert.strictEqual(calls[2].init?.method, 'GET');
  });
});
