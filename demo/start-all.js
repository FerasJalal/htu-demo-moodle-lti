// Starts the whole Rennix stack locally, wired together:
//   fake LMS      http://localhost:3003   (the "course page" you launch from)
//   rennix-lti    http://localhost:3002   (verifies the LTI launch)
//   tutor-service http://localhost:3001   (the real instructor/student app)
//
// Expects rennix-lti and tutor-service checked out next to this folder (see
// README). Shared secrets (LTI_BRIDGE_SECRET / TENANT_ADMIN_SECRET must match on
// both sides) come from rennix-lti/.claude/launch.json when present, otherwise
// they're generated once into data/dev-secrets.json. They are never printed.
// Set OPENAI_API_KEY in your environment to enable the AI features.
// Usage:  node start-all.js      (Ctrl+C stops everything)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const BOARD = path.join(__dirname, '..');
const LTI_DIR = path.join(BOARD, 'rennix-lti');
const TUTOR_DIR = path.join(BOARD, 'tutor-service');
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

function loadLtiEnv() {
  const launchJson = path.join(LTI_DIR, '.claude', 'launch.json');
  if (fs.existsSync(launchJson)) return require(launchJson).configurations[0].env;
  const secretsFile = path.join(DATA, 'dev-secrets.json');
  if (!fs.existsSync(secretsFile)) {
    const r = () => crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(secretsFile, JSON.stringify({
      ADMIN_SECRET: r(), SESSION_SECRET: r(), LTI_BRIDGE_SECRET: r(), TENANT_ADMIN_SECRET: r(), KEY_ENCRYPTION_SECRET: r(),
    }, null, 2));
    console.log('generated local secrets in data/dev-secrets.json (rennix-lti admin password = ADMIN_SECRET)');
  }
  return { PORT: '3002', DB_PATH: path.join(DATA, 'lti', 'lti.db'), ...JSON.parse(fs.readFileSync(secretsFile, 'utf8')) };
}
const ltiEnv = loadLtiEnv();
ltiEnv.APP_BASE_URL = 'http://localhost:3001';

// tutor-service-only secret (not shared with rennix-lti) -- generated once.
const tutorSecretsFile = path.join(DATA, 'tutor-dev-secrets.json');
if (!fs.existsSync(tutorSecretsFile)) {
  fs.writeFileSync(tutorSecretsFile, JSON.stringify({ IDENTITY_SECRET: crypto.randomBytes(24).toString('hex') }));
}
const tutorEnv = {
  ...JSON.parse(fs.readFileSync(tutorSecretsFile, 'utf8')),
  PORT: '3001',
  DB_PATH: path.join(DATA, 'tutor', 'tutor.db'),
  LTI_BRIDGE_SECRET: ltiEnv.LTI_BRIDGE_SECRET,
  TENANT_ADMIN_SECRET: ltiEnv.TENANT_ADMIN_SECRET,
  RENNIX_LTI_URL: 'http://localhost:3002', // grade push back through rennix-lti
  // Without a real key the server still boots on a placeholder; AI features then fail.
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-placeholder-local-dev',
};
fs.mkdirSync(path.dirname(tutorEnv.DB_PATH), { recursive: true });

// Register the fake LMS's two External Tools in rennix-lti (idempotent upsert),
// through rennix-lti's own registerPlatform() -- same code path as /admin/platforms.
const { ISSUER, TOOLS } = require('./fake-lms');
const platforms = Object.entries(TOOLS).map(([product, t]) => ({
  product, tenantKey: 'demo', tenantName: 'Demo University', issuer: ISSUER,
  clientId: t.clientId, deploymentId: t.deploymentId,
  authLoginUrl: `${ISSUER}/auth`, jwksUrl: `${ISSUER}/jwks`,
}));

// The local HTU-style Moodle (moodle/), once moodle/setup-htu.php has run and
// saved its per-tool client_id/deployment_id. rennix-lti fetches Moodle's
// JWKS from the host side, so localhost:8085 works for both URLs.
const moodleResult = path.join(__dirname, 'moodle', 'setup-result.txt');
if (fs.existsSync(moodleResult)) {
  const line = fs.readFileSync(moodleResult, 'utf8').split(/\r?\n/).find((l) => l.startsWith('{'));
  const moodle = JSON.parse(line);
  for (const [product, t] of Object.entries(moodle.tools)) {
    platforms.push({
      product, tenantKey: 'htu', tenantName: 'Al-Hussein Technical University (local Moodle)', issuer: moodle.issuer,
      clientId: t.clientId, deploymentId: t.deploymentId,
      authLoginUrl: `${moodle.issuer}/mod/lti/auth.php`, jwksUrl: `${moodle.issuer}/mod/lti/certs.php`,
      // Needed for NRPS roster sync + AGS grade push (service access tokens).
      authTokenUrl: `${moodle.issuer}/mod/lti/token.php`,
    });
  }
}
const reg = spawnSync(process.execPath, ['-e',
  `const { registerPlatform } = require('./src/db');
   for (const p of ${JSON.stringify(platforms)}) registerPlatform(p);
   console.log('registered ${platforms.length} platforms: ${platforms.map((p) => `${p.tenantKey}/${p.product}`).join(', ')}');`,
], { cwd: LTI_DIR, env: { ...process.env, ...ltiEnv }, stdio: 'inherit' });
if (reg.status !== 0) process.exit(reg.status || 1);

const children = [];
function run(name, cwd, script, env) {
  const child = spawn(process.execPath, [script], { cwd, env: { ...process.env, ...env } });
  const prefix = (stream, out) => stream.on('data', (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => out.write(`[${name}] ${l}\n`)));
  prefix(child.stdout, process.stdout);
  prefix(child.stderr, process.stderr);
  child.on('exit', (code) => console.log(`[${name}] exited with code ${code}`));
  children.push(child);
}

run('tutor-service', TUTOR_DIR, 'server.js', tutorEnv);
run('rennix-lti', LTI_DIR, 'server.js', ltiEnv);
run('fake-lms', __dirname, 'fake-lms.js', {});

const stopAll = () => { children.forEach((c) => c.kill()); process.exit(0); };
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
