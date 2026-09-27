// A tiny stand-in for Moodle/Canvas, for local testing only. It plays the
// "Platform" side of LTI 1.3 against rennix-lti exactly as a real LMS would:
//   1. "Launch" button  -> POST rennix-lti /lti/login   (OIDC login initiation)
//   2. rennix-lti       -> GET  /auth here              (OIDC auth request)
//   3. /auth            -> auto-POST a signed id_token to rennix-lti /lti/launch
// rennix-lti verifies that id_token against /jwks here, then hands off to
// tutor-service. Nothing here is secure -- every user is "logged in".

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const LTI_DIR = path.join(__dirname, '..', 'rennix-lti');
const { SignJWT, exportJWK, importPKCS8, importSPKI } = require(path.join(LTI_DIR, 'node_modules', 'jose'));

const PORT = Number(process.env.FAKE_LMS_PORT || 3003);
const ISSUER = `http://localhost:${PORT}`;
const TOOL_URL = process.env.TOOL_URL || 'http://localhost:3002';
const KEY_FILE = path.join(__dirname, 'data', 'fake-lms-key.json');
const KID = 'fake-lms-key-1';

// One client_id per product, mirroring how a real institution registers
// Rennix Analytics and Rennix Tutor Bot as two separate External Tools.
const TOOLS = {
  tutor_bot: { clientId: 'fake-lms-tutor-bot', deploymentId: 'fake-deploy-1', label: 'Rennix Tutor Bot' },
  analytics: { clientId: 'fake-lms-analytics', deploymentId: 'fake-deploy-1', label: 'Rennix Analytics' },
};

const COURSE = { id: 'course-101', label: 'CS101', title: 'Intro to Computer Science' };
const RESOURCE_LINK = { id: 'activity-1', title: 'Rennix in CS101' };

const USERS = {
  instructor: {
    sub: 'fake-user-instructor-1', name: 'Dr. Test Instructor', email: 'instructor@demo.test',
    roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'],
  },
  ta: {
    sub: 'fake-user-ta-1', name: 'Test TA', email: 'ta@demo.test',
    roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#TeachingAssistant'],
  },
  student: {
    sub: 'fake-user-student-1', name: 'Test Student', email: 'student@demo.test',
    roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
  },
};

// Persist the signing key so rennix-lti's cached JWKS stays valid across restarts.
function loadOrCreateKeys() {
  if (fs.existsSync(KEY_FILE)) return JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keys = {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, JSON.stringify(keys));
  return keys;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; background:#f4f5f7; margin:0; color:#1a1a1a; }
  header { background:#f98012; color:#fff; padding:14px 24px; font-weight:700; }
  header small { font-weight:400; opacity:.85; margin-left:8px; }
  main { max-width:760px; margin:24px auto; padding:0 16px; }
  .card { background:#fff; border:1px solid #dde1e6; border-radius:10px; padding:20px; margin-bottom:16px; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:16px; margin:0 0 12px; }
  p { color:#555; font-size:14px; line-height:1.5; margin:0 0 12px; }
  .row { display:flex; flex-wrap:wrap; gap:8px; }
  button { font:inherit; font-size:14px; padding:9px 14px; border-radius:6px; border:1px solid #c9ced4; background:#fff; cursor:pointer; }
  button.primary { background:#0f6cbf; border-color:#0f6cbf; color:#fff; }
  button:hover { filter:brightness(.95); }
  code { background:#eef0f3; padding:1px 5px; border-radius:4px; font-size:12px; }
</style></head><body><header>Fake LMS<small>local testing stand-in for Moodle</small></header><main>${body}</main></body></html>`;
}

function launchButton(product, userKey, label, primary) {
  const tool = TOOLS[product];
  // Real platforms carry which user/tool is launching through the opaque
  // login_hint / lti_message_hint; the tool echoes them back to /auth.
  return `<form method="post" action="${esc(TOOL_URL)}/lti/login" style="margin:0">
    <input type="hidden" name="iss" value="${esc(ISSUER)}">
    <input type="hidden" name="client_id" value="${esc(tool.clientId)}">
    <input type="hidden" name="login_hint" value="${esc(userKey)}">
    <input type="hidden" name="lti_message_hint" value="${esc(product)}">
    <input type="hidden" name="target_link_uri" value="${esc(TOOL_URL)}/lti/launch">
    <input type="hidden" name="lti_deployment_id" value="${esc(tool.deploymentId)}">
    <button class="${primary ? 'primary' : ''}">${esc(label)}</button>
  </form>`;
}

function homePage() {
  const section = (product) => `<div class="card">
    <h2>${esc(TOOLS[product].label)}</h2>
    <div class="row">
      ${launchButton(product, 'instructor', 'Launch as Instructor', true)}
      ${launchButton(product, 'ta', 'Launch as Teaching Assistant')}
      ${launchButton(product, 'student', 'Launch as Student')}
    </div></div>`;
  return page('Fake LMS', `<div class="card"><h1>${esc(COURSE.label)}: ${esc(COURSE.title)}</h1>
    <p>Each button runs a real signed LTI 1.3 launch into rennix-lti at <code>${esc(TOOL_URL)}</code>, which then hands off to tutor-service.</p></div>
    ${section('tutor_bot')}${section('analytics')}`);
}

async function handleAuth(url, res, privateKey) {
  const q = url.searchParams;
  const product = q.get('lti_message_hint');
  const user = USERS[q.get('login_hint')];
  const tool = TOOLS[product];
  if (!user || !tool || q.get('client_id') !== tool.clientId) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Fake LMS: unknown user/tool in auth request.');
  }
  const redirectUri = q.get('redirect_uri');
  const idToken = await new SignJWT({
    nonce: q.get('nonce'),
    name: user.name,
    email: user.email,
    'https://purl.imsglobal.org/spec/lti/claim/message_type': 'LtiResourceLinkRequest',
    'https://purl.imsglobal.org/spec/lti/claim/version': '1.3.0',
    'https://purl.imsglobal.org/spec/lti/claim/deployment_id': tool.deploymentId,
    'https://purl.imsglobal.org/spec/lti/claim/target_link_uri': `${TOOL_URL}/lti/launch`,
    'https://purl.imsglobal.org/spec/lti/claim/roles': user.roles,
    'https://purl.imsglobal.org/spec/lti/claim/context': COURSE,
    'https://purl.imsglobal.org/spec/lti/claim/resource_link': RESOURCE_LINK,
    'https://purl.imsglobal.org/spec/lti/claim/tool_platform': { guid: 'fake-lms', name: 'Fake LMS' },
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(tool.clientId)
    .setSubject(user.sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(page('Launching…', `<div class="card"><p>Launching ${esc(tool.label)} as ${esc(user.name)}…</p>
    <form id="f" method="post" action="${esc(redirectUri)}">
      <input type="hidden" name="id_token" value="${esc(idToken)}">
      <input type="hidden" name="state" value="${esc(q.get('state'))}">
      <noscript><button>Continue</button></noscript>
    </form></div><script>document.getElementById('f').submit()</script>`));
}

async function main() {
  const keys = loadOrCreateKeys();
  const privateKey = await importPKCS8(keys.privatePem, 'RS256');
  const publicJwk = { ...(await exportJWK(await importSPKI(keys.publicPem, 'RS256', { extractable: true }))), kid: KID, alg: 'RS256', use: 'sig' };

  http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, ISSUER);
      if (url.pathname === '/jwks') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ keys: [publicJwk] }));
      }
      if (url.pathname === '/auth') return await handleAuth(url, res, privateKey);
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(homePage());
      }
      res.writeHead(404); res.end('Not found');
    } catch (err) {
      console.error('[fake-lms]', err);
      res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(`Fake LMS error: ${err.message}`);
    }
  }).listen(PORT, () => console.log(`fake LMS listening on ${ISSUER}`));
}

module.exports = { ISSUER, TOOLS };
if (require.main === module) main();
