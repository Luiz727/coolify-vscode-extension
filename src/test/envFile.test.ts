import * as assert from 'assert';
import { parseEnvFile } from '../utils/envFile';

suite('envFile Tests', () => {
  test('parses basic key value pairs', () => {
    const parsed = parseEnvFile('API_URL=https://api.example.com\nPORT=3000');

    assert.strictEqual(parsed.length, 2);
    assert.strictEqual(parsed[0].key, 'API_URL');
    assert.strictEqual(parsed[0].value, 'https://api.example.com');
    assert.strictEqual(parsed[1].key, 'PORT');
    assert.strictEqual(parsed[1].value, '3000');
  });

  test('supports export syntax and inline comments', () => {
    const parsed = parseEnvFile('export TOKEN=abc123 # comment');

    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].key, 'TOKEN');
    assert.strictEqual(parsed[0].value, 'abc123');
  });

  test('parses quoted values and escaped characters', () => {
    const parsed = parseEnvFile('GREETING="hello\\nworld"\nRAW=\'ok\'');

    assert.strictEqual(parsed.length, 2);
    assert.strictEqual(parsed[0].value, 'hello\nworld');
    assert.strictEqual(parsed[1].value, 'ok');
  });

  test('ignores invalid lines', () => {
    const parsed = parseEnvFile('# comment\nINVALID\n1KEY=value\nVALID=value');

    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].key, 'VALID');
  });
});
