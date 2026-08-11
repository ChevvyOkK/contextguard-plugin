'use strict';

// PostToolUse hook for Bash. Long, noisy command output (npm installs, test
// runs, build logs) gets written into the conversation once but then paid
// for again on every subsequent cache read for the rest of the session —
// truncating it here is a one-time cost that keeps paying off. We keep the
// head, the tail, and any lines that look like an actual error so the
// signal survives even when the middle is thrown away.

const { estimateTokens, logSavings } = require('./lib/savings-log');

const HEAD_LINES = 40;
const TAIL_LINES = 60;
const MAX_SIGNAL_LINES = 20;
const LINE_THRESHOLD = 200;
const CHAR_THRESHOLD = 8000;
const SIGNAL_PATTERN = /error|exception|fail|traceback|fatal|panic/i;

// "npm test", "cargo build" — enough to group by in a report, not the full
// command (arguments, paths, flags aren't needed to answer "what kind of
// command tends to produce noisy output", and there's no reason to keep
// more of it than that on disk).
function commandLabel(toolInput) {
  const command = toolInput && typeof toolInput.command === 'string' ? toolInput.command.trim() : '';
  if (!command) return undefined;
  const words = command.split(/\s+/).slice(0, 2).join(' ');
  return words.slice(0, 40);
}

function extractText(toolResponse) {
  if (typeof toolResponse === 'string') return toolResponse;
  if (toolResponse && typeof toolResponse === 'object') {
    const parts = [];
    for (const key of ['output', 'stdout', 'content', 'result', 'text']) {
      if (typeof toolResponse[key] === 'string') parts.push(toolResponse[key]);
    }
    if (typeof toolResponse.stderr === 'string' && toolResponse.stderr.length > 0) {
      parts.push(toolResponse.stderr);
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return null;
}

function truncate(text) {
  const lines = text.split('\n');
  if (lines.length <= LINE_THRESHOLD && text.length <= CHAR_THRESHOLD) {
    return null;
  }

  const head = lines.slice(0, HEAD_LINES);
  const tail = lines.slice(Math.max(HEAD_LINES, lines.length - TAIL_LINES));
  const middle = lines.slice(HEAD_LINES, lines.length - TAIL_LINES);

  const signalLines = [];
  const seen = new Set();
  for (const line of middle) {
    if (signalLines.length >= MAX_SIGNAL_LINES) break;
    if (SIGNAL_PATTERN.test(line) && !seen.has(line)) {
      seen.add(line);
      signalLines.push(line);
    }
  }

  const omittedCount = middle.length;
  const marker = `... [contextguard: ${omittedCount} lines omitted] ...`;
  const signalBlock = signalLines.length > 0
    ? ['', `[contextguard: possible error/fail lines from the omitted output]`, ...signalLines, '']
    : [];

  return [...head, marker, ...signalBlock, ...tail].join('\n');
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

  const text = extractText(input.tool_response);
  if (!text) return;

  const truncated = truncate(text);
  if (!truncated) return;

  const charsRemoved = text.length - truncated.length;
  if (charsRemoved <= 0) return;

  logSavings({
    hook: 'bash_truncate',
    tool_name: input.tool_name || 'Bash',
    tokens_saved_estimate: estimateTokens(charsRemoved),
    // Lets a report attribute this saving to the session it happened in —
    // e.g. to weight it by how many turns were still ahead of it, since the
    // truncated (smaller) output is what gets cached and resent from here
    // on, not just written once. Never leaves this machine: --push sends
    // aggregate daily numbers only, this file is local-only.
    session_id: input.session_id || undefined,
    // First couple of words of the command, for grouping ("npm test",
    // "cargo build") rather than the full command line — plenty to
    // identify a "top source of savings" without keeping more of the
    // command text than a report needs.
    command: commandLabel(input.tool_input),
  });

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: truncated,
    },
  }));
}

main();
