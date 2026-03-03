import * as assert from 'assert';

import {
  sanitizeDisplayText,
  sanitizeDisplayTextOrFallback,
} from '../utils/displaySanitizer';

suite('displaySanitizer Tests', () => {
  test('sanitizeDisplayText removes control characters and trims', () => {
    assert.strictEqual(
      sanitizeDisplayText('  app\u0000-name\n\t  '),
      'app-name'
    );
  });

  test('sanitizeDisplayText returns empty for non-string values', () => {
    assert.strictEqual(sanitizeDisplayText(123), '');
    assert.strictEqual(sanitizeDisplayText(undefined), '');
  });

  test('sanitizeDisplayTextOrFallback returns fallback when empty', () => {
    assert.strictEqual(
      sanitizeDisplayTextOrFallback(' \u0000\n\t ', 'fallback'),
      'fallback'
    );
  });

  test('sanitizeDisplayTextOrFallback keeps valid sanitized value', () => {
    assert.strictEqual(
      sanitizeDisplayTextOrFallback('  my-app  ', 'fallback'),
      'my-app'
    );
  });
});
