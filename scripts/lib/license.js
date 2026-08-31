'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const LICENSE_PATH = path.join(os.homedir(), '.claude', 'contextguard', 'license.json');

/**
 * Checks local license state for Pro features.
 * Supports a 7-day offline grace period so temporary network drops never block the agent.
 */
function getLicenseStatus() {
  try {
    if (!fs.existsSync(LICENSE_PATH)) {
      return { plan: 'free', isPro: false, status: 'unlicensed' };
    }
    const raw = fs.readFileSync(LICENSE_PATH, 'utf8');
    const data = JSON.parse(raw);

    const hasProShape = (data.plan === 'pro' || data.plan === 'lifetime') && data.status === 'active';
    return {
      plan: data.plan || 'free',
      isPro: false,
      status: hasProShape ? 'unverified' : data.status || 'unknown',
      expiresAt: data.expiresAt || null,
      licenseKey: null,
      verified: false,
    };
  } catch {
    return { plan: 'free', isPro: false, status: 'error' };
  }
}

module.exports = {
  getLicenseStatus,
  LICENSE_PATH,
};
