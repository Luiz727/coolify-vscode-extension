import * as assert from 'assert';
import {
  needsAttention,
  parseResourceStatus,
  statusBucket,
} from '../utils/resourceStatus';

suite('Resource status taxonomy', () => {
  /**
   * The business rule the whole console depends on: a container that is up but
   * failing its healthcheck is NOT healthy. Reporting it as running is what
   * made the web panel show green while the sidebar showed a problem.
   */
  test('running:unhealthy is degraded, never running', () => {
    const parsed = parseResourceStatus('running:unhealthy');
    assert.strictEqual(parsed.container, 'running');
    assert.strictEqual(parsed.health, 'unhealthy');
    assert.strictEqual(parsed.bucket, 'degraded');
    assert.strictEqual(needsAttention('running:unhealthy'), true);
  });

  test('running:healthy is running', () => {
    const parsed = parseResourceStatus('running:healthy');
    assert.strictEqual(parsed.bucket, 'running');
    assert.strictEqual(parsed.health, 'healthy');
    assert.strictEqual(needsAttention('running:healthy'), false);
  });

  /**
   * Guards the substring trap: "unhealthy".includes("healthy") is true, so
   * testing the positive case first classified unhealthy as healthy.
   */
  test('bare "unhealthy" is not misread as healthy', () => {
    assert.strictEqual(parseResourceStatus('unhealthy').health, 'unhealthy');
    assert.notStrictEqual(parseResourceStatus('unhealthy').health, 'healthy');
  });

  test('states previously bucketed as unknown are classified', () => {
    assert.strictEqual(statusBucket('restarting'), 'starting');
    assert.strictEqual(statusBucket('degraded'), 'degraded');
    assert.strictEqual(statusBucket('paused'), 'stopped');
    assert.strictEqual(statusBucket('dead'), 'error');
    assert.strictEqual(statusBucket('created'), 'starting');
    assert.strictEqual(statusBucket('removing'), 'stopped');
    assert.strictEqual(statusBucket('exited'), 'stopped');
    assert.strictEqual(statusBucket('exited:unhealthy'), 'stopped');
  });

  test('unparseable and empty statuses degrade to unknown', () => {
    assert.strictEqual(statusBucket(''), 'unknown');
    assert.strictEqual(statusBucket(undefined), 'unknown');
    assert.strictEqual(statusBucket(null), 'unknown');
    assert.strictEqual(statusBucket('algo-inesperado'), 'unknown');
  });

  test('error keywords are detected in free-form statuses', () => {
    assert.strictEqual(statusBucket('deploy failed'), 'error');
    assert.strictEqual(statusBucket('container crashed'), 'error');
    assert.strictEqual(needsAttention('deploy failed'), true);
  });

  test('parsing is case and whitespace insensitive', () => {
    assert.strictEqual(statusBucket('  RUNNING:UNHEALTHY  '), 'degraded');
    assert.strictEqual(statusBucket('Running:Healthy'), 'running');
  });
});
