import test from 'node:test';
import assert from 'node:assert/strict';

import { parseResourceStatus, statusBucket, STATUS_ORDER } from '../status.js';

/**
 * These assertions must stay identical to src/test/resourceStatus.test.ts.
 * The web console and the VS Code extension disagreeing about whether a
 * resource is healthy is exactly the bug this taxonomy exists to prevent.
 */
test('running:unhealthy is degraded, never running', () => {
  const parsed = parseResourceStatus('running:unhealthy');
  assert.equal(parsed.container, 'running');
  assert.equal(parsed.health, 'unhealthy');
  assert.equal(parsed.bucket, 'degraded');
});

test('running:healthy is running', () => {
  assert.equal(statusBucket('running:healthy'), 'running');
});

test('bare "unhealthy" is not misread as healthy', () => {
  assert.equal(parseResourceStatus('unhealthy').health, 'unhealthy');
});

test('states that used to fall into unknown are classified', () => {
  assert.equal(statusBucket('restarting'), 'starting');
  assert.equal(statusBucket('degraded'), 'degraded');
  assert.equal(statusBucket('paused'), 'stopped');
  assert.equal(statusBucket('dead'), 'error');
  assert.equal(statusBucket('created'), 'starting');
  assert.equal(statusBucket('exited'), 'stopped');
});

test('empty and unknown statuses degrade to unknown', () => {
  assert.equal(statusBucket(''), 'unknown');
  assert.equal(statusBucket(undefined), 'unknown');
  assert.equal(statusBucket('coisa-estranha'), 'unknown');
});

test('ordering puts problems before healthy resources', () => {
  assert.ok(STATUS_ORDER.error < STATUS_ORDER.degraded);
  assert.ok(STATUS_ORDER.degraded < STATUS_ORDER.stopped);
  assert.ok(STATUS_ORDER.stopped < STATUS_ORDER.running);
  assert.ok(STATUS_ORDER.unknown < STATUS_ORDER.running);
});
