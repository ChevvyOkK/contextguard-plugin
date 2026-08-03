'use strict';

// PreToolUse hook for Grep. If the caller didn't set an explicit head_limit,
// an unbounded content search against a large repo can return thousands of
// matched lines. We cap it to a sane default — never overriding a limit the
// caller actually chose, only filling in the gap when there isn't one.
//
// Unlike the Bash truncation hook, we can't measure bytes actually saved
// here (the search hasn't run yet), so this only logs that an intervention
// happened — no invented token figure.

const { logSavings } = require('./lib/savings-log');

const DEFAULT_HEAD_LIMIT = 100;

function main() {
  let raw;
  try {
    raw = require('fs').readFileSync(0, 'utf8');
  } catch {
    return;
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const toolInput = input.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return;
  if (toolInput.head_limit !== undefined && toolInput.head_limit !== null) return;

  const updatedInput = { ...toolInput, head_limit: DEFAULT_HEAD_LIMIT };

  logSavings({
    hook: 'grep_cap',
    tool_name: input.tool_name || 'Grep',
    capped_to: DEFAULT_HEAD_LIMIT,
  });

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput,
    },
  }));
}

main();
