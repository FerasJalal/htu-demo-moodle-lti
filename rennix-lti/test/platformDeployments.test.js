const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_PATH = path.join(os.tmpdir(), `lti-deployments-test-${crypto.randomBytes(6).toString('hex')}.db`);

const { db, registerPlatform, getPlatform, isKnownDeployment, addDeployment } = require('../src/db');

test('registerPlatform seeds platform_deployments with the registered deployment_id', () => {
  registerPlatform({
    product: 'tutor_bot',
    tenantKey: 'deploy-tenant',
    tenantName: 'Deploy Tenant',
    issuer: 'https://deploy.test',
    clientId: 'deploy-client',
    deploymentId: 'deploy-1',
    authLoginUrl: 'https://deploy.test/auth',
    jwksUrl: 'https://deploy.test/jwks',
  });
  const platform = getPlatform({ issuer: 'https://deploy.test', clientId: 'deploy-client' });
  assert.ok(platform);
  assert.equal(isKnownDeployment(platform.id, 'deploy-1'), true);
  assert.equal(isKnownDeployment(platform.id, 'not-registered'), false);
});

test('addDeployment adds an additional deployment id without disturbing the first', () => {
  const platform = getPlatform({ issuer: 'https://deploy.test', clientId: 'deploy-client' });
  addDeployment(platform.id, 'deploy-2');
  assert.equal(isKnownDeployment(platform.id, 'deploy-1'), true);
  assert.equal(isKnownDeployment(platform.id, 'deploy-2'), true);
  assert.equal(isKnownDeployment(platform.id, 'deploy-3'), false);
});

test('addDeployment is idempotent (adding the same id twice does not throw or duplicate)', () => {
  const platform = getPlatform({ issuer: 'https://deploy.test', clientId: 'deploy-client' });
  addDeployment(platform.id, 'deploy-2');
  addDeployment(platform.id, 'deploy-2');
  const count = db.prepare('SELECT COUNT(*) AS c FROM platform_deployments WHERE platform_id = ? AND deployment_id = ?')
    .get(platform.id, 'deploy-2').c;
  assert.equal(count, 1);
});

test('the startup backfill covers a platform row inserted directly (simulating a pre-existing DB)', () => {
  // Insert a platforms row the way an old, pre-platform_deployments version
  // of this code would have (no platform_deployments write at all), then
  // re-run the exact backfill statement db.js runs on every boot.
  const now = Date.now();
  db.prepare(`INSERT INTO platforms (product, tenant_key, tenant_name, issuer, client_id, deployment_id, auth_login_url, jwks_url, created_at)
    VALUES ('tutor_bot', 'legacy-tenant', 'Legacy Tenant', 'https://legacy.test', 'legacy-client', 'legacy-deploy', 'https://legacy.test/auth', 'https://legacy.test/jwks', ?)`).run(now);
  const legacyPlatform = getPlatform({ issuer: 'https://legacy.test', clientId: 'legacy-client' });
  assert.equal(isKnownDeployment(legacyPlatform.id, 'legacy-deploy'), false, 'sanity check: not backfilled yet');

  db.exec(`INSERT OR IGNORE INTO platform_deployments (platform_id, deployment_id, created_at) SELECT id, deployment_id, created_at FROM platforms`);

  assert.equal(isKnownDeployment(legacyPlatform.id, 'legacy-deploy'), true);
});
