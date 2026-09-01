---
description: Start the ContextGuard Remote bridge for this machine, so a paired Telegram bot can send prompts into this Claude Code session. Use when the user asks to enable/start/turn on ContextGuard Remote or Telegram remote control, or asks why their Telegram bot shows the CLI as "offline".
disable-model-invocation: true
allowed-tools: Bash
---

Start the ContextGuard → Telegram bridge for the current machine:

1. Confirm `contextguard` is installed and on PATH (e.g. `contextguard --version`). If it isn't found, tell the user to install it first — the dashboard's Settings → Remote guide has the one-line installer for their OS — and stop here.
2. Launch `contextguard remote` **in the background**. It's long-running by design (blocks until Ctrl+C or the connection drops) — do not wait for it to exit, and do not treat it finishing quickly as success.
3. Give it a couple of seconds, then check its output:
   - `Connected. Waiting for prompts from Telegram...` → tell the user Remote is live in this session; they can message their paired Telegram bot now.
   - `This command needs your ContextGuard API key...` → this machine has never been paired. Tell the user to run `contextguard tg --api-key <key>` once (the key is on the dashboard's API Keys page). After that the key is saved locally (`~/.claude/contextguard/`) and never needs to be typed again, including for this command.
   - `Connection lost` / repeated reconnect attempts → likely not on a Pro/Lifetime plan, or the key was revoked — point them at Settings → Telegram Remote Control on the dashboard.
4. Never print the API key itself if it happens to appear in any output.

Leave the background process running once it connects — that's the feature. Don't kill it after reporting status.
