// End-to-end coverage for the LTI 1.3 launch flow: a fake "platform" (its own
// RSA key pair + a local JWKS endpoint we control) drives real /lti/login and
// /lti/launch requests against the real Express app. This is also the
// regression test for the JWKS-caching fix (src/lti/platformJwks.js): the
// JWKS endpoint must only be hit once across many launches of the same
// platform, not once per launch.

const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_PATH = path.join(os.tmpdir(), `lti-test-${crypto.randomBytes(6).toString('hex')}.db`);
process.env.ADMIN_SECRET = 'test-admin-secret';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.LTI_BRIDGE_SECRET = 'test-bridge-secret';
process.env.APP_BASE_URL = 'https://app.test';
delete process.env.TENANT_ADMIN_SECRET; // keeps getOrAllocateUserId/NRPS paths from making real network calls

const { SignJWT, generateKeyPair, exportJWK } = require('jose');
const { registerPlatform, getPlatform, setPlatformActive, addDeployment } = require('../src/db');
const app = require('../server');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Raw http.request instead of fetch -- fetch's `redirect: 'manual'` returns a
// spec-compliant "opaque redirect" filtered response (status 0, no headers
// readable), which is useless for asserting on our own Location header.
// http.request never follows redirects itself, so it always hands back the
// real status/headers.
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
let jwksServer, jwksPort, jwksHitCount = 0;
let privateKey, publicJwk;
const KID = 'test-platform-key';

let tutorBotPlatform, analyticsPlatform;

before(async () => {
  appServer = http.createServer(app);
  appPort = await listen(appServer);

  const keyPair = await generateKeyPair('RS256', { extractable: true });
  privateKey = keyPair.privateKey;
  publicJwk = await exportJWK(keyPair.publicKey);
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  publicJwk.kid = KID;

  jwksServer = http.createServer((req, res) => {
    jwksHitCount += 1;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  jwksPort = await listen(jwksServer);

  registerPlatform({
    product: 'tutor_bot',
    tenantKey: 'test-tenant',
    tenantName: 'Test Tenant',
    issuer: 'https://issuer.test',
    clientId: 'client-tutor-bot',
    deploymentId: 'deploy-1',
    authLoginUrl: 'https://issuer.test/auth',
    jwksUrl: `http://127.0.0.1:${jwksPort}/jwks`,
  });
  tutorBotPlatform = getPlatform({ issuer: 'https://issuer.test', clientId: 'client-tutor-bot' });

  registerPlatform({
    product: 'analytics',
    tenantKey: 'test-tenant',
    tenantName: 'Test Tenant',
    issuer: 'https://issuer.test',
    clientId: 'client-analytics',
    deploymentId: 'deploy-2',
    authLoginUrl: 'https://issuer.test/auth',
    jwksUrl: `http://127.0.0.1:${jwksPort}/jwks`,
  });
  analyticsPlatform = getPlatform({ issuer: 'https://issuer.test', clientId: 'client-analytics' });
});

after(async () => {
  await new Promise((resolve) => appServer.close(resolve));
  await new Promise((resolve) => jwksServer.close(resolve));
});

// Drives GET /lti/login for the given platform and returns the {state, nonce}
// pair the server minted, read straight off the redirect Location header.
async function startLogin(platform) {
  const qs = new URLSearchParams({
    iss: platform.issuer,
    login_hint: 'fake-login-hint',
    target_link_uri: 'https://issuer.test/mod/lti/view.php?id=1',
    client_id: platform.client_id,
  });
  const res = await request({ port: appPort, method: 'GET', path: `/lti/login?${qs}` });
  assert.equal(res.statusCode, 302);
  const location = new URL(res.headers.location);
  return { state: location.searchParams.get('state'), nonce: location.searchParams.get('nonce') };
}

function buildIdToken(platform, { nonce, deploymentId, roles, messageType, version, custom }) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    nonce,
    sub: 'test-user-sub',
    name: 'Test User',
    email: 'test-user@example.com',
    'https://purl.imsglobal.org/spec/lti/claim/message_type': messageType ?? 'LtiResourceLinkRequest',
    'https://purl.imsglobal.org/spec/lti/claim/version': version ?? '1.3.0',
    'https://purl.imsglobal.org/spec/lti/claim/deployment_id': deploymentId ?? platform.deployment_id,
    'https://purl.imsglobal.org/spec/lti/claim/roles': roles ?? ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
    'https://purl.imsglobal.org/spec/lti/claim/context': { id: 'course-1', title: 'Test Course', label: 'TC101' },
    'https://purl.imsglobal.org/spec/lti/claim/resource_link': { id: 'rl-1' },
    ...(custom ? { 'https://purl.imsglobal.org/spec/lti/claim/custom': custom } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(platform.issuer)
    .setAudience(platform.client_id)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

async function launch(platform, idToken, state) {
  return request({
    port: appPort,
    method: 'POST',
    path: '/lti/launch',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id_token: idToken, state }),
  });
}

test('valid student launch redirects into the app with a bridge token', async () => {
  const { state, nonce } = await startLogin(tutorBotPlatform);
  const idToken = await buildIdToken(tutorBotPlatform, { nonce });
  const res = await launch(tutorBotPlatform, idToken, state);
  assert.equal(res.statusCode, 303);
  const dest = new URL(res.headers.location);
  assert.equal(dest.origin + dest.pathname, 'https://app.test/app/home');
  assert.ok(dest.searchParams.get('t'), 'expected a bridge token in the redirect');
});

test('valid instructor launch redirects to the instructor app', async () => {
  const { state, nonce } = await startLogin(tutorBotPlatform);
  const idToken = await buildIdToken(tutorBotPlatform, {
    nonce,
    roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'],
  });
  const res = await launch(tutorBotPlatform, idToken, state);
  assert.equal(res.statusCode, 303);
  const dest = new URL(res.headers.location);
  assert.equal(dest.origin + dest.pathname, 'https://app.test/app/instructor');
});

test('the bridge token carries display-only course title/code and school name', async () => {
  const { state, nonce } = await startLogin(tutorBotPlatform);
  const res = await launch(tutorBotPlatform, await buildIdToken(tutorBotPlatform, { nonce }), state);
  const token = new URL(res.headers.location).searchParams.get('t');
  const claims = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
  assert.equal(claims.courseTitle, 'Test Course');
  assert.equal(claims.courseLabel, 'TC101');
  assert.equal(claims.tenantName, 'Test Tenant');
});

test('a rennix_view=chat launch (video side panel) lands on the chat panel, for students and instructors', async () => {
  for (const roles of [undefined, ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor']]) {
    const { state, nonce } = await startLogin(tutorBotPlatform);
    const idToken = await buildIdToken(tutorBotPlatform, { nonce, roles, custom: { rennix_view: 'chat' } });
    const res = await launch(tutorBotPlatform, idToken, state);
    assert.equal(res.statusCode, 303);
    const dest = new URL(res.headers.location);
    assert.equal(dest.origin + dest.pathname, 'https://app.test/widget/course/chat');
    assert.ok(dest.searchParams.get('t'));
  }
});

test('rennix_view=chat is ignored for the Analytics product', async () => {
  const { state, nonce } = await startLogin(analyticsPlatform);
  const idToken = await buildIdToken(analyticsPlatform, {
    nonce, roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'], custom: { rennix_view: 'chat' },
  });
  const res = await launch(analyticsPlatform, idToken, state);
  assert.equal(new URL(res.headers.location).pathname, '/app/instructor');
});

test('nonce mismatch is rejected', async () => {
  const { state } = await startLogin(tutorBotPlatform);
  const idToken = await buildIdToken(tutorBotPlatform, { nonce: 'wrong-nonce' });
  const res = await launch(tutorBotPlatform, idToken, state);
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /Nonce mismatch/);
});

test('wrong deployment_id is rejected', async () => {
  const { state, nonce } = await startLogin(tutorBotPlatform);
  const idToken = await buildIdToken(tutorBotPlatform, { nonce, deploymentId: 'not-the-real-deployment' });
  const res = await launch(tutorBotPlatform, idToken, state);
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /Deployment ID does not match/);
});

test('a second deployment_id added via addDeployment is accepted (multi-deployment support)', async () => {
  addDeployment(tutorBotPlatform.id, 'second-deployment');
  const { state, nonce } = await startLogin(tutorBotPlatform);
  const idToken = await buildIdToken(tutorBotPlatform, { nonce, deploymentId: 'second-deployment' });
  const res = await launch(tutorBotPlatform, idToken, state);
  assert.equal(res.statusCode, 303);

  // A third, still-unregistered id must still be rejected -- adding one
  // deployment doesn't open the door to arbitrary ones.
  const { state: state2, nonce: nonce2 } = await startLogin(tutorBotPlatform);
  const idToken2 = await buildIdToken(tutorBotPlatform, { nonce: nonce2, deploymentId: 'still-unknown' });
  const res2 = await launch(tutorBotPlatform, idToken2, state2);
  assert.equal(res2.statusCode, 400);
});

test('a state can only be used once (replay of the same state fails)', async () => {
  const { state, nonce } = await startLogin(tutorBotPlatform);
  const idToken = await buildIdToken(tutorBotPlatform, { nonce });
  const first = await launch(tutorBotPlatform, idToken, state);
  assert.equal(first.statusCode, 303);
  const second = await launch(tutorBotPlatform, idToken, state);
  assert.equal(second.statusCode, 400);
  assert.match(second.body, /Unknown or expired state/);
});

test('a deactivated platform rejects /lti/login as an unknown platform', async () => {
  registerPlatform({
    product: 'tutor_bot',
    tenantKey: 'deactivated-tenant',
    tenantName: 'Deactivated Tenant',
    issuer: 'https://deactivated.test',
    clientId: 'client-deactivated',
    deploymentId: 'deploy-deactivated',
    authLoginUrl: 'https://deactivated.test/auth',
    jwksUrl: `http://127.0.0.1:${jwksPort}/jwks`,
  });
  const platform = getPlatform({ issuer: 'https://deactivated.test', clientId: 'client-deactivated' });
  setPlatformActive(platform.id, false);

  const qs = new URLSearchParams({
    iss: 'https://deactivated.test',
    login_hint: 'fake-login-hint',
    target_link_uri: 'https://deactivated.test/mod/lti/view.php?id=1',
    client_id: 'client-deactivated',
  });
  const res = await request({ port: appPort, method: 'GET', path: `/lti/login?${qs}` });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /Unknown platform/);
});

test('analytics product blocks a student-role launch with 403', async () => {
  const { state, nonce } = await startLogin(analyticsPlatform);
  const idToken = await buildIdToken(analyticsPlatform, { nonce });
  const res = await launch(analyticsPlatform, idToken, state);
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /Instructor access only/);
});

test('analytics product allows an instructor-role launch', async () => {
  const { state, nonce } = await startLogin(analyticsPlatform);
  const idToken = await buildIdToken(analyticsPlatform, {
    nonce,
    roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'],
  });
  const res = await launch(analyticsPlatform, idToken, state);
  assert.equal(res.statusCode, 303);
});

test('the platform JWKS endpoint is only fetched once per platform, not once per launch (caching fix)', () => {
  // Seven launches attempted above, against two distinct platforms (tutor_bot
  // and analytics) that happen to share one JWKS URL. The cache is keyed by
  // platform id, so this must be exactly 2 -- one fetch per platform -- not 7.
  // Before the fix, every successful verification would have caused its own
  // fetch regardless of platform, i.e. 5.
  assert.equal(jwksHitCount, 2, `expected exactly 2 JWKS fetches (one per platform), got ${jwksHitCount}`);
});
