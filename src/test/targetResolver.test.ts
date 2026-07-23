import * as assert from 'assert';
import {
  TargetResolutionError,
  resolveTarget,
} from '../utils/targetResolver';

const APPS = [
  { uuid: 'uuid-prod', name: 'api-prod' },
  { uuid: 'uuid-staging', name: 'api-staging' },
  { uuid: 'uuid-site', name: 'site' },
];

const WRITE = { entityLabel: 'aplicação', allowSingleFallback: false };
const READ = { entityLabel: 'aplicação', allowSingleFallback: true };

suite('Target resolution', () => {
  test('resolves by exact id', () => {
    assert.strictEqual(
      resolveTarget(APPS, 'uuid-prod', undefined, WRITE).name,
      'api-prod'
    );
  });

  /**
   * An id that does not exist used to fall through to name matching and then to
   * "the only application", so a typo could act on an unrelated resource.
   */
  test('unknown id fails instead of falling back', () => {
    assert.throws(
      () => resolveTarget(APPS, 'uuid-inexistente', 'api-prod', WRITE),
      (error: unknown) => {
        assert.ok(error instanceof TargetResolutionError);
        assert.match(error.message, /nao existe/);
        return true;
      }
    );
  });

  test('resolves by exact name', () => {
    assert.strictEqual(
      resolveTarget(APPS, undefined, 'site', WRITE).uuid,
      'uuid-site'
    );
  });

  test('name matching ignores accents and case', () => {
    const accented = [{ uuid: 'u1', name: 'Aplicação-Príncipal' }];
    assert.strictEqual(
      resolveTarget(accented, undefined, 'aplicacao-principal', WRITE).uuid,
      'u1'
    );
  });

  /**
   * The dangerous case: "api" matches both api-prod and api-staging. Silently
   * picking the first one could stop production instead of staging.
   */
  test('ambiguous partial match is rejected and lists candidates', () => {
    assert.throws(
      () => resolveTarget(APPS, undefined, 'api', WRITE),
      (error: unknown) => {
        assert.ok(error instanceof TargetResolutionError);
        assert.match(error.message, /corresponde a 2/);
        assert.strictEqual(error.candidates.length, 2);
        return true;
      }
    );
  });

  test('unambiguous partial match is accepted', () => {
    assert.strictEqual(
      resolveTarget(APPS, undefined, 'prod', WRITE).uuid,
      'uuid-prod'
    );
  });

  test('write with no target is rejected even when only one resource exists', () => {
    const single = [{ uuid: 'only', name: 'unica-app' }];
    assert.throws(
      () => resolveTarget(single, undefined, undefined, WRITE),
      (error: unknown) => {
        assert.ok(error instanceof TargetResolutionError);
        assert.match(error.message, /nao assumem um alvo padrao/);
        return true;
      }
    );
  });

  test('read with no target may use the single resource', () => {
    const single = [{ uuid: 'only', name: 'unica-app' }];
    assert.strictEqual(
      resolveTarget(single, undefined, undefined, READ).uuid,
      'only'
    );
  });

  test('read with no target and several resources still asks for a target', () => {
    assert.throws(() => resolveTarget(APPS, undefined, undefined, READ));
  });

  test('empty collection reports nothing found', () => {
    assert.throws(
      () => resolveTarget([], undefined, 'api', READ),
      (error: unknown) => {
        assert.ok(error instanceof TargetResolutionError);
        assert.match(error.message, /Nenhum/);
        return true;
      }
    );
  });
});
