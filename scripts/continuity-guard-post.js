'use strict';

// PostCompact hook: Fires after Claude Code compacts the context window.
// Injects any lost architectural constraints, decisions, and negative rules
// back into the active context so Claude retains full continuity.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { appendEvidenceEvent } = require('./lib/evidence-ledger');

function getCapsuleDir() {
  return path.join(os.homedir(), '.claude', 'contextguard', 'continuity-capsules');
}

function safeSessionId(sessionId) {
  return String(sessionId || 'default_session').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96);
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

  const sessionId = safeSessionId(input.session_id);
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

  const eventId = appendEvidenceEvent({
    project: input.cwd || capsule.cwd || null,
    sessionId,
    type: 'CONTEXT_RESTORED',
    severity: 'info',
    confidence: 'high',
    evidence: capsule.constraints.map((constraint) => `restored: ${constraint}`),
    action: 'restored_after_compact',
    exactImpact: {
      constraintsRestored: capsule.constraints.length,
    },
    sourceData: {
      detector: 'post_compact_capsule_restore',
      capsulePath,
    },
    localReferences: {
      capsulePath,
    },
  });

  const output = {
    systemMessage:
      `ContextGuard: Restored ${capsule.constraints.length} architectural constraints after /compact.` +
      (eventId ? ` Evidence: ${eventId}.` : ''),
    hookSpecificOutput: {
      additionalContext: restorationText,
    },
  };

  process.stdout.write(JSON.stringify(output));
}

main();
