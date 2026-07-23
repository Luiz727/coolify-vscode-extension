import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearCoolifyCache,
  createCoolifyClient,
  executeAction,
} from '../coolify.js';

const silentLogger = { error() {}, warn() {}, log() {} };

function mockFetch(responder) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET' });
    return responder(String(url), init);
  };
  return calls;
}

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  clearCoolifyCache();
});

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('reads are served from cache within the TTL', async () => {
  clearCoolifyCache();
  const calls = mockFetch(() => jsonResponse([{ uuid: 'a', name: 'app', status: 'running' }]));

  const client = createCoolifyClient({
    baseUrl: 'https://coolify.example.com',
    token: 'tok',
    logger: silentLogger,
  });

  await client.call('/applications');
  await client.call('/applications');

  assert.equal(calls.length, 1, 'a segunda leitura deve vir do cache');
});

/**
 * The bug this guards: after a start/stop the panel refreshes immediately, and
 * the refresh was answered from the 5s cache — showing the old status, as if
 * the action had done nothing.
 */
test('an action invalidates the cached resource snapshot', async () => {
  clearCoolifyCache();
  const calls = mockFetch((url) => {
    if (url.includes('/start')) {
      return jsonResponse({ message: 'started' });
    }
    return jsonResponse([{ uuid: 'a', name: 'app', status: 'running' }]);
  });

  const client = createCoolifyClient({
    baseUrl: 'https://coolify.example.com',
    token: 'tok',
    logger: silentLogger,
  });

  await client.call('/applications');
  const readsBefore = calls.filter((call) => call.url.endsWith('/applications')).length;
  assert.equal(readsBefore, 1);

  await executeAction(client, {
    resourceType: 'application',
    uuid: 'a',
    action: 'start',
  });

  await client.call('/applications');
  const readsAfter = calls.filter((call) => call.url.endsWith('/applications')).length;

  assert.equal(readsAfter, 2, 'apos a acao a leitura precisa ir ate o Coolify');
});

test('a failed action also invalidates the cache', async () => {
  clearCoolifyCache();
  const calls = mockFetch((url) => {
    if (url.includes('/stop')) {
      return new Response('boom', { status: 500 });
    }
    return jsonResponse([{ uuid: 'a', name: 'app', status: 'running' }]);
  });

  const client = createCoolifyClient({
    baseUrl: 'https://coolify.example.com',
    token: 'tok',
    logger: silentLogger,
  });

  await client.call('/applications');

  // A 500 may still mean the action was partially applied, so the cached
  // snapshot cannot be trusted afterwards either.
  await assert.rejects(
    executeAction(client, { resourceType: 'application', uuid: 'a', action: 'stop' })
  );

  await client.call('/applications');
  const reads = calls.filter((call) => call.url.endsWith('/applications')).length;
  assert.equal(reads, 2);
});

test('action requests are never served from cache themselves', async () => {
  clearCoolifyCache();
  const calls = mockFetch(() => jsonResponse({ message: 'ok' }));

  const client = createCoolifyClient({
    baseUrl: 'https://coolify.example.com',
    token: 'tok',
    logger: silentLogger,
  });

  await executeAction(client, { resourceType: 'service', uuid: 's', action: 'restart' });
  await executeAction(client, { resourceType: 'service', uuid: 's', action: 'restart' });

  const restarts = calls.filter((call) => call.url.includes('/restart')).length;
  assert.equal(restarts, 2, 'cada acao precisa chegar ao servidor');
});

test('upstream error bodies never reach the caller message', async () => {
  clearCoolifyCache();
  mockFetch(() => new Response('token=super-secreto-vazando', { status: 500 }));

  const client = createCoolifyClient({
    baseUrl: 'https://coolify.example.com',
    token: 'tok',
    logger: silentLogger,
  });

  await assert.rejects(client.call('/applications'), (error) => {
    assert.ok(!error.message.includes('super-secreto'));
    assert.match(error.message, /Coolify indisponivel|erro interno/i);
    return true;
  });
});
