'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function loadLicenseModuleWithHome(home) {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const modulePath = require.resolve('../scripts/lib/license');
  delete require.cache[modulePath];
  return require('../scripts/lib/license');
}

test('unsigned local pro license files are not treated as active Pro', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'contextguard-license-'));
  const { getLicenseStatus, LICENSE_PATH } = loadLicenseModuleWithHome(tmpHome);
  fs.mkdirSync(path.dirname(LICENSE_PATH), { recursive: true });
  fs.writeFileSync(
    LICENSE_PATH,
    JSON.stringify({ plan: 'pro', status: 'active', licenseKey: 'cg_lic_fake' }),
    'utf8',
  );

  const status = getLicenseStatus();

  assert.equal(status.isPro, false);
  assert.equal(status.status, 'unverified');
  assert.equal(status.licenseKey, null);
});
