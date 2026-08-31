#!/usr/bin/env node
"use strict";

/**
 * ContextGuard Remote Terminal Bridge
 * 
 * Establishes an outbound secure WebSocket tunnel to the ContextGuard API.
 * Spawns the local Claude Code CLI process, bridges terminal I/O, and transmits
 * structured tool & streaming events so you can control your session from Telegram.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const WebSocketClient = typeof WebSocket !== "undefined" ? WebSocket : (() => {
  try {
    return require("ws");
  } catch {
    return null;
  }
})();

function loadApiKey() {
  if (process.env.CONTEXTGUARD_API_KEY) {
    return process.env.CONTEXTGUARD_API_KEY.trim();
  }

  const credPath = path.join(os.homedir(), ".contextguard", "credentials");
  if (fs.existsSync(credPath)) {
    try {
      const content = fs.readFileSync(credPath, "utf8");
      const match = content.match(/api_key\s*=\s*(.+)/);
      if (match) return match[1].trim();
    } catch {
      // ignore
    }
  }
  return null;
}

function getGitBranch() {
  try {
    const head = fs.readFileSync(path.join(process.cwd(), ".git", "HEAD"), "utf8");
    const match = head.match(/ref: refs\/heads\/(.+)/);
    return match ? match[1].trim() : "HEAD";
  } catch {
    return null;
  }
}

function getProjectName() {
  const pkgPath = path.join(process.cwd(), "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.name) return pkg.name;
    } catch {
      // ignore
    }
  }
  return path.basename(process.cwd());
}

async function runRemoteBridge() {
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.error("\x1b[31m[ContextGuard Remote] Ошибка: Не найден API-ключ ContextGuard.\x1b[0m");
    console.error("Войдите в личный кабинет ContextGuard или укажите переменную окружения CONTEXTGUARD_API_KEY.\n");
    process.exit(1);
  }

  const serverUrl = process.env.CONTEXTGUARD_REMOTE_URL || "ws://localhost:3000/remote/ws";
  const wsUrl = `${serverUrl}?apiKey=${encodeURIComponent(apiKey)}`;

  console.log("\x1b[36m⚡ ContextGuard Remote Bridge\x1b[0m");
  console.log(`📁 Проект: \x1b[32m${getProjectName()}\x1b[0m | Ветка: \x1b[33m${getGitBranch() || "N/A"}\x1b[0m`);
  console.log(`🔌 Подключение к шлюзу: ${serverUrl}...`);

  if (!WebSocketClient) {
    console.error("\x1b[31m[ContextGuard Remote] WebSocket client is not available in this Node runtime.\x1b[0m");
    process.exit(1);
  }

  const ws = new WebSocketClient(wsUrl);

  let claudeProcess = null;

  function spawnClaudeSession(prompt) {
    if (claudeProcess) {
      // Already running; feed prompt via stdin
      claudeProcess.stdin.write(prompt + "\n");
      return;
    }

    const command = process.platform === "win32" ? "claude.cmd" : "claude";
    const args = prompt ? [prompt] : [];

    console.log(`\n\x1b[35m[Remote] Запуск Claude Code...\x1b[0m\n`);

    claudeProcess = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      env: { ...process.env, FORCE_COLOR: "1" },
    });

    claudeProcess.stdout.on("data", (data) => {
      const text = data.toString();
      process.stdout.write(text);

      if (ws.readyState === 1 || (WebSocketClient.OPEN !== undefined && ws.readyState === WebSocketClient.OPEN)) {
        ws.send(
          JSON.stringify({
            type: "stream_chunk",
            chunk: text,
            timestamp: new Date().toISOString(),
          }),
        );
      }

      // Detect permission requests (y/n)
      if (/\([yY]\/[nN]\)/.test(text) || /Do you want to proceed\?/i.test(text)) {
        if (ws.readyState === 1 || (WebSocketClient.OPEN !== undefined && ws.readyState === WebSocketClient.OPEN)) {
          ws.send(
            JSON.stringify({
              type: "ask_confirmation",
              actionId: `act_${Date.now()}`,
              prompt: text.slice(-300),
            }),
          );
        }
      }
    });

    claudeProcess.stderr.on("data", (data) => {
      const text = data.toString();
      process.stderr.write(text);

      if (ws.readyState === 1 || (WebSocketClient.OPEN !== undefined && ws.readyState === WebSocketClient.OPEN)) {
        ws.send(
          JSON.stringify({
            type: "stream_chunk",
            chunk: text,
            timestamp: new Date().toISOString(),
          }),
        );
      }
    });

    claudeProcess.on("close", (code) => {
      console.log(`\n\x1b[35m[Remote] Claude Code завершил выполнение (код: ${code})\x1b[0m`);
      if (ws.readyState === 1 || (WebSocketClient.OPEN !== undefined && ws.readyState === WebSocketClient.OPEN)) {
        ws.send(
          JSON.stringify({
            type: "turn_complete",
            exitCode: code,
            summary: `Сессия завершена (код: ${code})`,
          }),
        );
      }
      claudeProcess = null;
    });
  }

  ws.on("open", () => {
    console.log("\x1b[32m✔ Успешно подключено к Remote Gateway!\x1b[0m");
    console.log("📱 Теперь вы можете отправлять сообщения из Telegram в этот терминал.\n");

    // Send session metadata
    ws.send(
      JSON.stringify({
        type: "session_init",
        projectName: getProjectName(),
        gitBranch: getGitBranch(),
        cwd: process.cwd(),
        sessionId: `sess_${Date.now()}`,
      }),
    );
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "prompt") {
        console.log(`\n\x1b[34m[Telegram -> Claude]:\x1b[0m ${msg.prompt}`);
        spawnClaudeSession(msg.prompt);
      } else if (msg.type === "confirmation_response") {
        console.log(`\n\x1b[34m[Telegram Permission]:\x1b[0m ${msg.approved ? "Одобрено (y)" : "Отклонено (n)"}`);
        if (claudeProcess && claudeProcess.stdin) {
          claudeProcess.stdin.write(msg.approved ? "y\n" : "n\n");
        }
      } else if (msg.type === "signal") {
        console.log(`\n\x1b[31m[Telegram Signal]:\x1b[0m ${msg.signal}`);
        if (claudeProcess) {
          claudeProcess.kill(msg.signal);
        }
      }
    } catch (err) {
      console.error("[Remote] Ошибка парсинга сообщения:", err.message);
    }
  });

  ws.on("error", (err) => {
    console.error(`\x1b[31m[Remote WS Error]\x1b[0m ${err.message}`);
  });

  ws.on("close", (code, reason) => {
    console.log(`\x1b[33m[Remote] Соединение закрыто (${code}): ${reason || "Повторное подключение через 5с..."}\x1b[0m`);
    setTimeout(runRemoteBridge, 5000);
  });
}

if (require.main === module) {
  runRemoteBridge();
}

module.exports = { runRemoteBridge, loadApiKey, getProjectName, getGitBranch };
