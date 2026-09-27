const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_PATH = path.join(os.tmpdir(), `lti-edit-test-${crypto.randomBytes(6).toString('hex')}.db`);

const { db, registerPlatform, updatePlatform, getPlatform } = require('../src/db');

const PLATFORM = {
  product: 'tutor_bot',
  tenantKey: 'edit-tenant',
  tenantName: 'Edit Tenant',
  issuer: 'https://edit.test',
  clientId: 'edit-client',
  deploymentId: 'edit-deploy',
  authLoginUrl: 'https://edit.test/mod/lti/auth.php',
  jwksUrl: 'https://edit.test/mod/lti/certs.php',
};

test('manual registration stores the access token URL when given', () => {
  const id = registerPlatform({ ...PLATFORM, clientId: 'with-token', authTokenUrl: 'https://edit.test/mod/lti/token.php' });
  const row = db.prepare('SELECT auth_token_url FROM platforms WHERE id = ?').get(id);
  assert.equal(row.auth_token_url, 'https://edit.test/mod/lti/token.php');
});

test('updatePlatform fills in a missing token URL and reports what changed', () => {
  const id = registerPlatform(PLATFORM);
  assert.equal(db.prepare('SELECT auth_token_url FROM platforms WHERE id = ?').get(id).auth_token_url, null);
  const { platform, changed } = updatePlatform(id, { authTokenUrl: 'https://edit.test/mod/lti/token.php' });
  assert.equal(platform.auth_token_url, 'https://edit.test/mod/lti/token.php');
  assert.deepEqual(changed, ['auth_token_url']);
  // untouched fields keep their values
  assert.equal(platform.issuer, PLATFORM.issuer);
  assert.equal(platform.tenant_key, PLATFORM.tenantKey);
});

test('updatePlatform can fix a typo in the client ID, and launches find it under the new one', () => {
  const id = registerPlatform({ ...PLATFORM, clientId: 'typo-clent' });
  updatePlatform(id, { clientId: 'typo-client' });
  assert.equal(getPlatform({ issuer: PLATFORM.issuer, clientId: 'typo-clent' }), undefined);
  assert.equal(getPlatform({ issuer: PLATFORM.issuer, clientId: 'typo-client' }).id, id);
});

test('a blank token URL clears it (disables roster sync / grade push)', () => {
  const id = registerPlatform({ ...PLATFORM, clientId: 'clear-token', authTokenUrl: 'https://edit.test/mod/lti/token.php' });
  const { platform } = updatePlatform(id, { authTokenUrl: '  ' });
  assert.equal(platform.auth_token_url, null);
});

test('updatePlatform rejects missing required fields, non-URLs, and issuer/client ID clashes', () => {
  const id = registerPlatform({ ...PLATFORM, clientId: 'validate-me' });
  assert.throws(() => updatePlatform(id, { issuer: '' }), /Missing fields: issuer/);
  assert.throws(() => updatePlatform(id, { jwksUrl: 'not a url' }), /jwksUrl must be an http\(s\) URL/);
  registerPlatform({ ...PLATFORM, clientId: 'taken' });
  assert.throws(() => updatePlatform(id, { clientId: 'taken' }), /already registered/);
  assert.throws(() => updatePlatform(999999, { tenantName: 'x' }), /not found/);
});

test('tenant key and product cannot be changed through updatePlatform', () => {
  const id = registerPlatform({ ...PLATFORM, clientId: 'fixed-tenant' });
  const { platform } = updatePlatform(id, { tenantKey: 'someone-else', product: 'analytics', tenantName: 'Renamed' });
  assert.equal(platform.tenant_key, PLATFORM.tenantKey);
  assert.equal(platform.product, 'tutor_bot');
  assert.equal(platform.tenant_name, 'Renamed');
});
