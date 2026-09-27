// End-to-end coverage for the Dynamic Registration flow: a fake "platform"
// HTTP server plays both the openid_configuration/registration_endpoint side
// (registration itself has no signed token -- it's the initial trust
// hand-off) and, for the auto-discovery cases, the same signed-JWT launch
// path test/lti-launch.test.js exercises.

const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_PATH = path.join(os.tmpdir(), `lti-dynreg-test-${crypto.randomBytes(6).toString('hex')}.db`);
process.env.ADMIN_SECRET = 'test-admin-secret';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.LTI_BRIDGE_SECRET = 'test-bridge-secret';
process.env.APP_BASE_URL = 'https://app.test';
delete process.env.TENANT_ADMIN_SECRET;

const { SignJWT, generateKeyPair, exportJWK } = require('jose');
const { getPlatform, isKnownDeployment } = require('../src/db');
const app = require('../server');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request({ port, method, path: reqPath, body, headers }) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(body) : null;
    const req = http.request(
      { hostname: '127.0.0.1', port, method, path: reqPath, headers: { ...headers, ...(data ? { 'Content-Length': data.length } : {}) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let appServer, appPort;
let platformServer, platformPort;
let privateKey, publicJwk;
const KID = 'fake-platform-key';

// Mutable per-test controls the fake platform's /registration endpoint reads.
let registrationBehavior = { includeDeploymentId: true, fail: false };
let lastRegistrationRequest = null;

before(async () => {
  appServer = http.createServer(app);
  appPort = await listen(appServer);

  const keyPair = await generateKeyPair('RS256', { extractable: true });
  privateKey = keyPair.privateKey;
  publicJwk = await exportJWK(keyPair.publicKey);
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  publicJwk.kid = KID;

  platformServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString();
      if (req.url === '/openid-configuration') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          issuer: `http://127.0.0.1:${platformPort}`,
          authorization_endpoint: `http://127.0.0.1:${platformPort}/auth`,
          token_endpoint: `http://127.0.0.1:${platformPort}/token`,
          registration_endpoint: `http://127.0.0.1:${platformPort}/registration`,
          jwks_uri: `http://127.0.0.1:${platformPort}/jwks`,
        }));
      } else if (req.url === '/jwks') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ keys: [publicJwk] }));
      } else if (req.url === '/registration') {
        lastRegistrationRequest = { headers: req.headers, body: JSON.parse(bodyText) };
        if (registrationBehavior.fail) {
          res.statusCode = 401;
          res.end('registration_token invalid');
          return;
        }
        const clientId = `dyn-client-${crypto.randomBytes(4).toString('hex')}`;
        const response = { client_id: clientId };
        if (registrationBehavior.includeDeploymentId) {
          response['https://purl.imsglobal.org/spec/lti-tool-configuration'] = { deployment_id: 'platform-issued-deployment' };
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(response));
      } else {
        res.statusCode = 404;
        res.end('not found');
      }
    });
  });
  platformPort = await listen(platformServer);
});

after(async () => {
  await new Promise((resolve) => appServer.close(resolve));
  await new Promise((resolve) => platformServer.close(resolve));
});

function extractSessionId(html) {
  const m = html.match(/name="session" value="([a-f0-9]+)"/);
  return m && m[1];
}

test('GET /lti/register without openid_configuration returns 400', async () => {
  const res = await request({ port: appPort, method: 'GET', path: '/lti/register' });
  assert.equal(res.statusCode, 400);
});

test('GET /lti/register with a valid openid_configuration renders the product/tenant picker', async () => {
  const qs = new URLSearchParams({ openid_configuration: `http://127.0.0.1:${platformPort}/openid-configuration`, registration_token: 'reg-tok-123' });
  const res = await request({ port: appPort, method: 'GET', path: `/lti/register?${qs}` });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /name="tenantKey"/);
  assert.ok(extractSessionId(res.body));
});

test('completing registration POSTs the expected shape to the platform and includes the bearer token', async () => {
  registrationBehavior = { includeDeploymentId: true, fail: false };
  const qs = new URLSearchParams({ openid_configuration: `http://127.0.0.1:${platformPort}/openid-configuration`, registration_token: 'reg-tok-123' });
  const pickerRes = await request({ port: appPort, method: 'GET', path: `/lti/register?${qs}` });
  const sessionId = extractSessionId(pickerRes.body);

  const completeBody = new URLSearchParams({ session: sessionId, product: 'tutor_bot', tenantKey: 'dynreg-tenant', tenantName: 'DynReg Tenant' }).toString();
  const completeRes = await request({
    port: appPort, method: 'POST', path: '/lti/register/complete',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: completeBody,
  });
  assert.equal(completeRes.statusCode, 200);
  assert.match(completeRes.body, /org\.imsglobal\.lti\.close/);

  assert.ok(lastRegistrationRequest);
  assert.equal(lastRegistrationRequest.headers.authorization, 'Bearer reg-tok-123');
  const sent = lastRegistrationRequest.body;
  assert.deepEqual(sent.redirect_uris, [`http://127.0.0.1:${appPort}/lti/launch`]);
  assert.equal(sent.initiate_login_uri, `http://127.0.0.1:${appPort}/lti/login`);
  assert.equal(sent.jwks_uri, `http://127.0.0.1:${appPort}/lti/jwks`);
  assert.equal(sent.token_endpoint_auth_method, 'private_key_jwt');
  assert.ok(sent['https://purl.imsglobal.org/spec/lti-tool-configuration']);

  const platform = getPlatform({ issuer: `http://127.0.0.1:${platformPort}`, clientId: lastRegistrationRequestClientId() });
  assert.ok(platform);
  assert.equal(platform.dynamic_registration, 1);
  assert.equal(platform.tenant_key, 'dynreg-tenant');
  assert.equal(isKnownDeployment(platform.id, 'platform-issued-deployment'), true);

  function lastRegistrationRequestClientId() {
    // The client_id isn't known ahead of the call (randomly generated by the
    // fake platform) -- recover it from the platform row we just registered
    // by tenant_key instead of re-deriving it.
    const { db } = require('../src/db');
    return db.prepare('SELECT client_id FROM platforms WHERE tenant_key = ?').get('dynreg-tenant').client_id;
  }
});

test('registration_token is omitted from the Authorization header when the platform did not provide one', async () => {
  registrationBehavior = { includeDeploymentId: true, fail: false };
  const qs = new URLSearchParams({ openid_configuration: `http://127.0.0.1:${platformPort}/openid-configuration` }); // no registration_token
  const pickerRes = await request({ port: appPort, method: 'GET', path: `/lti/register?${qs}` });
  const sessionId = extractSessionId(pickerRes.body);
  const completeBody = new URLSearchParams({ session: sessionId, product: 'tutor_bot', tenantKey: 'no-token-tenant', tenantName: 'No Token Tenant' }).toString();
  await request({ port: appPort, method: 'POST', path: '/lti/register/complete', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: completeBody });
  assert.equal(lastRegistrationRequest.headers.authorization, undefined);
});

test('a failed registration_endpoint call surfaces a clean error, not a crash', async () => {
  registrationBehavior = { includeDeploymentId: true, fail: true };
  const qs = new URLSearchParams({ openid_configuration: `http://127.0.0.1:${platformPort}/openid-configuration`, registration_token: 'bad-token' });
  const pickerRes = await request({ port: appPort, method: 'GET', path: `/lti/register?${qs}` });
  const sessionId = extractSessionId(pickerRes.body);
  const completeBody = new URLSearchParams({ session: sessionId, product: 'tutor_bot', tenantKey: 'fail-tenant', tenantName: 'Fail Tenant' }).toString();
  const res = await request({ port: appPort, method: 'POST', path: '/lti/register/complete', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: completeBody });
  assert.equal(res.statusCode, 502);
  registrationBehavior = { includeDeploymentId: true, fail: false };
});

test('a registration session can only be completed once', async () => {
  registrationBehavior = { includeDeploymentId: true, fail: false };
  const qs = new URLSearchParams({ openid_configuration: `http://127.0.0.1:${platformPort}/openid-configuration` });
  const pickerRes = await request({ port: appPort, method: 'GET', path: `/lti/register?${qs}` });
  const sessionId = extractSessionId(pickerRes.body);
  const completeBody = new URLSearchParams({ session: sessionId, product: 'tutor_bot', tenantKey: 'once-tenant', tenantName: 'Once Tenant' }).toString();
  const first = await request({ port: appPort, method: 'POST', path: '/lti/register/complete', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: completeBody });
  assert.equal(first.statusCode, 200);
  const second = await request({ port: appPort, method: 'POST', path: '/lti/register/complete', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: completeBody });
  assert.equal(second.statusCode, 400);
});

// ---- Auto-discovery: registration completes WITHOUT a deployment_id, then
// real launches carrying previously-unseen deployment_ids must still work. ----
test('auto-discovery: a dynamically-registered platform accepts previously-unseen deployment_ids', async () => {
  registrationBehavior = { includeDeploymentId: false, fail: false };
  const qs = new URLSearchParams({ openid_configuration: `http://127.0.0.1:${platformPort}/openid-configuration`, registration_token: 'auto-tok' });
  const pickerRes = await request({ port: appPort, method: 'GET', path: `/lti/register?${qs}` });
  const sessionId = extractSessionId(pickerRes.body);
  const completeBody = new URLSearchParams({ session: sessionId, product: 'tutor_bot', tenantKey: 'auto-tenant', tenantName: 'Auto Tenant' }).toString();
  const completeRes = await request({ port: appPort, method: 'POST', path: '/lti/register/complete', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: completeBody });
  assert.equal(completeRes.statusCode, 200);

  const { db } = require('../src/db');
  const platform = db.prepare('SELECT * FROM platforms WHERE tenant_key = ?').get('auto-tenant');
  assert.equal(platform.dynamic_registration, 1);
  assert.equal(isKnownDeployment(platform.id, 'never-seen-before'), false);

  async function startLogin() {
    const loginQs = new URLSearchParams({ iss: platform.issuer, login_hint: 'x', target_link_uri: `${platform.issuer}/x`, client_id: platform.client_id });
    const res = await request({ port: appPort, method: 'GET', path: `/lti/login?${loginQs}` });
    const loc = new URL(res.headers.location);
    return { state: loc.searchParams.get('state'), nonce: loc.searchParams.get('nonce') };
  }
  async function launchWith(deploymentId) {
    const { state, nonce } = await startLogin();
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({
      nonce, sub: 'u1', name: 'U', email: 'u@x.com',
      'https://purl.imsglobal.org/spec/lti/claim/message_type': 'LtiResourceLinkRequest',
      'https://purl.imsglobal.org/spec/lti/claim/version': '1.3.0',
      'https://purl.imsglobal.org/spec/lti/claim/deployment_id': deploymentId,
      'https://purl.imsglobal.org/spec/lti/claim/roles': ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
      'https://purl.imsglobal.org/spec/lti/claim/context': { id: 'c1' },
      'https://purl.imsglobal.org/spec/lti/claim/resource_link': { id: 'rl1' },
    }).setProtectedHeader({ alg: 'RS256', kid: KID }).setIssuer(platform.issuer).setAudience(platform.client_id)
      .setIssuedAt(now).setExpirationTime(now + 300).sign(privateKey);
    return request({ port: appPort, method: 'POST', path: '/lti/launch', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_token: idToken, state }) });
  }

  const r1 = await launchWith('never-seen-before');
  assert.equal(r1.statusCode, 303);
  assert.equal(isKnownDeployment(platform.id, 'never-seen-before'), true);

  const r2 = await launchWith('also-never-seen');
  assert.equal(r2.statusCode, 303, 'a second, different unseen deployment_id must also be accepted (open discovery, not first-one-only)');
});

test('scope boundary: a manually-registered platform still rejects unrecognized deployment_ids', async () => {
  const { registerPlatform } = require('../src/db');
  registerPlatform({
    product: 'tutor_bot', tenantKey: 'manual-boundary-tenant', tenantName: 'Manual Boundary',
    issuer: 'https://manual-boundary.test', clientId: 'manual-boundary-client', deploymentId: 'manual-deploy-1',
    authLoginUrl: 'https://manual-boundary.test/auth', jwksUrl: `http://127.0.0.1:${platformPort}/jwks`,
  });
  const platform = getPlatform({ issuer: 'https://manual-boundary.test', clientId: 'manual-boundary-client' });
  assert.equal(platform.dynamic_registration, 0);

  const loginQs = new URLSearchParams({ iss: platform.issuer, login_hint: 'x', target_link_uri: `${platform.issuer}/x`, client_id: platform.client_id });
  const loginRes = await request({ port: appPort, method: 'GET', path: `/lti/login?${loginQs}` });
  const loc = new URL(loginRes.headers.location);
  const now = Math.floor(Date.now() / 1000);
  const idToken = await new SignJWT({
    nonce: loc.searchParams.get('nonce'), sub: 'u1', name: 'U', email: 'u@x.com',
    'https://purl.imsglobal.org/spec/lti/claim/message_type': 'LtiResourceLinkRequest',
    'https://purl.imsglobal.org/spec/lti/claim/version': '1.3.0',
    'https://purl.imsglobal.org/spec/lti/claim/deployment_id': 'unrecognized-deployment',
    'https://purl.imsglobal.org/spec/lti/claim/roles': ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
    'https://purl.imsglobal.org/spec/lti/claim/context': { id: 'c1' },
    'https://purl.imsglobal.org/spec/lti/claim/resource_link': { id: 'rl1' },
  }).setProtectedHeader({ alg: 'RS256', kid: KID }).setIssuer(platform.issuer).setAudience(platform.client_id)
    .setIssuedAt(now).setExpirationTime(now + 300).sign(privateKey);
  const res = await request({ port: appPort, method: 'POST', path: '/lti/launch', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_token: idToken, state: loc.searchParams.get('state') }) });
  assert.equal(res.statusCode, 400);
});
