#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getLicenseStatus } = require('./lib/license');
const { EVIDENCE_FILE, readEvidenceEvents } = require('./lib/evidence-ledger');

console.log('🩺 Running ContextGuard Health & Diagnostic Check...\n');

let issues = 0;

// 1. Claude config directory check
const claudeDir = path.join(os.homedir(), '.claude');
if (fs.existsSync(claudeDir)) {
  console.log('  [✓] Claude Code directory found (~/.claude)');
} else {
  console.log('  [!] Claude Code directory not found (~/.claude). Run Claude Code at least once.');
  issues++;
}

// 2. ContextGuard storage directory check
const cgDir = path.join(claudeDir, 'contextguard');
try {
  fs.mkdirSync(cgDir, { recursive: true });
  console.log('  [✓] ContextGuard storage directory writable (~/.claude/contextguard)');
} catch (err) {
  console.log(`  [✗] Cannot write to ContextGuard storage: ${err.message}`);
  issues++;
}

// 3. Lossless Vault check
const vaultDir = path.join(cgDir, 'vault');
try {
  fs.mkdirSync(vaultDir, { recursive: true });
  console.log('  [✓] Lossless Context Vault writable (~/.claude/contextguard/vault)');
} catch (err) {
  console.log(`  [✗] Cannot write to Lossless Vault: ${err.message}`);
  issues++;
}

// 4. Runtime License check
const evidenceDir = path.dirname(EVIDENCE_FILE);
try {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.appendFileSync(EVIDENCE_FILE, '');
  const recentEvents = readEvidenceEvents(5).length;
  console.log(`  [✓] Evidence Ledger writable (~/.claude/contextguard/evidence/events.jsonl, ${recentEvents} recent event(s) readable)`);
} catch (err) {
  console.log(`  [✗] Cannot write Evidence Ledger: ${err.message}`);
  issues++;
}

// 5. Runtime License check
const lic = getLicenseStatus();
if (lic.isPro) {
  console.log(`  [✓] Pro License Active: Plan "${lic.plan}" (Status: ${lic.status})`);
} else if (lic.status === 'unverified') {
  console.log('  [!] License file present but not verified. Running as Free Community until a signed license is installed.');
} else {
  console.log('  [i] License: Free Community (Shadow Mode & local audit active)');
}

// 6. Hooks validation
const hooks = [
  'truncate-bash-output.js',
  'detect-agent-loop-post.js',
  'detect-agent-loop-pre.js',
  'cap-grep-limit.js',
  'continuity-guard-pre.js',
  'continuity-guard-post.js',
];
let hooksFound = 0;
for (const h of hooks) {
  const p = path.join(__dirname, h);
  if (fs.existsSync(p)) hooksFound++;
}
if (hooksFound === hooks.length) {
  console.log(`  [✓] All ${hooks.length} runtime hooks present and verified`);
} else {
  console.log(`  [!] Warning: only ${hooksFound}/${hooks.length} hooks found in plugin directory`);
  issues++;
}

console.log('\n------------------------------------------------------------');
if (issues === 0) {
  console.log('🎉 All systems operational! ContextGuard is ready.');
} else {
  console.log(`⚠️  ${issues} issue(s) detected. Please check permissions or run setup.`);
}
console.log('------------------------------------------------------------\n');
