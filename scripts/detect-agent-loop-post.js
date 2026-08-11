'use strict';

// PostToolUse hook, matcher "*" — fires after every tool call. Detects four
// signs of a stuck agent (repeated identical calls, re-reading the same file
// past a threshold, an edit that reverts a file to a state seen earlier, and
// session spend crossing an optional local budget) and surfaces a warning.
//
// Structurally cannot block: PostToolUse runs after the tool already
// executed. That's deliberate here, not just an API limitation — see
// detect-agent-loop-pre.js for the one case (and only that case) where this
// plugin will ever deny a call outright, and why the other three detectors
// stay warn/notify-only even when reaction is "hard-stop".
//
// Non-blocking warnings use two fields: top-level `systemMessage` (shown to
// the user) and `hookSpecificOutput.additionalContext` (visible to the model
// itself, so the agent can course-correct without the user having to paste
// the warning back in). Both are exit-code-0, non-blocking by construction.

const path = require('path');
const { loadAgentLoopConfig } = require('./lib/agent-config');
const {
  loadState,
  saveState,
  recordCall,
  isRepeating,
  rereadExceeded,
  recordEditAndCheckRevert,
} = require('./lib/agent-state');
const { costTranscriptSync } = require('./lib/transcript-cost');

// Re-checking the transcript on every single tool call would mean re-parsing
// a growing file dozens of times per session for no benefit — the budget
// verdict doesn't need to be more current than "checked every few calls".
const BUDGET_CHECK_EVERY_N_CALLS = 5;

function notifyWebhook(url, text) {
  try {
    // Fire-and-forget: a failed/slow webhook must never delay or fail the
    // hook itself. No await, no retry — same spirit as the CLI's
    // budget::notify_webhook, but here even delivery failure isn't worth
    // reporting back through the hook's own stdout.
    const https = url.startsWith('https:') ? require('https') : require('http');
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    req.on('error', () => {});
    req.end(JSON.stringify({ text }));
  } catch {
    // ignore
  }
}

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

  const config = loadAgentLoopConfig();
  if (!config.enabled) return;

  const sessionId = input.session_id;
  const toolName = input.tool_name;
  if (!sessionId || !toolName) return;

  const state = loadState(sessionId);
  const warnings = [];

  const fp = recordCall(state, toolName, input.tool_input);

  // 1. Repeated identical calls.
  if (isRepeating(state, config.repeatThreshold) && !state.warnedRepeatFor) {
    warnings.push(
      `contextguard: the last ${config.repeatThreshold} tool calls were identical (${fp}). ` +
      `This usually means the agent is stuck retrying the same thing without new information.`
    );
    state.warnedRepeatFor = fp;
  } else if (state.warnedRepeatFor && state.warnedRepeatFor !== fp) {
    // A different call broke the streak — allow a future repeat of the same
    // (or a different) fingerprint to warn again.
    state.warnedRepeatFor = null;
  }

  // 2. Re-reading the same file past the threshold.
  const readPath = toolName === 'Read' && input.tool_input ? input.tool_input.file_path : null;
  if (readPath && rereadExceeded(state, readPath, config.rereadThreshold)) {
    warnings.push(
      `contextguard: "${path.basename(readPath)}" has been read ${state.readCounts[readPath]} times this session. ` +
      `If its content isn't changing, re-reading it just re-spends context on something already in view.`
    );
    state.warnedReread[readPath] = true;
  }

  // 3. Edit/Write that reverts a file to a previously-seen state.
  if ((toolName === 'Edit' || toolName === 'Write') && input.tool_input && input.tool_input.file_path) {
    const filePath = input.tool_input.file_path;
    // Best-effort signal from the tool's own input/response — content isn't
    // guaranteed to be present on every response shape, so this detector
    // simply doesn't fire when it can't see the resulting text, rather than
    // guessing.
    const content =
      (typeof input.tool_input.content === 'string' && input.tool_input.content) ||
      (typeof input.tool_input.new_string === 'string' && input.tool_input.new_string) ||
      null;
    if (content !== null) {
      const reverted = recordEditAndCheckRevert(state, filePath, content);
      if (reverted) {
        warnings.push(
          `contextguard: "${path.basename(filePath)}" was just edited back to a state it was in earlier this session. ` +
          `That can mean the agent is oscillating between two versions instead of converging.`
        );
        state.warnedRevert[filePath] = true;
      }
    }
  }

  // 4. Session spend crossing an optional local budget.
  if (config.sessionBudgetUsd !== null && input.transcript_path) {
    const callsSinceLastCheck = state.toolCallCount - state.lastBudgetCheckAtCall;
    if (callsSinceLastCheck >= BUDGET_CHECK_EVERY_N_CALLS) {
      const { costUsd } = costTranscriptSync(input.transcript_path);
      state.lastKnownCostUsd = costUsd;
      state.lastBudgetCheckAtCall = state.toolCallCount;
      if (costUsd >= config.sessionBudgetUsd && !state.warnedBudget) {
        warnings.push(
          `contextguard: this session has spent an estimated $${costUsd.toFixed(2)}, over the configured ` +
          `session budget of $${config.sessionBudgetUsd.toFixed(2)}.`
        );
        state.warnedBudget = true;
      }
    }
  }

  saveState(sessionId, state);

  if (warnings.length === 0) return;

  const message = warnings.join('\n');

  if (config.reaction === 'notify' && config.webhookUrl) {
    notifyWebhook(config.webhookUrl, message);
  }

  process.stdout.write(JSON.stringify({
    systemMessage: message,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: message,
    },
  }));
}

main();
