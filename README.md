<div align="center">

# ContextGuard Plugin

**Runtime Safety, Continuity & Efficiency Guard for Claude Code**  
*Hooks into Claude Code lifecycle to catch no-progress loops, preserve rules across `/compact`, and eliminate token bloat.*

[![Version](https://img.shields.io/badge/version-0.6.0-6366f1)](package.json)
[![Claude Code](https://img.shields.io/badge/claude--code-compatible-orange)](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-success)](package.json)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Quick Install](#-installation) · [Runtime Hooks](#-what-it-does) · [No-Progress Detector](#-no-progress--loop-detection) · [Lossless Vault](#-lossless-context-vault) · [Configuration](#-configuration)

</div>

<br>

> [!IMPORTANT]
> **Zero Network Overhead & 100% Local Execution.**
> All hooks run synchronously in micro-seconds via Node.js directly inside your local Claude Code process. Prompts, code, and tool outputs never leave your computer.

<br>

## 🛡️ What It Does

| Hook Event | Component | Purpose |
|---|---|---|
| **`PreCompact` & `PostCompact`** | **Continuity Guard** | Captures architectural rules and negative constraints (`DO NOT`, `NEVER`, `MUST`) before `/compact` and auto-restores them if dropped. |
| **`PostToolUse` / `PreToolUse`** | **No-Progress Circuit Breaker** | Watches for repetitive failing actions, re-reading unchanged files, and identical test failures that survive real edits. Injects **Structured Force Rethink** and writes evidence. |
| **`PostToolUse` on `Bash`** | **Lossless Vault & Truncator** | Truncates noisy test & build logs to key error lines while archiving 100% raw output locally and recording exact size impact. |
| **`PreToolUse` on `Grep`** | **Search Guard** | Automatically bounds runaway search patterns to 100 matched lines. |

<br>

## ⚡ Installation

Install directly inside Claude Code:

```bash
/plugin marketplace add ChevvyOkK/contextguard-plugin
/plugin install contextguard@contextguard
```

### Local Development / Testing

```bash
# Test local changes directly
claude --plugin-dir ./contextguard-plugin

# Validate manifest syntax
claude plugin validate ./contextguard-plugin
```

<br>

## 🧠 No-Progress & Loop Detection

A stuck agent retrying the same failing fix burns through your 5-hour quota rapidly. ContextGuard watches for **5 behavioral patterns**:

```
1. Repeated identical calls        -> Same tool + arguments 3+ times in a row
2. Excessive file re-reads         -> Same unchanged file re-read 5+ times
3. Revert oscillation              -> Modifying a file back to a previous state
4. Semantic No-Progress            -> Same test failure survives 2+ code edits across 3 test runs
5. Session budget threshold        -> Spend exceeds local configured limit
```

### Structured Force Rethink Intervention

When a loop is detected, ContextGuard halts the repetition and injects a structured diagnostic prompt into the model's context:

```markdown
[ContextGuard Circuit Breaker]:
contextguard: test failure repeated 3 times without progress ("AssertionError: 400 != 200").

ACTION REQUIRED (Force Rethink Protocol):
1. Stop repeating the previous edit strategy.
2. Summarize confirmed facts and explain why previous 3 hypotheses failed.
3. Formulate a fundamentally different root-cause hypothesis before calling Edit/Write.
```

<br>

## 🗄️ Lossless Context Vault

When commands produce large outputs, ContextGuard keeps active memory clean while guaranteeing zero data loss:

```text
... [ContextGuard Lossless Vault: 450 lines archived locally as ref: CG-84A21 — full output preserved] ...
[ContextGuard: key error/failure lines from omitted block]
  FAILED tests/test_payment.py::test_checkout - AssertionError: 400 != 200
```

* **Where it's saved**: `~/.claude/contextguard/vault/CG-84A21.log`
* **How to recall**: `cat ~/.claude/contextguard/vault/CG-84A21.log` or grep through it anytime.

Every guard event also writes a local evidence record to:

```text
~/.claude/contextguard/evidence/events.jsonl
```

Evidence records separate exact facts (original output size, passed size, repeated call counts, vault path) from estimates (rough token savings). Writes are best-effort and fail open: if the ledger cannot be written, Claude Code continues normally.

<br>

## ⚙️ Configuration

Optional configuration in `~/.claude/contextguard/config.json`:

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

* **`warn`** *(default)* — Surfaces non-blocking warnings to you and structured rethink context to the agent.
* **`notify`** — Same as warn + sends a POST payload to `webhookUrl` (Slack/Discord compatible).
* **`hard-stop`** *(opt-in)* — Outright denies consecutive identical tool calls if repeated past the warning threshold.

<br>

## 🔒 Privacy & Safety Guarantee

- **Zero dependencies**: Uses Node.js built-ins (`fs`, `path`, `os`, `crypto`).
- **Zero code modification**: Never alters source files autonomously.
- **Zero data egress**: 100% of telemetry and logs remain in `~/.claude/contextguard/`.

<br>

## 📄 License

Licensed under the MIT License — see [LICENSE](LICENSE).
