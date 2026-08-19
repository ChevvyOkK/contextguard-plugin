'use strict';

// ContextGuard Lossless Vault — Local-only disk archive for truncated tool outputs.
//
// When bash outputs or test logs exceed context thresholds, we store the 100%
// complete raw output on local disk under ~/.claude/contextguard/vault/{id}.log.
// A compact summary with reference tag is returned to Claude Code, saving tokens
// while guaranteeing zero information loss.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VAULT_DIR = path.join(os.homedir(), '.claude', 'contextguard', 'vault');

function getVaultDir() {
  return VAULT_DIR;
}

function generateVaultId(sessionId, content) {
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 6).toUpperCase();
  const time = Date.now().toString(36).slice(-4).toUpperCase();
  return `CG-${hash}-${time}`;
}

/**
 * Stores raw output into the local vault and returns the reference ID.
 * @param {string} sessionId
 * @param {string} content
 * @param {object} metadata
 * @returns {string|null} Vault ID
 */
function storeInVault(sessionId, content, metadata = {}) {
  try {
    fs.mkdirSync(VAULT_DIR, { recursive: true });
    const vaultId = generateVaultId(sessionId || 'sess', content);
    const filePath = path.join(VAULT_DIR, `${vaultId}.log`);
    const metaPath = path.join(VAULT_DIR, `${vaultId}.json`);

    fs.writeFileSync(filePath, content, 'utf8');
    fs.writeFileSync(metaPath, JSON.stringify({
      id: vaultId,
      sessionId: sessionId || 'unknown',
      createdAt: new Date().toISOString(),
      sizeChars: content.length,
      lines: content.split('\n').length,
      ...metadata,
    }, null, 2), 'utf8');

    // Clean up old entries if directory gets too large (>500 files)
    cleanOldVaultEntries();

    return vaultId;
  } catch {
    return null;
  }
}

/**
 * Recalls stored raw content by Vault ID.
 * @param {string} vaultId
 * @returns {string|null}
 */
function recallFromVault(vaultId) {
  try {
    const safeId = String(vaultId).replace(/[^a-zA-Z0-9_-]/g, '');
    const filePath = path.join(VAULT_DIR, `${safeId}.log`);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8');
    }
    return null;
  } catch {
    return null;
  }
}

function cleanOldVaultEntries(maxEntries = 500) {
  try {
    const files = fs.readdirSync(VAULT_DIR);
    if (files.length <= maxEntries * 2) return;

    const stats = files
      .map(f => ({ name: f, path: path.join(VAULT_DIR, f), time: fs.statSync(path.join(VAULT_DIR, f)).mtimeMs }))
      .sort((a, b) => a.time - b.time);

    const toRemove = stats.slice(0, files.length - maxEntries * 2);
    for (const item of toRemove) {
      fs.unlinkSync(item.path);
    }
  } catch {
    // best-effort cleanup
  }
}

module.exports = {
  storeInVault,
  recallFromVault,
  getVaultDir,
};
