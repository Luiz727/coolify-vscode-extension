/**
 * Pure geometry for the metric sparklines.
 *
 * Kept out of the component so the path math can be tested: an off-by-one in
 * the x-step or an unclamped value silently produces a chart that renders but
 * lies, which no type checker would catch.
 */

export const CHART_WIDTH = 100;

/**
 * Builds the line and area paths for a single series.
 *
 * @param points  [{ t, v }] in chronological order
 * @param options.max     ceiling for the y axis; null = auto-scale to the data
 * @param options.height  viewBox height in user units
 * @returns { line, area } or null when there is not enough data to draw
 */
export function buildSparklinePath(points, { max = null, height = 64 } = {}) {
  if (!Array.isArray(points)) {
    return null;
  }

  const usable = points.filter((point) => {
    if (!point) {
      return false;
    }
    // Number(null) and Number('') are both 0 and pass isFinite, so a gap in
    // collection would be drawn as a real drop to zero. Reject them by type.
    if (point.v === null || point.v === undefined || point.v === '') {
      return false;
    }
    return Number.isFinite(Number(point.v));
  });

  // A single point is not a line; drawing it would imply a trend we do not have.
  if (usable.length < 2) {
    return null;
  }

  const values = usable.map((point) => Number(point.v));
  const ceiling = max ?? Math.max(...values, 1);
  const safeCeiling = ceiling > 0 ? ceiling : 1;
  const stepX = CHART_WIDTH / (usable.length - 1);

  const coordinates = usable.map((point, index) => {
    const ratio = Math.min(Math.max(Number(point.v) / safeCeiling, 0), 1);
    return {
      x: Number((index * stepX).toFixed(2)),
      // SVG y grows downward: a full-scale value sits at y = 0.
      y: Number((height - ratio * height).toFixed(2)),
    };
  });

  const line = coordinates
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`)
    .join(' ');

  const area = `${line} L${CHART_WIDTH},${height} L0,${height} Z`;

  return { line, area, coordinates };
}
