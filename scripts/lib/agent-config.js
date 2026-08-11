'use strict';

// Local config for the agent-loop detector: ~/.claude/contextguard/config.json.
//
//   {
//     "agentLoop": {
//       "enabled": true,
//       "reaction": "warn",        // "warn" | "notify" | "hard-stop"
//       "repeatThreshold": 4,
//       "rereadThreshold": 5,
//       "sessionBudgetUsd": null,  // opt-in — no invented default threshold
//       "webhookUrl": null
//     }
//   }
//
// Every field is optional; a missing or unreadable file falls back to
// defaults rather than erroring — a malformed config must never turn into a
// broken hook, the same rule savings-log.js follows for its own writes.
// `reaction` defaults to "warn", which by construction can never block a
// tool call (see detect-agent-loop-post.js) — "notify" and "hard-stop" are
// both explicit opt-in, never silently upgraded to.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH = path.join(os.homedir(), '.claude', 'contextguard', 'config.json');

const DEFAULTS = {
  enabled: true,
  reaction: 'warn',
  repeatThreshold: 4,
  rereadThreshold: 5,
  sessionBudgetUsd: null,
  webhookUrl: null,
};

const VALID_REACTIONS = new Set(['warn', 'notify', 'hard-stop']);

function loadAgentLoopConfig() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { ...DEFAULTS };
  }

  const section = raw && typeof raw === 'object' ? raw.agentLoop : null;
  if (!section || typeof section !== 'object') {
    return { ...DEFAULTS };
  }

  return {
    enabled: typeof section.enabled === 'boolean' ? section.enabled : DEFAULTS.enabled,
    reaction: VALID_REACTIONS.has(section.reaction) ? section.reaction : DEFAULTS.reaction,
    repeatThreshold: Number.isInteger(section.repeatThreshold) && section.repeatThreshold >= 2 ? section.repeatThreshold : DEFAULTS.repeatThreshold,
    rereadThreshold: Number.isInteger(section.rereadThreshold) && section.rereadThreshold >= 2 ? section.rereadThreshold : DEFAULTS.rereadThreshold,
    sessionBudgetUsd: typeof section.sessionBudgetUsd === 'number' && section.sessionBudgetUsd > 0 ? section.sessionBudgetUsd : null,
    webhookUrl: typeof section.webhookUrl === 'string' && section.webhookUrl.length > 0 ? section.webhookUrl : null,
  };
}

module.exports = { loadAgentLoopConfig, CONFIG_PATH, DEFAULTS };
