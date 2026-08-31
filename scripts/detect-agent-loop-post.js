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
  recordTestAndCheckNoProgress,
} = require('./lib/agent-state');
const { costTranscriptSync } = require('./lib/transcript-cost');
const { appendEvidenceEvent } = require('./lib/evidence-ledger');

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
  const alerts = [];

  const fp = recordCall(state, toolName, input.tool_input);

  // 1. Repeated identical calls.
  if (isRepeating(state, config.repeatThreshold) && !state.warnedRepeatFor) {
    alerts.push({
      message:
        `contextguard: the last ${config.repeatThreshold} tool calls were identical (${fp}). ` +
        `This usually means the agent is stuck retrying the same thing without new information.`,
      event: {
        type: 'NO_PROGRESS_DETECTED',
        severity: 'warning',
        confidence: 'high',
        evidence: [
          `same tool-call fingerprint repeated ${config.repeatThreshold} times`,
          `fingerprint: ${fp}`,
        ],
        action: 'warned',
        exactImpact: {
          repeatedToolCalls: config.repeatThreshold,
        },
        sourceData: {
          detector: 'repeat_fingerprint',
          toolName,
        },
      },
    });
    state.warnedRepeatFor = fp;
  } else if (state.warnedRepeatFor && state.warnedRepeatFor !== fp) {
    // A different call broke the streak — allow a future repeat of the same
    // (or a different) fingerprint to warn again.
    state.warnedRepeatFor = null;
  }

  // 2. Re-reading the same file past the threshold.
  const readPath = toolName === 'Read' && input.tool_input ? input.tool_input.file_path : null;
  if (readPath && rereadExceeded(state, readPath, config.rereadThreshold)) {
    alerts.push({
      message:
        `contextguard: "${path.basename(readPath)}" has been read ${state.readCounts[readPath]} times this session. ` +
        `If its content isn't changing, re-reading it just re-spends context on something already in view.`,
      event: {
        type: 'REPEATED_READ_DETECTED',
        severity: 'notice',
        confidence: 'medium',
        evidence: [
          `same file read ${state.readCounts[readPath]} times in this session`,
          `file: ${readPath}`,
        ],
        action: 'warned',
        exactImpact: {
          readCount: state.readCounts[readPath],
        },
        sourceData: {
          detector: 'reread_count',
          toolName,
        },
      },
    });
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
        alerts.push({
          message:
            `contextguard: "${path.basename(filePath)}" was just edited back to a state it was in earlier this session. ` +
            `That can mean the agent is oscillating between two versions instead of converging.`,
          event: {
            type: 'EDIT_OSCILLATION_DETECTED',
            severity: 'warning',
            confidence: 'medium',
            evidence: [
              'new file content hash matches an earlier session state',
              `file: ${filePath}`,
            ],
            action: 'warned',
            exactImpact: {
              editHistoryDepth: (state.editHashes[filePath] || []).length,
            },
            sourceData: {
              detector: 'edit_revert_hash',
              toolName,
            },
          },
        });
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
        alerts.push({
          message:
            `contextguard: this session has spent an estimated $${costUsd.toFixed(2)}, over the configured ` +
            `session budget of $${config.sessionBudgetUsd.toFixed(2)}.`,
          event: {
            type: 'BUDGET_THRESHOLD_CROSSED',
            severity: 'warning',
            confidence: 'medium',
            evidence: [
              `transcript cost estimate $${costUsd.toFixed(2)}`,
              `configured budget $${config.sessionBudgetUsd.toFixed(2)}`,
            ],
            action: 'warned',
            estimatedImpact: {
              sessionCostUsd: costUsd,
              budgetUsd: config.sessionBudgetUsd,
            },
            sourceData: {
              detector: 'local_transcript_budget',
              transcriptPath: input.transcript_path,
            },
          },
        });
        state.warnedBudget = true;
      }
    }
  }

  // 5. No-Progress Detector: test execution failing repeatedly across multiple file edits.
  if (toolName === 'Bash' && input.tool_input && input.tool_input.command) {
    const cmd = input.tool_input.command;
    const output = input.tool_response || '';
    const noProgress = recordTestAndCheckNoProgress(state, cmd, output, 3);
    if (noProgress) {
      alerts.push({
        message:
          `contextguard: test failure repeated ${noProgress.consecutiveFailures} times without progress ` +
          `("${noProgress.signature}"). The same failure survived ${noProgress.editCountDelta} code edits.`,
        event: {
          type: 'NO_PROGRESS_DETECTED',
          severity: 'warning',
          confidence: 'high',
          evidence: [
            `same failing test signature repeated ${noProgress.consecutiveFailures} times`,
            `same failure survived ${noProgress.editCountDelta} edits`,
            `signature: ${noProgress.signature}`,
          ],
          action: 'force_rethink_prompt_injected',
          exactImpact: {
            consecutiveFailures: noProgress.consecutiveFailures,
            editsBetweenFailures: noProgress.editCountDelta,
          },
          sourceData: {
            detector: 'test_failure_survived_edits',
            command: noProgress.command,
            editedPaths: noProgress.editedPaths,
          },
        },
      });
    }
  }

  saveState(sessionId, state);

  if (alerts.length === 0) return;

  const userMessage = alerts.map((alert) => alert.message).join('\n');
  const modelContext = 
    `[ContextGuard Circuit Breaker]:\n${userMessage}\n\n` +
    `ACTION REQUIRED (Force Rethink Protocol):\n` +
    `1. Stop repeating the previous action or oscillating between edits.\n` +
    `2. Summarize confirmed facts and identify why the previous attempt did not progress.\n` +
    `3. Propose a new, verified hypothesis before executing another tool.`;

  if (config.reaction === 'notify' && config.webhookUrl) {
    notifyWebhook(config.webhookUrl, userMessage);
  }

  const eventIds = alerts
    .map((alert) => appendEvidenceEvent({
      ...alert.event,
      project: input.cwd || null,
      sessionId,
    }))
    .filter(Boolean);

  process.stdout.write(JSON.stringify({
    systemMessage: `ContextGuard: ${userMessage}${eventIds.length > 0 ? `\nEvidence: ${eventIds.join(', ')}` : ''}`,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: modelContext,
    },
  }));
}

main();
