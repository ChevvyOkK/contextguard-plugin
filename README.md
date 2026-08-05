# ContextGuard (plugin)

A Claude Code plugin that actively cuts token usage instead of just
reporting it. Two hooks, both defensive by design — if anything about the
input looks unexpected, they no-op rather than guess.

## What it does

- **`PostToolUse` on `Bash`** — long command output (a verbose `npm
  install`, a noisy test run, a full build log) gets written into the
  conversation once but then billed again on every subsequent cache read
  for the rest of the session. This hook truncates output over ~200 lines
  or ~8000 characters down to the first 40 and last 60 lines, while pulling
  any line that looks like an actual error (`error`, `fail`, `exception`,
  `traceback`, `panic`, case-insensitive) out of the omitted middle so the
  signal survives the cut.
- **`PreToolUse` on `Grep`** — if a search doesn't set an explicit
  `head_limit`, this caps it to 100 matched lines rather than letting a
  broad content search return thousands of lines from a large repo. A
  caller-specified `head_limit` is always left untouched.

Every intervention is logged to `~/.claude/contextguard/savings.jsonl` —
this is how the companion [`contextguard`](https://github.com/ChevvyOkK/contextguard)
CLI's report shows a "tokens saved" figure. The Grep hook logs that it
capped a search but doesn't invent a token-savings number for it, since the
actual output size was never measured (the search hadn't run yet) — the
Bash hook does report a real estimate, computed from the actual character
count removed.

## What it deliberately doesn't do

- **Never touches file content or Read output.** `Read` already defaults
  to a bounded line count in Claude Code itself; narrowing it further here
  risked silently hiding content Claude actually needed, which is a much
  worse failure mode than a few extra tokens. Only Bash's own noisy
  process output — logs, not source — gets truncated.
- **Never blocks a tool call.** Both hooks either rewrite input/output or
  do nothing; neither can deny a call. A plugin that saves tokens by
  breaking your workflow isn't worth installing.
- **The "tokens saved" figure is an estimate** (`chars_removed / 4`), not a
  measurement against the real tokenizer — good enough to see the trend,
  not to reconcile a bill.

## Installing

```
/plugin marketplace add ChevvyOkK/contextguard-plugin
/plugin install contextguard@contextguard
```

Local / development install (e.g. to test a change before it's pushed):

```bash
claude --plugin-dir /path/to/contextguard-plugin
```

Validate the manifest before shipping a change:

```bash
claude plugin validate /path/to/contextguard-plugin
```

## Requirements

Node.js (bundled with Claude Code itself, so no extra install). No other
dependencies — both hook scripts use only Node's built-in `fs`/`os`/`path`.
