'use strict';

// PreCompact hook: Fires before Claude Code compacts the context window.
// Extracts critical negative constraints, architectural decisions, and
// rules from CLAUDE.md / session so they aren't lost during summarization.

const fs = require('fs');
const path = require('path');
const os = require('os');

function getCapsuleDir() {
  const dir = path.join(os.homedir(), '.claude', 'contextguard-capsules');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function extractConstraints(cwd) {
  const constraints = [];
  try {
    const claudeMdPath = path.join(cwd || process.cwd(), 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
      const content = fs.readFileSync(claudeMdPath, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (
          trimmed.startsWith('-') &&
          (/\b(DO NOT|NEVER|ALWAYS|MUST|CRITICAL|IMPORTANT|DON'T|FORBIDDEN)\b/i.test(trimmed) ||
           /не (удаля|трога|пуш|меня)/i.test(trimmed))
        ) {
          constraints.push(trimmed.replace(/^[-*]\s*/, ''));
        }
      }
    }
  } catch {}
  return constraints.slice(0, 10);
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    return;
  }

  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const sessionId = input.session_id || 'default_session';
  const cwd = input.cwd || process.cwd();
  const constraints = extractConstraints(cwd);

  const capsule = {
    sessionId,
    timestamp: Date.now(),
    cwd,
    constraints,
    capturedAt: new Date().toISOString()
  };

  try {
    const capsulePath = path.join(getCapsuleDir(), `${sessionId}.json`);
    fs.writeFileSync(capsulePath, JSON.stringify(capsule, null, 2), 'utf8');
  } catch {}
}

main();
