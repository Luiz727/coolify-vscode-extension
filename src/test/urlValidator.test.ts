import * as assert from 'assert';
import { isValidUrl, normalizeUrl } from '../utils/urlValidator';

suite('urlValidator Tests', () => {
  test('isValidUrl accepts hostname without protocol (defaults to https)', () => {
    assert.strictEqual(isValidUrl('coolify.example.com'), true);
  });

  test('isValidUrl validates localhost with port', () => {
    assert.strictEqual(isValidUrl('localhost:8000'), true);
  });

  test('isValidUrl rejects localhost without port', () => {
    assert.strictEqual(isValidUrl('http://localhost'), false);
  });

  test('normalizeUrl defaults to https and removes trailing slash', () => {
    assert.strictEqual(
      normalizeUrl('coolify.example.com/'),
      'https://coolify.example.com'
    );
  });
});
