'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  loadState,
  recordCall,
  recordTestAndCheckNoProgress,
} = require('../scripts/lib/agent-state');

const FAILING_OUTPUT = `
FAIL tests/payment.test.ts
AssertionError: expected 400 to equal 200
`;

test('no-progress requires the same failing test to survive real edits', () => {
  const state = loadState(`test-${Date.now()}-with-edits`);

  recordCall(state, 'Bash', { command: 'npm test' });
  assert.equal(recordTestAndCheckNoProgress(state, 'npm test', FAILING_OUTPUT, 3), null);

  recordCall(state, 'Edit', { file_path: 'src/payment.ts' });
  recordCall(state, 'Bash', { command: 'npm test' });
  assert.equal(recordTestAndCheckNoProgress(state, 'npm test', FAILING_OUTPUT, 3), null);

  recordCall(state, 'Edit', { file_path: 'src/payment.ts' });
  recordCall(state, 'Bash', { command: 'npm test' });
  const finding = recordTestAndCheckNoProgress(state, 'npm test', FAILING_OUTPUT, 3);

  assert.ok(finding);
  assert.equal(finding.consecutiveFailures, 3);
  assert.equal(finding.editCountDelta, 2);
  assert.deepEqual(finding.editedPaths, ['src/payment.ts']);
});

test('re-running the same failing test without edits is not no-progress', () => {
  const state = loadState(`test-${Date.now()}-no-edits`);

  for (let i = 0; i < 3; i += 1) {
    recordCall(state, 'Bash', { command: 'npm test' });
    assert.equal(recordTestAndCheckNoProgress(state, 'npm test', FAILING_OUTPUT, 3), null);
  }
});

test('a changed failure signature is treated as new information', () => {
  const state = loadState(`test-${Date.now()}-changed-failure`);

  recordCall(state, 'Bash', { command: 'npm test' });
  assert.equal(recordTestAndCheckNoProgress(state, 'npm test', FAILING_OUTPUT, 3), null);

  recordCall(state, 'Edit', { file_path: 'src/payment.ts' });
  recordCall(state, 'Bash', { command: 'npm test' });
  assert.equal(recordTestAndCheckNoProgress(state, 'npm test', 'FAIL other.test.ts\nAssertionError: timeout', 3), null);

  recordCall(state, 'Edit', { file_path: 'src/payment.ts' });
  recordCall(state, 'Bash', { command: 'npm test' });
  assert.equal(recordTestAndCheckNoProgress(state, 'npm test', FAILING_OUTPUT, 3), null);
});
