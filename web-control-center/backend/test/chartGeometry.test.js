import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSparklinePath, CHART_WIDTH } from '../../frontend/src/chartGeometry.js';

test('needs at least two points to draw a line', () => {
  assert.equal(buildSparklinePath([]), null);
  assert.equal(buildSparklinePath([{ t: 'a', v: 10 }]), null);
  assert.equal(buildSparklinePath(null), null);
});

test('non-numeric samples are discarded, not treated as zero', () => {
  // A gap in collection must not draw a phantom drop to the baseline.
  const path = buildSparklinePath(
    [
      { t: '1', v: 50 },
      { t: '2', v: null },
      { t: '3', v: 50 },
    ],
    { max: 100, height: 64 }
  );

  assert.equal(path.coordinates.length, 2);
  assert.ok(path.coordinates.every((point) => point.y === 32));
});

test('spans the full width and pins the endpoints', () => {
  const path = buildSparklinePath(
    [
      { t: '1', v: 0 },
      { t: '2', v: 50 },
      { t: '3', v: 100 },
    ],
    { max: 100, height: 64 }
  );

  assert.equal(path.coordinates[0].x, 0);
  assert.equal(path.coordinates[2].x, CHART_WIDTH);
  // SVG y grows downward: 0% sits on the baseline, 100% at the top.
  assert.equal(path.coordinates[0].y, 64);
  assert.equal(path.coordinates[1].y, 32);
  assert.equal(path.coordinates[2].y, 0);
});

test('values above the ceiling are clamped instead of overflowing', () => {
  const path = buildSparklinePath(
    [
      { t: '1', v: 50 },
      { t: '2', v: 250 },
    ],
    { max: 100, height: 64 }
  );

  assert.equal(path.coordinates[1].y, 0);
  assert.ok(path.coordinates.every((point) => point.y >= 0 && point.y <= 64));
});

test('negative values are clamped to the baseline', () => {
  const path = buildSparklinePath(
    [
      { t: '1', v: -20 },
      { t: '2', v: 10 },
    ],
    { max: 100, height: 64 }
  );

  assert.equal(path.coordinates[0].y, 64);
});

test('auto-scales when no ceiling is given', () => {
  const path = buildSparklinePath(
    [
      { t: '1', v: 2 },
      { t: '2', v: 8 },
    ],
    { max: null, height: 64 }
  );

  assert.equal(path.coordinates[1].y, 0, 'o maior valor toca o topo');
  assert.equal(path.coordinates[0].y, 48);
});

test('an all-zero series stays on the baseline instead of dividing by zero', () => {
  const path = buildSparklinePath(
    [
      { t: '1', v: 0 },
      { t: '2', v: 0 },
    ],
    { max: null, height: 64 }
  );

  assert.ok(path.coordinates.every((point) => point.y === 64));
  assert.ok(!path.line.includes('NaN'));
});

test('area path closes back to the baseline', () => {
  const path = buildSparklinePath(
    [
      { t: '1', v: 10 },
      { t: '2', v: 20 },
    ],
    { max: 100, height: 64 }
  );

  assert.ok(path.area.startsWith('M0,'));
  assert.ok(path.area.endsWith(`L${CHART_WIDTH},64 L0,64 Z`));
  assert.ok(!path.area.includes('NaN'));
});
