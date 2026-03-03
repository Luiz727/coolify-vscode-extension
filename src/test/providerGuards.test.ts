import * as assert from 'assert';
import {
  isValidApplicationLifecycleResponse,
  isValidEnvironmentVariable,
  isNonEmptyString,
  isValidCoolifyApplication,
  isValidCoolifyDeployment,
  parseArrayPayload,
  parseObjectPayload,
} from '../utils/payloadGuards.js';

suite('Provider Runtime Guards', () => {
  test('application guard accepts minimal valid shape and rejects invalid', () => {
    assert.strictEqual(
      isValidCoolifyApplication({
        uuid: 'app-1',
        name: 'My App',
        status: 'running',
      }),
      true
    );

    assert.strictEqual(
      isValidCoolifyApplication({
        uuid: '',
        name: 'My App',
        status: 'running',
      }),
      false
    );

    assert.strictEqual(isValidCoolifyApplication(null), false);
  });

  test('deployment guard accepts minimal valid shape and rejects invalid', () => {
    assert.strictEqual(
      isValidCoolifyDeployment({
        id: 'dep-1',
        application_id: 'app-1',
        application_name: 'My App',
        status: 'queued',
      }),
      true
    );

    assert.strictEqual(
      isValidCoolifyDeployment({
        id: 'dep-1',
        application_id: '',
        application_name: 'My App',
        status: 'queued',
      }),
      false
    );

    assert.strictEqual(isValidCoolifyDeployment(undefined), false);
  });

  test('non empty string helper works for common edge cases', () => {
    assert.strictEqual(isNonEmptyString('abc'), true);
    assert.strictEqual(isNonEmptyString('   '), false);
    assert.strictEqual(isNonEmptyString(123), false);
  });

  test('environment variable guard validates required fields', () => {
    assert.strictEqual(
      isValidEnvironmentVariable({
        uuid: 'env-1',
        key: 'API_KEY',
        value: 'secret',
      }),
      true
    );

    assert.strictEqual(
      isValidEnvironmentVariable({
        uuid: 'env-1',
        key: '',
        value: 'secret',
      }),
      false
    );
  });

  test('application lifecycle response guard validates optional shape', () => {
    assert.strictEqual(
      isValidApplicationLifecycleResponse({ message: 'ok', deployment_uuid: 'dep-1' }),
      true
    );

    assert.strictEqual(
      isValidApplicationLifecycleResponse({ message: 123 }),
      false
    );
  });

  test('parseArrayPayload filters invalid items and reports invalid count', () => {
    const result = parseArrayPayload(
      [
        { uuid: 'app-1', name: 'App 1', status: 'running' },
        { uuid: '', name: 'Invalid', status: 'running' },
      ],
      isValidCoolifyApplication,
      'applications'
    );

    assert.strictEqual(result.items.length, 1);
    assert.strictEqual(result.invalidCount, 1);
  });

  test('parseArrayPayload throws for non-array payload', () => {
    assert.throws(() => {
      parseArrayPayload(
        { not: 'array' },
        isValidCoolifyApplication,
        'applications'
      );
    });
  });

  test('parseObjectPayload validates single object shape', () => {
    const payload = {
      id: 'dep-1',
      application_id: 'app-1',
      application_name: 'App 1',
      status: 'queued',
    };

    const parsed = parseObjectPayload(
      payload,
      isValidCoolifyDeployment,
      'deployment'
    );

    assert.strictEqual(parsed.id, 'dep-1');
  });
});
