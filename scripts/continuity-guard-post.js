'use strict';

// PostCompact hook: Fires after Claude Code compacts the context window.
// Injects any lost architectural constraints, decisions, and negative rules
// back into the active context so Claude retains full continuity.

const fs = require('fs');
const path = require('path');
const os = require('os');

function getCapsuleDir() {
  return path.join(os.homedir(), '.claude', 'contextguard-capsules');
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    return;
  }

  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const sessionId = input.session_id || 'default_session';
  const capsulePath = path.join(getCapsuleDir(), `${sessionId}.json`);

  if (!fs.existsSync(capsulePath)) {
    return;
  }

  let capsule;
  try {
    capsule = JSON.parse(fs.readFileSync(capsulePath, 'utf8'));
  } catch {
    return;
  }

  if (!capsule.constraints || capsule.constraints.length === 0) {
    return;
  }

  const restorationText =
    `[ContextGuard Continuity Guard]: Critical constraints preserved from pre-compact session:\n` +
    capsule.constraints.map((c) => `- ${c}`).join('\n');

  const output = {
    systemMessage: `🛡️ ContextGuard: Restored ${capsule.constraints.length} architectural constraints after /compact.`,
    hookSpecificOutput: {
      additionalContext: restorationText,
    },
  };

  process.stdout.write(JSON.stringify(output));
}

main();
