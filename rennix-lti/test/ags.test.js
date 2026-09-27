// End-to-end coverage for Assignment and Grade Services: a fake "platform"
// HTTP server plays the token endpoint (service-token exchange, reused from
// NRPS), the lineitems collection endpoint, and per-lineitem scores
// endpoints, so we can assert on exactly what gets sent.

const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_PATH = path.join(os.tmpdir(), `lti-ags-test-${crypto.randomBytes(6).toString('hex')}.db`);
process.env.ADMIN_SECRET = 'test-admin-secret';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.LTI_BRIDGE_SECRET = 'test-bridge-secret';
process.env.TENANT_ADMIN_SECRET = 'test-tenant-admin-secret';
// Closed local port, not a fake domain -- with TENANT_ADMIN_SECRET set (needed
// for /ags/score auth below), every launch's getOrAllocateUserId also tries
// findExistingUserIdByEmail against APP_BASE_URL; a closed port fails via
// ECONNREFUSED near-instantly, instead of waiting on a real DNS lookup for a
// domain that doesn't exist.
process.env.APP_BASE_URL = 'http://127.0.0.1:1';

const { SignJWT, generateKeyPair, exportJWK } = require('jose');
const { registerPlatform, getPlatform, db } = require('../src/db');
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

let capturedScoresRequests = []; // { path, headers, body }
let capturedLineitemsRequests = [];
const createdLineItemPath = '/lineitem-created';

before(async () => {
  appServer = http.createServer(app);
  appPort = await listen(appServer);

  const keyPair = await generateKeyPair('RS256', { extractable: true });
  privateKey = keyPair.privateKey;
  publicJwk = await exportJWK(keyPair.publicKey);
  publicJwk.alg = 'RS256'; publicJwk.use = 'sig'; publicJwk.kid = KID;

  platformServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString();
      if (req.url === '/jwks') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ keys: [publicJwk] }));
      } else if (req.url === '/token') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: 'fake-service-token', expires_in: 3600 }));
      } else if (req.url === '/lineitems') {
        capturedLineitemsRequests.push({ headers: req.headers, body: JSON.parse(bodyText) });
        res.setHeader('Content-Type', 'application/json');
        // Real Moodle returns a lineitem id/URL carrying its own query
        // string (e.g. `?type_id=1`) -- regression coverage for a bug found
        // via real-Moodle testing where `/scores` was naively concatenated
        // onto the end, landing after the query string instead of extending
        // the path.
        res.end(JSON.stringify({ id: `http://127.0.0.1:${platformPort}${createdLineItemPath}?type_id=1` }));
      } else if (req.url.startsWith(`${createdLineItemPath}/scores`) || req.url.endsWith('/scores')) {
        capturedScoresRequests.push({ path: req.url, headers: req.headers, body: JSON.parse(bodyText) });
        res.statusCode = 200;
        res.end('{}');
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

beforeEach(() => {
  capturedScoresRequests = [];
  capturedLineitemsRequests = [];
});

async function registerFakePlatform(clientId, tenantKey) {
  registerPlatform({
    product: 'tutor_bot', tenantKey, tenantName: tenantKey,
    issuer: `http://127.0.0.1:${platformPort}`, clientId, deploymentId: 'deploy-1',
    authLoginUrl: `http://127.0.0.1:${platformPort}/auth`, authTokenUrl: `http://127.0.0.1:${platformPort}/token`,
    jwksUrl: `http://127.0.0.1:${platformPort}/jwks`,
  });
  return getPlatform({ issuer: `http://127.0.0.1:${platformPort}`, clientId });
}

async function launch(platform, { resourceLinkId, agsClaim, userid }) {
  const loginQs = new URLSearchParams({ iss: platform.issuer, login_hint: 'x', target_link_uri: `${platform.issuer}/x`, client_id: platform.client_id });
  const loginRes = await request({ port: appPort, method: 'GET', path: `/lti/login?${loginQs}` });
  const loc = new URL(loginRes.headers.location);
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    nonce: loc.searchParams.get('nonce'), sub: userid, name: 'U', email: `${userid}@x.com`,
    'https://purl.imsglobal.org/spec/lti/claim/message_type': 'LtiResourceLinkRequest',
    'https://purl.imsglobal.org/spec/lti/claim/version': '1.3.0',
    'https://purl.imsglobal.org/spec/lti/claim/deployment_id': 'deploy-1',
    'https://purl.imsglobal.org/spec/lti/claim/roles': ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
    'https://purl.imsglobal.org/spec/lti/claim/context': { id: 'c1' },
    'https://purl.imsglobal.org/spec/lti/claim/resource_link': { id: resourceLinkId },
  };
  if (agsClaim) claims['https://purl.imsglobal.org/spec/lti-ags/claim/endpoint'] = agsClaim;
  const idToken = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: KID }).setIssuer(platform.issuer).setAudience(platform.client_id)
    .setIssuedAt(now).setExpirationTime(now + 300).sign(privateKey);
  return request({ port: appPort, method: 'POST', path: '/lti/launch', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_token: idToken, state: loc.searchParams.get('state') }) });
}

// The LTI `sub` claim used as `launch()`'s `userid` is the platform's own
// opaque subject, not tutor-service's internal integer id -- getOrAllocateUserId
// (src/db.js) allocates and stores that separately, keyed by subject, in
// lti_user_map. /ags/score's userid param is the tutor-service one, so tests
// that push a score for a student who really did launch need to resolve it
// back out rather than reusing the subject string.
function allocatedUserId(tenantKey, issuer, subject) {
  const row = db.prepare('SELECT userid FROM lti_user_map WHERE tenant_key = ? AND platform_issuer = ? AND subject = ?').get(tenantKey, issuer, subject);
  return row && row.userid;
}

function pushScore({ tenant, userid, resourceLinkId, score, scoreMaximum, secret }) {
  const body = JSON.stringify({ tenant, userid, resourceLinkId, score, scoreMaximum });
  return request({
    port: appPort, method: 'POST', path: '/ags/score',
    headers: { 'Content-Type': 'application/json', ...(secret !== undefined ? { 'x-tenant-admin-secret': secret } : {}) },
    body,
  });
}

test('a launch with an AGS endpoint claim (direct lineitem) creates an ags_lineitems row', async () => {
  const platform = await registerFakePlatform('ags-client-1', 'ags-tenant-1');
  const res = await launch(platform, {
    resourceLinkId: 'rl-with-lineitem', userid: 'student-1',
    agsClaim: { scope: ['https://purl.imsglobal.org/spec/lti-ags/scope/score'], lineitem: `http://127.0.0.1:${platformPort}/lineitem-fixed` },
  });
  assert.equal(res.statusCode, 303);
  const row = db.prepare('SELECT * FROM ags_lineitems WHERE resource_link_id = ?').get('rl-with-lineitem');
  assert.ok(row);
  assert.equal(row.lineitem_url, `http://127.0.0.1:${platformPort}/lineitem-fixed`);
  assert.equal(row.tenant_key, 'ags-tenant-1');
});

test('a launch without an AGS claim leaves no row, and a score push against it 404s', async () => {
  const platform = await registerFakePlatform('ags-client-2', 'ags-tenant-2');
  const res = await launch(platform, { resourceLinkId: 'rl-no-ags', userid: 'student-2' });
  assert.equal(res.statusCode, 303);
  const row = db.prepare('SELECT * FROM ags_lineitems WHERE resource_link_id = ?').get('rl-no-ags');
  assert.equal(row, undefined);

  const pushRes = await pushScore({ tenant: 'ags-tenant-2', userid: 'student-2', resourceLinkId: 'rl-no-ags', score: 5, scoreMaximum: 10, secret: process.env.TENANT_ADMIN_SECRET });
  assert.equal(pushRes.statusCode, 404);
});

test('POST /ags/score with an existing lineitem_url pushes directly, no line-item creation', async () => {
  const platform = await registerFakePlatform('ags-client-3', 'ags-tenant-3');
  await launch(platform, {
    resourceLinkId: 'rl-direct', userid: 'student-3',
    agsClaim: { scope: [], lineitem: `http://127.0.0.1:${platformPort}/lineitem-fixed` },
  });
  const userid = allocatedUserId('ags-tenant-3', platform.issuer, 'student-3');
  assert.ok(userid, 'expected the launch to have allocated a userid');

  const res = await pushScore({ tenant: 'ags-tenant-3', userid, resourceLinkId: 'rl-direct', score: 8, scoreMaximum: 10, secret: process.env.TENANT_ADMIN_SECRET });
  assert.equal(res.statusCode, 200);
  assert.equal(capturedLineitemsRequests.length, 0);
  assert.equal(capturedScoresRequests.length, 1);
  assert.equal(capturedScoresRequests[0].path, '/lineitem-fixed/scores');
  assert.equal(capturedScoresRequests[0].headers.authorization, 'Bearer fake-service-token');
  assert.equal(capturedScoresRequests[0].body.userId, 'student-3');
  assert.equal(capturedScoresRequests[0].body.scoreGiven, 8);
  assert.equal(capturedScoresRequests[0].body.scoreMaximum, 10);
  assert.equal(capturedScoresRequests[0].body.gradingProgress, 'FullyGraded');
});

test('POST /ags/score with only a lineitems collection URL auto-creates a line item once, then reuses it', async () => {
  const platform = await registerFakePlatform('ags-client-4', 'ags-tenant-4');
  await launch(platform, {
    resourceLinkId: 'rl-lazy', userid: 'student-4',
    agsClaim: { scope: [], lineitems: `http://127.0.0.1:${platformPort}/lineitems` },
  });
  const userid = allocatedUserId('ags-tenant-4', platform.issuer, 'student-4');

  const first = await pushScore({ tenant: 'ags-tenant-4', userid, resourceLinkId: 'rl-lazy', score: 3, scoreMaximum: 10, secret: process.env.TENANT_ADMIN_SECRET });
  assert.equal(first.statusCode, 200);
  assert.equal(capturedLineitemsRequests.length, 1, 'expected exactly one line item creation call');
  assert.equal(capturedScoresRequests.length, 1);
  // Regression: /scores must extend the path, not land after the lineitem
  // URL's own query string.
  assert.equal(capturedScoresRequests[0].path, `${createdLineItemPath}/scores?type_id=1`);

  const row = db.prepare('SELECT lineitem_url FROM ags_lineitems WHERE resource_link_id = ?').get('rl-lazy');
  assert.equal(row.lineitem_url, `http://127.0.0.1:${platformPort}${createdLineItemPath}?type_id=1`);

  const second = await pushScore({ tenant: 'ags-tenant-4', userid, resourceLinkId: 'rl-lazy', score: 7, scoreMaximum: 10, secret: process.env.TENANT_ADMIN_SECRET });
  assert.equal(second.statusCode, 200);
  assert.equal(capturedLineitemsRequests.length, 1, 'a second push must not create a second line item');
  assert.equal(capturedScoresRequests.length, 2);
});

test('missing or wrong x-tenant-admin-secret is rejected', async () => {
  const platform = await registerFakePlatform('ags-client-5', 'ags-tenant-5');
  await launch(platform, { resourceLinkId: 'rl-auth', userid: 'student-5', agsClaim: { scope: [], lineitem: `http://127.0.0.1:${platformPort}/lineitem-fixed` } });

  const noSecret = await pushScore({ tenant: 'ags-tenant-5', userid: 'student-5', resourceLinkId: 'rl-auth', score: 1, scoreMaximum: 10 });
  assert.equal(noSecret.statusCode, 401);
  const wrongSecret = await pushScore({ tenant: 'ags-tenant-5', userid: 'student-5', resourceLinkId: 'rl-auth', score: 1, scoreMaximum: 10, secret: 'wrong' });
  assert.equal(wrongSecret.statusCode, 401);
});

test('a student who never launched has no subject to attribute the score to', async () => {
  const platform = await registerFakePlatform('ags-client-6', 'ags-tenant-6');
  await launch(platform, { resourceLinkId: 'rl-unlaunched-student', userid: 'student-who-launched', agsClaim: { scope: [], lineitem: `http://127.0.0.1:${platformPort}/lineitem-fixed` } });

  const res = await pushScore({ tenant: 'ags-tenant-6', userid: 'someone-else-entirely', resourceLinkId: 'rl-unlaunched-student', score: 1, scoreMaximum: 10, secret: process.env.TENANT_ADMIN_SECRET });
  assert.equal(res.statusCode, 400);
});

test('a tenant mismatch is rejected', async () => {
  const platform = await registerFakePlatform('ags-client-7', 'ags-tenant-7');
  await launch(platform, { resourceLinkId: 'rl-tenant-check', userid: 'student-7', agsClaim: { scope: [], lineitem: `http://127.0.0.1:${platformPort}/lineitem-fixed` } });

  const res = await pushScore({ tenant: 'some-other-tenant', userid: 'student-7', resourceLinkId: 'rl-tenant-check', score: 1, scoreMaximum: 10, secret: process.env.TENANT_ADMIN_SECRET });
  assert.equal(res.statusCode, 403);
});
