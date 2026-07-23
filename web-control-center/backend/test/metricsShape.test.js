import test from 'node:test';
import assert from 'node:assert/strict';

import { flattenMetricSeries } from '../hostinger.js';
import { buildSparklinePath } from '../../frontend/src/chartGeometry.js';

/**
 * The panel consumes `/api/vps/:id/metrics` without caring whether the data
 * came from our history store or straight from the provider. When the two
 * sources disagreed on shape — an array of rows versus a map of per-metric
 * series — the panel called `.map()` on an object and crashed, and it crashed
 * precisely in the configuration where history is disabled.
 */
test('provider series flattens into the same row shape as the history store', () => {
  const providerSeries = {
    cpu: [
      { t: '2026-07-23T10:00:00Z', v: 10 },
      { t: '2026-07-23T10:01:00Z', v: 20 },
    ],
    ram: [
      { t: '2026-07-23T10:00:00Z', v: 50 },
      { t: '2026-07-23T10:01:00Z', v: 55 },
    ],
    disk: [{ t: '2026-07-23T10:01:00Z', v: 70 }],
    netIn: [],
    netOut: [],
  };

  const rows = flattenMetricSeries(providerSeries);

  assert.ok(Array.isArray(rows), 'precisa ser um array, como o historico devolve');
  assert.equal(rows.length, 2);

  assert.deepEqual(rows[0], { t: '2026-07-23T10:00:00Z', cpu: 10, ram: 50 });
  assert.deepEqual(rows[1], {
    t: '2026-07-23T10:01:00Z',
    cpu: 20,
    ram: 55,
    disk: 70,
  });
});

test('rows come out in chronological order regardless of input order', () => {
  const rows = flattenMetricSeries({
    cpu: [
      { t: '2026-07-23T12:00:00Z', v: 3 },
      { t: '2026-07-23T09:00:00Z', v: 1 },
    ],
  });

  assert.deepEqual(
    rows.map((row) => row.cpu),
    [1, 3]
  );
});

test('empty and malformed series degrade to an empty array, never to null', () => {
  assert.deepEqual(flattenMetricSeries(null), []);
  assert.deepEqual(flattenMetricSeries(undefined), []);
  assert.deepEqual(flattenMetricSeries({}), []);
  assert.deepEqual(flattenMetricSeries({ cpu: null }), []);
  // Points without a timestamp cannot be placed on a time axis.
  assert.deepEqual(flattenMetricSeries({ cpu: [{ v: 5 }] }), []);
});

/** End-to-end: the flattened rows must actually be drawable. */
test('flattened rows feed the chart without producing NaN', () => {
  const rows = flattenMetricSeries({
    cpu: [
      { t: '2026-07-23T10:00:00Z', v: 10 },
      { t: '2026-07-23T10:01:00Z', v: 90 },
    ],
  });

  const points = rows.map((row) => ({ t: row.t, v: row.cpu }));
  const path = buildSparklinePath(points, { max: 100, height: 64 });

  assert.ok(path, 'duas amostras precisam gerar um caminho');
  assert.ok(!path.line.includes('NaN'));
  assert.ok(!path.area.includes('NaN'));
});

/**
 * A metric missing from one sample must not be drawn as a drop to zero — the
 * gap is absence of data, not a reading of nothing.
 */
test('a metric absent from some rows leaves a gap instead of a false zero', () => {
  const rows = flattenMetricSeries({
    cpu: [
      { t: '2026-07-23T10:00:00Z', v: 40 },
      { t: '2026-07-23T10:02:00Z', v: 60 },
    ],
    ram: [
      { t: '2026-07-23T10:00:00Z', v: 30 },
      { t: '2026-07-23T10:01:00Z', v: 35 },
      { t: '2026-07-23T10:02:00Z', v: 40 },
    ],
  });

  assert.equal(rows.length, 3);
  assert.equal(rows[1].cpu, undefined, 'a linha do meio nao tem leitura de CPU');

  const cpuPath = buildSparklinePath(
    rows.map((row) => ({ t: row.t, v: row.cpu })),
    { max: 100, height: 64 }
  );

  assert.equal(cpuPath.coordinates.length, 2, 'a amostra ausente e descartada');
  assert.ok(cpuPath.coordinates.every((point) => point.y < 64));
});
