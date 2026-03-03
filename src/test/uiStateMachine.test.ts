import * as assert from 'assert';
import { isUiStateTransitionAllowed } from '../utils/uiStateMachine';

suite('uiStateMachine Tests', () => {
  test('allows valid transitions', () => {
    assert.strictEqual(isUiStateTransitionAllowed('unconfigured', 'loading'), true);
    assert.strictEqual(isUiStateTransitionAllowed('loading', 'ready'), true);
    assert.strictEqual(isUiStateTransitionAllowed('loading', 'error'), true);
    assert.strictEqual(isUiStateTransitionAllowed('ready', 'loading'), true);
    assert.strictEqual(isUiStateTransitionAllowed('error', 'loading'), true);
  });

  test('rejects invalid transitions', () => {
    assert.strictEqual(isUiStateTransitionAllowed('unconfigured', 'ready'), false);
    assert.strictEqual(isUiStateTransitionAllowed('ready', 'ready'), true);
    assert.strictEqual(isUiStateTransitionAllowed('error', 'ready'), false);
  });
});
