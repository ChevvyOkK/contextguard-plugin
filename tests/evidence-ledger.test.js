'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('evidence ledger appends durable local events and redacts secrets', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'contextguard-ledger-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  const modulePath = require.resolve('../scripts/lib/evidence-ledger');
  delete require.cache[modulePath];
  const { appendEvidenceEvent, readEvidenceEvents, EVIDENCE_FILE } = require('../scripts/lib/evidence-ledger');

  const id = appendEvidenceEvent({
    sessionId: 'session/../unsafe',
    type: 'OUTPUT_TRUNCATED',
    severity: 'info',
    confidence: 'high',
    evidence: ['command used api_key=super-secret-token'],
    sourceData: {
      authorization: 'Bearer secret',
      command: 'npm test',
    },
    exactImpact: {
      originalChars: 12000,
      passedChars: 4000,
    },
  });

  assert.match(id, /^CGE-/);
  assert.ok(fs.existsSync(EVIDENCE_FILE));

  const events = readEvidenceEvents(1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'OUTPUT_TRUNCATED');
  assert.equal(events[0].sessionId, 'session____unsafe');
  assert.deepEqual(events[0].exactImpact, { originalChars: 12000, passedChars: 4000 });
  assert.equal(events[0].sourceData.authorization, '[REDACTED]');
  assert.match(events[0].evidence[0], /\[REDACTED\]/);
});
