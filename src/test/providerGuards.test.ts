import * as assert from 'assert';
import {
  isNonEmptyString,
  isValidCoolifyApplication,
  isValidCoolifyDeployment,
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
});
