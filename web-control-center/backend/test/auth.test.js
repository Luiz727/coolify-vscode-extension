import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPasswordHash,
  createSession,
  destroySession,
  loadAuthConfig,
  parsePasswordHash,
  resolveSession,
  verifyCredentials,
} from '../auth.js';

test('config is rejected when credentials are missing (fail-closed)', () => {
  const result = loadAuthConfig({});
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors.some((e) => e.includes('WEB_AUTH_USER')));
  assert.ok(result.errors.some((e) => e.includes('WEB_AUTH_PASSWORD_HASH')));
});

test('config is rejected when only the user is present', () => {
  const result = loadAuthConfig({ WEB_AUTH_USER: 'admin' });
  assert.ok(result.errors.length > 0);
});

test('malformed password hash is rejected', () => {
  const result = loadAuthConfig({
    WEB_AUTH_USER: 'admin',
    WEB_AUTH_PASSWORD_HASH: 'nao-e-um-hash',
  });
  assert.ok(result.errors.some((e) => e.includes('malformed')));
});

test('short service tokens are rejected', () => {
  const result = loadAuthConfig({
    WEB_AUTH_USER: 'admin',
    WEB_AUTH_PASSWORD: 'senha-longa-o-bastante',
    WEB_ACCESS_TOKEN: 'curto',
  });
  assert.ok(result.errors.some((e) => e.includes('WEB_ACCESS_TOKEN')));
});

test('password hashing round-trips and rejects wrong passwords', async () => {
  const hash = await createPasswordHash('uma-senha-bem-longa');
  const parsed = parsePasswordHash(hash);
  assert.ok(parsed, 'hash gerado deve ser parseavel');

  const config = { user: 'admin', parsedHash: parsed, plainPassword: '' };
  assert.equal(await verifyCredentials(config, 'admin', 'uma-senha-bem-longa'), true);
  assert.equal(await verifyCredentials(config, 'admin', 'senha-errada'), false);
  assert.equal(await verifyCredentials(config, 'outro', 'uma-senha-bem-longa'), false);
  assert.equal(await verifyCredentials(config, '', ''), false);
});

test('each hash uses a fresh salt', async () => {
  const first = await createPasswordHash('mesma-senha-aqui');
  const second = await createPasswordHash('mesma-senha-aqui');
  assert.notEqual(first, second);
});

/**
 * The old implementation returned base64(user:password) as the session token,
 * which meant handing the credential itself to the browser.
 */
test('session tokens are random, not derived from credentials', () => {
  const first = createSession('admin');
  const second = createSession('admin');

  assert.notEqual(first, second);
  assert.ok(first.length >= 40);

  const credentialEncoding = Buffer.from('admin:senha').toString('base64url');
  assert.notEqual(first, credentialEncoding);
  assert.ok(!Buffer.from(first, 'base64url').toString('utf8').includes('admin'));
});

test('sessions resolve to their user and can be destroyed', () => {
  const token = createSession('operador');
  assert.equal(resolveSession(token)?.user, 'operador');

  destroySession(token);
  assert.equal(resolveSession(token), undefined);
});

test('unknown tokens never resolve', () => {
  assert.equal(resolveSession('token-inventado'), undefined);
  assert.equal(resolveSession(''), undefined);
  assert.equal(resolveSession(undefined), undefined);
});
