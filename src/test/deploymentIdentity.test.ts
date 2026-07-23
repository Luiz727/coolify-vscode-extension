import * as assert from 'assert';
import {
  deploymentIdCandidates,
  formatTimestamp,
  normalizeDeploymentLogs,
  resolveDeploymentId,
} from '../utils/deploymentIdentity';

suite('Deployment identity and logs', () => {
  /**
   * The Coolify API addresses deployments by UUID. Sending the numeric id to
   * /deployments/{uuid} or /deployments/{uuid}/cancel returns 404, which is why
   * cancelling a deployment silently failed.
   */
  test('prefers deployment_uuid over the numeric id', () => {
    assert.strictEqual(
      resolveDeploymentId({ id: 42, deployment_uuid: 'abc-uuid' }),
      'abc-uuid'
    );
  });

  test('falls back to the numeric id when no uuid exists', () => {
    assert.strictEqual(resolveDeploymentId({ id: 42 }), '42');
  });

  test('ignores blank uuids', () => {
    assert.strictEqual(resolveDeploymentId({ id: 7, deployment_uuid: '  ' }), '7');
  });

  test('returns empty string when nothing identifies the deployment', () => {
    assert.strictEqual(resolveDeploymentId({}), '');
  });

  test('candidates cover both identifiers for reverse lookups', () => {
    assert.deepStrictEqual(
      deploymentIdCandidates({ id: 42, deployment_uuid: 'abc' }),
      ['abc', '42']
    );
  });

  /** Coolify serialises deployment logs as a JSON array of entries. */
  test('decodes JSON-encoded logs into readable text', () => {
    const raw = JSON.stringify([
      { output: 'segunda linha', order: 2 },
      { output: 'primeira linha', order: 1 },
      { output: 'terceira linha', order: 3 },
    ]);

    assert.strictEqual(
      normalizeDeploymentLogs(raw),
      'primeira linha\nsegunda linha\nterceira linha'
    );
  });

  test('leaves plain-text logs untouched', () => {
    const plain = 'apenas texto\nem duas linhas';
    assert.strictEqual(normalizeDeploymentLogs(plain), plain);
  });

  test('handles empty and non-string logs', () => {
    assert.strictEqual(normalizeDeploymentLogs(''), '');
    assert.strictEqual(normalizeDeploymentLogs(undefined), '');
    assert.strictEqual(normalizeDeploymentLogs(null), '');
    assert.strictEqual(normalizeDeploymentLogs(123), '');
  });

  /** The UI used to render the literal string "Invalid Date". */
  test('invalid timestamps format to empty string', () => {
    assert.strictEqual(formatTimestamp('nao-e-data'), '');
    assert.strictEqual(formatTimestamp(''), '');
    assert.strictEqual(formatTimestamp(undefined), '');
    assert.notStrictEqual(formatTimestamp('2026-07-23T10:00:00Z'), '');
  });
});
