import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertActionAllowed,
  clampPaging,
  ensureApiBase,
  normalizeDeploymentLogs,
  normalizeResource,
} from '../coolify.js';
import { evaluateAlerts, correlateServersToVms } from '../hostinger.js';

test('api base is normalised from any reasonable input', () => {
  assert.equal(ensureApiBase('https://c.example.com'), 'https://c.example.com/api/v1');
  assert.equal(ensureApiBase('https://c.example.com/'), 'https://c.example.com/api/v1');
  assert.equal(ensureApiBase('https://c.example.com/api'), 'https://c.example.com/api/v1');
  assert.equal(ensureApiBase('https://c.example.com/api/v1'), 'https://c.example.com/api/v1');
});

/**
 * take=abc used to become NaN and travel into the upstream URL.
 * A huge take used to pass straight through to the VPS.
 */
test('paging clamps invalid, negative and oversized values', () => {
  assert.deepEqual(clampPaging('abc', 'abc'), { skip: 0, take: 20 });
  assert.deepEqual(clampPaging(-10, 0), { skip: 0, take: 1 });
  assert.deepEqual(clampPaging(5, 999999), { skip: 5, take: 100 });
  assert.deepEqual(clampPaging(undefined, undefined), { skip: 0, take: 20 });
  assert.deepEqual(clampPaging('3', '7'), { skip: 3, take: 7 });
});

test('only documented actions are accepted per resource type', () => {
  assert.equal(assertActionAllowed('application', 'deploy'), 'applications');
  assert.equal(assertActionAllowed('service', 'restart'), 'services');
  assert.equal(assertActionAllowed('database', 'stop'), 'databases');

  // Deploy exists only for applications.
  assert.throws(() => assertActionAllowed('database', 'deploy'));
  assert.throws(() => assertActionAllowed('service', 'deploy'));
  assert.throws(() => assertActionAllowed('inexistente', 'start'));
  assert.throws(() => assertActionAllowed('application', 'drop'));
});

test('resources carry the health-aware bucket', () => {
  const resource = normalizeResource(
    { uuid: 'u1', name: 'api', status: 'running:unhealthy' },
    'application',
    new Map()
  );

  assert.equal(resource.statusBucket, 'degraded');
  assert.equal(resource.healthStatus, 'unhealthy');
});

test('project index enriches resources with project and environment', () => {
  const index = new Map([['u1', { project: 'Loja', environment: 'production' }]]);
  const resource = normalizeResource(
    { uuid: 'u1', name: 'api', status: 'running:healthy' },
    'application',
    index
  );

  assert.equal(resource.project, 'Loja');
  assert.equal(resource.environment, 'production');
});

test('JSON-encoded deployment logs are decoded in order', () => {
  const raw = JSON.stringify([
    { output: 'b', order: 2 },
    { output: 'a', order: 1 },
  ]);
  assert.equal(normalizeDeploymentLogs(raw), 'a\nb');
  assert.equal(normalizeDeploymentLogs('texto puro'), 'texto puro');
  assert.equal(normalizeDeploymentLogs(''), '');
});

/** Alerts must not flash on a single spike. */
test('alerts require consecutive breaches (hysteresis)', () => {
  const thresholds = { cpuPct: 85, ramPct: 90, diskPct: 85, consecutiveSamples: 2 };
  const metrics = { cpuPct: 95, ramPct: 10, diskPct: 10 };

  const first = evaluateAlerts(metrics, thresholds, {});
  assert.equal(first.alerts.length, 0, 'uma leitura isolada nao alerta');

  const second = evaluateAlerts(metrics, thresholds, first.breaches);
  assert.equal(second.alerts.length, 1);
  assert.equal(second.alerts[0].metric, 'cpu');

  // Recovering resets the counter.
  const recovered = evaluateAlerts({ cpuPct: 10, ramPct: 10, diskPct: 10 }, thresholds, second.breaches);
  assert.equal(recovered.alerts.length, 0);
  assert.equal(recovered.breaches.cpu, 0);
});

test('missing metrics never raise alerts', () => {
  const thresholds = { cpuPct: 85, ramPct: 90, diskPct: 85, consecutiveSamples: 1 };
  const result = evaluateAlerts({ cpuPct: null, ramPct: null, diskPct: null }, thresholds, {});
  assert.equal(result.alerts.length, 0);
});

/** The join that turns two dashboards into one diagnosis. */
test('coolify servers correlate to hostinger VMs by IP', () => {
  const servers = [
    { uuid: 's1', name: 'srv-01', ip: '10.0.0.1' },
    { uuid: 's2', name: 'srv-02', ip: '10.0.0.9' },
  ];
  const vms = [
    { id: 'vm-1', hostname: 'host-a', ipv4: '10.0.0.1' },
    { id: 'vm-2', hostname: 'host-b', ipv4: '10.0.0.2' },
  ];

  const links = correlateServersToVms(servers, vms);

  assert.equal(links[0].vmId, 'vm-1');
  assert.equal(links[0].linkSource, 'ip-match');
  assert.equal(links[1].vmId, null);
  assert.equal(links[1].linkSource, 'unlinked');
});

test('manual links win over IP matching', () => {
  const servers = [{ uuid: 's1', name: 'srv-01', ip: '10.0.0.1' }];
  const vms = [
    { id: 'vm-1', hostname: 'host-a', ipv4: '10.0.0.1' },
    { id: 'vm-9', hostname: 'host-z', ipv4: '172.16.0.1' },
  ];

  const links = correlateServersToVms(servers, vms, { s1: 'vm-9' });
  assert.equal(links[0].vmId, 'vm-9');
  assert.equal(links[0].linkSource, 'manual');
});
