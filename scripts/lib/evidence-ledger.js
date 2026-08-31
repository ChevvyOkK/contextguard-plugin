'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EVIDENCE_DIR = path.join(os.homedir(), '.claude', 'contextguard', 'evidence');
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, 'events.jsonl');
const MAX_EVENTS = 2000;

const SECRET_PATTERN =
  /(sk-[a-zA-Z0-9_-]{12,}|AKIA[0-9A-Z]{16}|xox[baprs]-[a-zA-Z0-9-]{10,}|(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*['"]?[^'"\s]+)(?=$|\s|['"])/gi;

function nowIso() {
  return new Date().toISOString();
}

function safeSessionId(sessionId) {
  if (!sessionId) return 'unknown';
  return String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96);
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12).toUpperCase();
}

function redactText(value) {
  if (typeof value !== 'string') return value;
  return value.replace(SECRET_PATTERN, '[REDACTED]');
}

function redact(value, depth = 0) {
  if (depth > 6) return '[MAX_DEPTH]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/password|secret|token|api.?key|authorization|cookie/i.test(key)) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = redact(item, depth + 1);
    }
  }
  return out;
}

function normalizeEvent(input) {
  const timestamp = input.timestamp || nowIso();
  const type = input.type || 'UNKNOWN_EVENT';
  const sessionId = safeSessionId(input.sessionId || input.session_id);
  const fingerprint = shortHash(JSON.stringify({
    timestamp,
    type,
    sessionId,
    evidence: input.evidence || [],
    exactImpact: input.exactImpact || null,
    localReferences: input.localReferences || null,
  }));

  return {
    id: input.id || `CGE-${timestamp.slice(0, 10).replace(/-/g, '')}-${fingerprint}`,
    timestamp,
    project: input.project || input.cwd || null,
    sessionId,
    type,
    severity: input.severity || 'info',
    confidence: input.confidence || 'medium',
    evidence: redact(input.evidence || []),
    action: input.action || null,
    userDecision: input.userDecision || null,
    exactImpact: redact(input.exactImpact || null),
    estimatedImpact: redact(input.estimatedImpact || null),
    sourceData: redact(input.sourceData || null),
    localReferences: redact(input.localReferences || null),
  };
}

function trimLedgerIfNeeded() {
  try {
    if (!fs.existsSync(EVIDENCE_FILE)) return;
    const lines = fs.readFileSync(EVIDENCE_FILE, 'utf8').trimEnd().split('\n');
    if (lines.length <= MAX_EVENTS) return;
    fs.writeFileSync(EVIDENCE_FILE, lines.slice(-MAX_EVENTS).join('\n') + '\n', 'utf8');
  } catch {
    // Best effort retention only.
  }
}

function appendEvidenceEvent(input) {
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const event = normalizeEvent(input);
    fs.appendFileSync(EVIDENCE_FILE, JSON.stringify(event) + '\n', 'utf8');
    trimLedgerIfNeeded();
    return event.id;
  } catch {
    return null;
  }
}

function readEvidenceEvents(limit = 50) {
  try {
    if (!fs.existsSync(EVIDENCE_FILE)) return [];
    const lines = fs.readFileSync(EVIDENCE_FILE, 'utf8').trimEnd().split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

module.exports = {
  appendEvidenceEvent,
  readEvidenceEvents,
  redact,
  EVIDENCE_FILE,
  EVIDENCE_DIR,
};
