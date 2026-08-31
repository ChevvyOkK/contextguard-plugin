'use strict';

// Per-session scratch state for the agent-loop detector:
// ~/.claude/contextguard/agent-state/<session_id>.json.
//
// Keeps just enough history to answer four questions about the *current*
// session — never anything from another session, never anything sent
// anywhere. Deleted state (a missing/corrupt file) just means detection
// restarts from zero for that session; never a reason to fail the hook.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.homedir(), '.claude', 'contextguard', 'agent-state');

// Bounds on what's kept, so a very long session's state file doesn't grow
// without limit — only recent history is relevant to "is this stuck right
// now", not the session's entire past.
const RECENT_CALLS_KEPT = 16;
const EDIT_HASHES_KEPT_PER_PATH = 10;

function statePath(sessionId) {
  // session_id is a UUID from Claude Code, not user input, but treating it
  // as an opaque token rather than trusting it to be filesystem-safe costs
  // nothing.
  const safe = String(sessionId).replace(/[^a-zA-Z0-9-]/g, '_');
  return path.join(STATE_DIR, `${safe}.json`);
}

function defaultState() {
  return {
    recentCalls: [],
    readCounts: {},
    editHashes: {},
    toolCallCount: 0,
    lastBudgetCheckAtCall: 0,
    lastKnownCostUsd: 0,
    editCount: 0,
    editedPaths: {},
    warnedReread: {},
    warnedRevert: {},
    warnedBudget: false,
    testFailureHistory: [],
    warnedTestNoProgress: {},
  };
}

function loadState(sessionId) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8'));
    return { ...defaultState(), ...raw };
  } catch {
    return defaultState();
  }
}

function saveState(sessionId, state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(statePath(sessionId), JSON.stringify(state));
  } catch {
    // Best-effort, same rule as savings-log.js: a failed write here must
    // never turn into a broken tool call.
  }
}

/// A stable string identifying "this kind of call to this target" — two
/// calls with the same fingerprint are what "repeated" means. Keyed on the
/// tool's actual target where there is one (a path, a command, a pattern)
/// rather than the whole input object, so two Edits to the same file with
/// different content still count as "the same call" for loop-detection
/// purposes — which is exactly the case a stuck agent produces.
function fingerprint(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  switch (toolName) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return `${toolName}:${input.file_path || ''}`;
    case 'Bash':
      return `Bash:${(input.command || '').trim()}`;
    case 'Grep':
      return `Grep:${input.pattern || ''}:${input.path || ''}`;
    case 'Glob':
      return `Glob:${input.pattern || ''}`;
    default: {
      // Any other tool (including MCP tools): a stable digest of the whole
      // input, sorted keys so equivalent objects hash the same regardless
      // of property order.
      const sorted = JSON.stringify(input, Object.keys(input).sort());
      return `${toolName}:${crypto.createHash('sha1').update(sorted).digest('hex').slice(0, 12)}`;
    }
  }
}

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/// Appends the current call to the rolling history and updates the
/// path-keyed counters. Pure aside from the bounded-array trimming — the
/// caller is responsible for persisting the result.
function recordCall(state, toolName, toolInput) {
  const fp = fingerprint(toolName, toolInput);
  state.recentCalls.push(fp);
  if (state.recentCalls.length > RECENT_CALLS_KEPT) {
    state.recentCalls.shift();
  }
  state.toolCallCount += 1;

  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (toolName === 'Read' && input.file_path) {
    state.readCounts[input.file_path] = (state.readCounts[input.file_path] || 0) + 1;
  }
  if ((toolName === 'Edit' || toolName === 'Write') && input.file_path) {
    state.editCount += 1;
    state.editedPaths[input.file_path] = (state.editedPaths[input.file_path] || 0) + 1;
  }

  return fp;
}

/// True when the last `threshold` recorded calls are all identical — an
/// agent making the exact same call over and over, the clearest "stuck"
/// signature there is.
function isRepeating(state, threshold) {
  if (state.recentCalls.length < threshold) return false;
  const tail = state.recentCalls.slice(-threshold);
  return tail.every((c) => c === tail[0]);
}

/// True the *first* time a path's read count exceeds the threshold — the
/// caller marks `warnedReread[path]` so a session that keeps reading the
/// same file doesn't get re-warned on every subsequent read past it.
function rereadExceeded(state, path_, threshold) {
  return (state.readCounts[path_] || 0) > threshold && !state.warnedReread[path_];
}

/// Records the content hash of a file just written by Edit/Write, and
/// reports whether that content matches an *earlier* version of the same
/// file — not simply "identical to last time" (saving the same thing twice
/// in a row can be entirely legitimate), but reverted to a state seen two
/// or more edits back, which is what an edit-undo-redo loop looks like.
function recordEditAndCheckRevert(state, filePath, content) {
  const hash = sha1(content);
  const history = state.editHashes[filePath] || [];

  // Anything before the immediately-previous entry counts as "earlier" —
  // matching only the last one would flag a legitimate no-op re-save.
  const isRevert = history.slice(0, -1).includes(hash) && !state.warnedRevert[filePath];

  history.push(hash);
  if (history.length > EDIT_HASHES_KEPT_PER_PATH) {
    history.shift();
  }
  state.editHashes[filePath] = history;

  return isRevert;
}

const TEST_COMMAND_PATTERN = /(?:npm\s+test|pytest|cargo\s+test|vitest|jest|go\s+test|mvn\s+test|gradle\s+test|python\s+-m\s+unittest)/i;
const TEST_FAILURE_PATTERN = /(?:FAIL|FAILED|AssertionError|ERR!|error\[E\d+\]|test\s+result:\s+FAILED)/i;

/**
 * Detects whether a test run produced a failure, records its signature,
 * and alerts if the same test failure has occurred 3+ times in a row despite code edits.
 */
function recordTestAndCheckNoProgress(state, command, output, threshold = 3) {
  if (!command || !TEST_COMMAND_PATTERN.test(command)) {
    return null;
  }

  const text = typeof output === 'string' ? output : JSON.stringify(output || '');
  const isFailure = TEST_FAILURE_PATTERN.test(text);

  if (!isFailure) {
    // Tests passed! Reset failure streak for this test command
    state.testFailureHistory = [];
    return null;
  }

  // Extract a signature from the failure (first 3 matching failure lines)
  const failureLines = text
    .split('\n')
    .filter(l => TEST_FAILURE_PATTERN.test(l))
    .slice(0, 3)
    .map(l => l.trim().slice(0, 80));

  const sig = failureLines.join(' | ') || 'generic_test_failure';
  const sigHash = sha1(sig).slice(0, 8);

  state.testFailureHistory.push({
    cmd: command.slice(0, 40),
    sigHash,
    sig,
    callIndex: state.toolCallCount,
    editCount: state.editCount,
  });

  if (state.testFailureHistory.length > 10) {
    state.testFailureHistory.shift();
  }

  const recent = state.testFailureHistory.slice(-threshold);
  if (recent.length >= threshold && recent.every(r => r.sigHash === sigHash)) {
    const first = recent[0];
    const editCountDelta = state.editCount - first.editCount;
    if (editCountDelta < threshold - 1) {
      return null;
    }
    if (!state.warnedTestNoProgress[sigHash]) {
      state.warnedTestNoProgress[sigHash] = true;
      return {
        consecutiveFailures: recent.length,
        signature: sig,
        command: command.slice(0, 120),
        editCountDelta,
        editedPaths: Object.keys(state.editedPaths).slice(-10),
      };
    }
  }

  return null;
}

module.exports = {
  loadState,
  saveState,
  fingerprint,
  recordCall,
  isRepeating,
  rereadExceeded,
  recordEditAndCheckRevert,
  recordTestAndCheckNoProgress,
  RECENT_CALLS_KEPT,
};
