# ContextGuard (plugin)

A runtime safety, continuity & efficiency plugin for Claude Code.

Actively protects 5-hour/7-day quota limits, prevents stuck agent loops, and eliminates context amnesia after `/compact`.

## What it does

- **`PreCompact` & `PostCompact` (Continuity Guard)** — When Claude Code triggers compaction (`/compact`), critical architectural rules, negative constraints (`DO NOT`, `NEVER`, `MUST`), and key decisions are captured pre-compact and automatically re-injected if lost during summarization.
- **`PostToolUse` / `PreToolUse` (Circuit Breaker & Force Rethink)** — Watches for repeated identical calls, re-reading unchanged files, oscillating edits, and repeated test failure loops. When stuck, halts the loop and injects a structured *Force Rethink* protocol.
- **`PostToolUse` on `Bash` (Lossless Vault & Truncator)** — Long command output gets truncated with key error lines kept, while 100% of the raw output is archived locally in `~/.claude/contextguard/vault/` with a reference ID (`CG-XXXXX`) for instant recall.
- **`PreToolUse` on `Grep`** — Automatically caps unbounded searches to 100 matched lines.

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
- **Never blocks a tool call by default.** Out of the box, every hook in
  this plugin either rewrites input/output or does nothing; none of them
  deny a call. That's the default for everyone, with no setup required. The
  one exception is opt-in only, described below — until you explicitly turn
  it on, the guarantee holds unchanged.
- **The "tokens saved" figure is an estimate** (`chars_removed / 4`), not a
  measurement against the real tokenizer — good enough to see the trend,
  not to reconcile a bill.

## Agent-loop & No-Progress detection

A stuck agent — retrying the same failing call, re-reading a file it's
already seen a dozen times, oscillating an edit back and forth, repeating test
failures despite code edits, or quietly running up a large bill — wastes quota
in a way none of the basic hooks catch. Two hooks (`PostToolUse`/`PreToolUse`,
matcher `*`) watch for five patterns:

1. **Repeated identical calls** — the same tool, same arguments, several
   times in a row.
2. **Excessive re-reads** — the same file `Read` more times than seems
   useful in one session.
3. **Revert loops** — an `Edit`/`Write` that puts a file back into a state
   it was already in earlier in the session, i.e. oscillating instead of
   converging.
4. **No-Progress test loops** — test runners (`pytest`, `npm test`, `cargo test`, `jest`, `vitest`) failing with identical signatures 3+ times in a row despite multiple file edits.
5. **Session budget** — estimated spend for the current session crossing
   an optional threshold you set yourself.

### Reaction, and the one thing that can ever block

Configure this in `~/.claude/contextguard/config.json`:

```json
{
  "agentLoop": {
    "enabled": true,
    "reaction": "warn",
    "repeatThreshold": 4,
    "rereadThreshold": 5,
    "sessionBudgetUsd": null,
    "webhookUrl": null
  }
}
```

`reaction` has three levels:

- **`warn`** (default) — a message is surfaced to you and to the agent
  (via `systemMessage` and `additionalContext`) when a pattern is detected.
  Nothing is ever denied at this level, for any of the four patterns.
- **`notify`** — same warning, plus a POST to `webhookUrl` (same `{"text":
  ...}` payload shape as the dashboard's own budget alerts and `contextguard
  budget --webhook-url`, so an existing Slack/Discord integration works
  unchanged).
- **`hard-stop`** — everything from `warn`/`notify`, *plus*: if the
  **exact same call** (same tool, same arguments) is attempted again and
  again well past the warning threshold, the next attempt is denied outright
  (`PreToolUse`, `permissionDecision: "deny"`, with a reason Claude can see
  and act on). This is the only one of the four patterns that can ever
  block anything, and it only blocks once the streak is meaningfully longer
  than what already triggered a warning (`repeatThreshold + 4` in a row) —
  so it never fires as a surprise on first detection. Re-reads, revert
  loops, and budget overruns are never blocking, at any reaction level: each
  is real signal, but none of them is unambiguous enough on its own to
  justify denying a call the user might genuinely want.

Setting `reaction: "hard-stop"` is an explicit, one-time opt-in you make
yourself — it is never the default and this plugin will never enable it for
you.

State for this detector lives at
`~/.claude/contextguard/agent-state/<session_id>.json` — one small file per
session, holding only fingerprints, counts, and content hashes needed for
the checks above (never file contents, prompts, or tool output). Safe to
delete at any time; a missing file just means detection restarts from zero
for that session.

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

## License

All rights reserved — see [LICENSE](LICENSE). You're free to install and
use this plugin, personal or commercial, exactly as you can today;
copying, modifying, or redistributing it needs permission. A revised
license adding specific commercial-licensing terms is planned; see the
LICENSE file for the no-retroactivity guarantee that comes with it.
