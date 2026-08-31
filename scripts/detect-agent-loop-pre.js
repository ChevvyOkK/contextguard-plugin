'use strict';

// PreToolUse hook, matcher "*". This is the ONLY place in the plugin that
// can ever deny a tool call, and it only ever does so for one detector:
// the same call repeated well past the warning threshold. Re-reads,
// revert-loops, and budget overruns never block here — see
// detect-agent-loop-post.js, which handles all four detectors but only ever
// warns/notifies.
//
// Why repeated-calls-only: it's the one pattern where "let the call through
// anyway" has no plausible upside — an identical call, argument for
// argument, cannot discover anything the previous attempt didn't already
// return. The other three detectors are legitimately actionable but not
// unambiguous enough to justify denying real work: re-reading a file can be
// deliberate, a revert can be an intentional rollback, and a budget number
// is an estimate. Blocking on any of those risks stopping the agent from
// doing something the user actually wanted.
//
// Blocking is opt-in and off by default: this hook only denies when the
// user has explicitly set `agentLoop.reaction` to "hard-stop" in
// ~/.claude/contextguard/config.json. The plugin's default reaction is
// "warn", under which this hook always allows. We promised the plugin never
// blocks a call by default — do not weaken that guarantee here.
//
// The threshold to hard-stop is deliberately stricter than the threshold to
// warn (repeatThreshold + HARD_STOP_MARGIN), so hard-stop never fires on the
// first detection — the agent (and the user, via the warning already shown
// by the post hook) gets a chance to change course before anything is
// actually denied.

const { loadAgentLoopConfig } = require('./lib/agent-config');
const { loadState, fingerprint } = require('./lib/agent-state');
const { appendEvidenceEvent } = require('./lib/evidence-ledger');

const HARD_STOP_MARGIN = 4;

function allow() {
  // No output at all is a valid, documented "allow, no opinion" response —
  // nothing to add here for the common case.
}

function main() {
  let raw;
  try {
    raw = require('fs').readFileSync(0, 'utf8');
  } catch {
    return allow();
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return allow();
  }

  const config = loadAgentLoopConfig();
  if (!config.enabled || config.reaction !== 'hard-stop') return allow();

  const sessionId = input.session_id;
  const toolName = input.tool_name;
  if (!sessionId || !toolName) return allow();

  const state = loadState(sessionId);
  const fp = fingerprint(toolName, input.tool_input);
  const hardStopThreshold = config.repeatThreshold + HARD_STOP_MARGIN;

  // Would this call be the Nth identical one in a row? recentCalls holds
  // the calls recorded so far (up to and including the previous one) — the
  // upcoming call isn't in it yet, so a run of (hardStopThreshold - 1)
  // matching entries means this call would complete the streak.
  const needed = hardStopThreshold - 1;
  if (state.recentCalls.length < needed) return allow();

  const tail = state.recentCalls.slice(-needed);
  const wouldExtendStreak = tail.every((c) => c === fp);
  if (!wouldExtendStreak) return allow();

  const eventId = appendEvidenceEvent({
    project: input.cwd || null,
    sessionId,
    type: 'TOOL_CALL_DENIED',
    severity: 'critical',
    confidence: 'high',
    evidence: [
      `exact same tool-call fingerprint would reach ${hardStopThreshold} consecutive executions`,
      `fingerprint: ${fp}`,
    ],
    action: 'denied',
    exactImpact: {
      repeatedToolCalls: hardStopThreshold,
    },
    sourceData: {
      detector: 'hard_stop_repeat_fingerprint',
      toolName,
    },
  });

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `contextguard: this exact call (${fp}) has now been repeated ${hardStopThreshold} times in a row ` +
        `with no new information between attempts. Denied to break the loop — try a different approach, ` +
        `or explain to the user what's blocking progress instead of retrying the same call again.` +
        (eventId ? ` Evidence: ${eventId}.` : ''),
    },
  }));
}

main();
