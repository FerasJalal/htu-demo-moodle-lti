// POST /lti/playback: an LMS-signed video-position report is verified against
// the platform's JWKS, mapped to the tenant's userid, and relayed to
// tutor-service. A fake platform (JWKS server) and a fake tutor-service
// (records relayed bodies) stand in for the real ones.
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { SignJWT, generateKeyPair, exportJWK } = require('jose');

process.env.DB_PATH = path.join(os.tmpdir(), `lti-playback-test-${crypto.randomBytes(6).toString('hex')}.db`);
process.env.TENANT_ADMIN_SECRET = 'test-tenant-admin-secret';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const ISSUER = 'https://moodle.playback.test';
const CLIENT_ID = 'playback-client';
const KID = 'playback-key';
let appServer, appPort, jwksServer, relayServer, privateKey, db, PURPOSE_CLAIM;
const relayed = [];

before(async () => {
  const keyPair = await generateKeyPair('RS256', { extractable: true });
  privateKey = keyPair.privateKey;
  const publicJwk = { ...(await exportJWK(keyPair.publicKey)), alg: 'RS256', use: 'sig', kid: KID };
  jwksServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  const jwksPort = await listen(jwksServer);

  relayServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      relayed.push({ path: req.url, secret: req.headers['x-tenant-admin-secret'], body: JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
    });
  });
  process.env.APP_BASE_URL = `http://127.0.0.1:${await listen(relayServer)}`;

  // Required only now: config reads APP_BASE_URL at load time.
  let registerPlatform;
  ({ db, registerPlatform } = require('../src/db'));
  ({ PLAYBACK_PURPOSE_CLAIM: PURPOSE_CLAIM } = require('../src/lti/playback'));
  registerPlatform({
    product: 'tutor_bot', tenantKey: 'pb-tenant', tenantName: 'Playback Tenant', issuer: ISSUER,
    clientId: CLIENT_ID, deploymentId: '1', authLoginUrl: `${ISSUER}/mod/lti/auth.php`,
    jwksUrl: `http://127.0.0.1:${jwksPort}/jwks`,
  });
  // Moodle user 42 has launched Rennix before (so has a tenant userid); 43 hasn't.
  db.prepare('INSERT INTO lti_user_map (tenant_key, platform_issuer, subject, userid) VALUES (?, ?, ?, ?)')
    .run('pb-tenant', ISSUER, '42', 100042);

  appServer = http.createServer(require('../server'));
  appPort = await listen(appServer);
});

after(async () => {
  for (const s of [appServer, jwksServer, relayServer]) await new Promise((resolve) => s.close(resolve));
});

function playbackToken({ sub = '42', purpose = 'video_playback', aud = CLIENT_ID, expiresIn = '2h', key = privateKey } = {}) {
  return new SignJWT({ [PURPOSE_CLAIM]: purpose, course_id: 7 })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER).setAudience(aud).setSubject(sub)
    .setIssuedAt().setExpirationTime(expiresIn)
    .sign(key);
}

async function report(body) {
  const resp = await fetch(`http://127.0.0.1:${appPort}/lti/playback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: resp.status, json: resp.status === 204 ? null : await resp.json() };
}

test('a valid report is relayed to tutor-service with the tenant userid, not the LMS user id', async () => {
  relayed.length = 0;
  const { status } = await report({ token: await playbackToken(), videoRef: '76979871', position: 165.4, state: 'paused' });
  assert.equal(status, 204);
  assert.equal(relayed.length, 1);
  assert.equal(relayed[0].path, '/admin/playback');
  assert.equal(relayed[0].secret, 'test-tenant-admin-secret');
  assert.deepEqual(relayed[0].body, {
    tenant: 'pb-tenant', userid: 100042, videoRef: '76979871', position: 165.4, state: 'paused', courseId: '7',
  });
});

test('a student who never launched Rennix is a quiet no-op (202), nothing relayed', async () => {
  relayed.length = 0;
  const { status, json } = await report({ token: await playbackToken({ sub: '43' }), videoRef: '1', position: 1, state: 'playing' });
  assert.equal(status, 202);
  assert.equal(json.ok, false);
  assert.equal(relayed.length, 0);
});

test('tokens without the playback purpose (e.g. a replayed LTI id_token) are rejected', async () => {
  for (const purpose of [null, 'lti_launch']) {
    const { status } = await report({ token: await playbackToken({ purpose }), videoRef: '1', position: 1, state: 'paused' });
    assert.equal(status, 401, `purpose=${purpose}`);
  }
});

test('tokens signed by a different key, for an unknown client, or expired are rejected', async () => {
  const { privateKey: otherKey } = await generateKeyPair('RS256');
  assert.equal((await report({ token: await playbackToken({ key: otherKey }), videoRef: '1', position: 1, state: 'paused' })).status, 401);
  assert.equal((await report({ token: await playbackToken({ aud: 'someone-else' }), videoRef: '1', position: 1, state: 'paused' })).status, 401);
  const expired = await new SignJWT({ [PURPOSE_CLAIM]: 'video_playback' })
    .setProtectedHeader({ alg: 'RS256', kid: KID }).setIssuer(ISSUER).setAudience(CLIENT_ID).setSubject('42')
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200).setExpirationTime(Math.floor(Date.now() / 1000) - 60).sign(privateKey);
  assert.equal((await report({ token: expired, videoRef: '1', position: 1, state: 'paused' })).status, 401);
  assert.equal((await report({ token: 'not-a-jwt', videoRef: '1', position: 1, state: 'paused' })).status, 400);
});

test('/embed/knowledge-check forwards a Vimeo id to tutor-service and rejects anything else', async () => {
  const ok = await fetch(`http://127.0.0.1:${appPort}/embed/knowledge-check?video=1084537`, { redirect: 'manual' });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), `${process.env.APP_BASE_URL}/widget/knowledge-check?video=1084537`);
  for (const bad of ['', 'abc', '1084537/../../admin', 'https://evil.test']) {
    const r = await fetch(`http://127.0.0.1:${appPort}/embed/knowledge-check?video=${encodeURIComponent(bad)}`, { redirect: 'manual' });
    assert.equal(r.status, 400, `video=${bad}`);
  }
});

test('malformed reports are rejected before any token work', async () => {
  const token = await playbackToken();
  assert.equal((await report({ token, videoRef: 'abc', position: 1, state: 'paused' })).status, 400);
  assert.equal((await report({ token, videoRef: '1', position: -5, state: 'paused' })).status, 400);
  assert.equal((await report({ token, videoRef: '1', position: 1, state: 'rewinding' })).status, 400);
  assert.equal((await report({ videoRef: '1', position: 1, state: 'paused' })).status, 401);
});
