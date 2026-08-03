'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_DIR = path.join(os.homedir(), '.claude', 'contextguard');
const LOG_FILE = path.join(LOG_DIR, 'savings.jsonl');

// Rough chars-per-token estimate, same rule of thumb the CLI's CLAUDE.md
// analyzer uses — good enough to show a trend, not a billing figure.
function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

// Never let logging break the hook it's called from — a failed write here
// must not turn into a broken tool call for the user.
function logSavings(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    // best-effort only
  }
}

module.exports = { estimateTokens, logSavings, LOG_FILE };
