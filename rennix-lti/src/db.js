const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DB_PATH, APP_BASE_URL, TENANT_ADMIN_SECRET } = require('./config');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// "product" separates the Analytics tool from the Tutor Bot tool at the
// registration level -- each is installed in a university's LMS as its own
// External Tool with its own client_id, so a school can buy/enable one
// without the other. Same verification plumbing underneath (one service,
// one JWT/JWKS codepath), but from the customer's side these are two
// separate, independently purchasable tools, not one bundle.
db.exec(`
  CREATE TABLE IF NOT EXISTS platforms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product TEXT NOT NULL CHECK (product IN ('analytics', 'tutor_bot')),
    tenant_key TEXT NOT NULL,
    tenant_name TEXT NOT NULL,
    issuer TEXT NOT NULL,
    client_id TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    auth_login_url TEXT NOT NULL,
    auth_token_url TEXT,
    jwks_url TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(issuer, client_id)
  );
  CREATE TABLE IF NOT EXISTS lti_states (
    state TEXT PRIMARY KEY,
    nonce TEXT NOT NULL,
    platform_id INTEGER NOT NULL,
    target_link_uri TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lti_user_map (
    tenant_key TEXT NOT NULL,
    platform_issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    userid INTEGER NOT NULL,
    PRIMARY KEY (tenant_key, platform_issuer, subject)
  );
  CREATE TABLE IF NOT EXISTS tenant_userid_seq (
    tenant_key TEXT PRIMARY KEY,
    next_userid INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tool_keys (
    kid TEXT PRIMARY KEY,
    private_key_pem TEXT NOT NULL,
    public_jwk TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lti_dl_sessions (
    id TEXT PRIMARY KEY,
    platform_id INTEGER NOT NULL,
    deep_link_return_url TEXT NOT NULL,
    data TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    detail TEXT,
    ip TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit_log(created_at);
  -- A platform's deployment_id column is its deployment at registration
  -- time; this table is the full set of deployment ids that platform is
  -- allowed to launch from (seeded from that column, can grow beyond it --
  -- see isKnownDeployment/addDeployment). One row per (issuer, client_id)
  -- registration can cover many real-world deployments (e.g. Canvas mints a
  -- new deployment_id per course/account that installs the same client_id).
  CREATE TABLE IF NOT EXISTS platform_deployments (
    platform_id INTEGER NOT NULL,
    deployment_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (platform_id, deployment_id)
  );
  -- Short-lived, single-use, like lti_dl_sessions -- holds the platform's
  -- fetched openid_configuration and registration_token between GET
  -- /lti/register (which doesn't yet know which product/tenant this is for)
  -- and POST /lti/register/complete (which does). registration_token is a
  -- credential, so it's kept server-side rather than round-tripped through
  -- hidden form fields.
  CREATE TABLE IF NOT EXISTS lti_registration_sessions (
    id TEXT PRIMARY KEY,
    openid_config TEXT NOT NULL,
    registration_token TEXT,
    created_at INTEGER NOT NULL
  );
  -- Captured from the AGS endpoint claim on every LtiResourceLinkRequest
  -- launch (src/lti/launch.js), not just Deep-Linked ones. resource_link_id
  -- alone is the key -- per spec it's platform-issued and stable for one
  -- activity instance, so it already pins down which platform produced it
  -- (platform_id is stored alongside for the service-token exchange, not as
  -- part of the key). lineitem_url is the direct per-activity gradebook
  -- column URL when the platform already created one; lineitems_url is the
  -- collection endpoint used to create one lazily on first score push (see
  -- src/lti/ags.js) when lineitem_url is empty.
  CREATE TABLE IF NOT EXISTS ags_lineitems (
    resource_link_id TEXT PRIMARY KEY,
    platform_id INTEGER NOT NULL,
    tenant_key TEXT NOT NULL,
    lineitem_url TEXT,
    lineitems_url TEXT,
    scope TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// Backfills platform_deployments for platforms that existed before this
// table did -- idempotent, safe to run on every boot. New platforms are
// seeded directly by registerPlatform below.
db.exec(`
  INSERT OR IGNORE INTO platform_deployments (platform_id, deployment_id, created_at)
  SELECT id, deployment_id, created_at FROM platforms
`);

// SQLite has no `ADD COLUMN IF NOT EXISTS` -- this is the lightweight
// migration pattern for adding a nullable/defaulted column to a table that
// may already exist from before this column was introduced.
function addColumnIfMissing(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
addColumnIfMissing('platforms', 'active', 'active INTEGER NOT NULL DEFAULT 1');
// Set on platforms created via Dynamic Registration (src/lti/dynamicRegistration.js) -- gates
// auto-discovery of unrecognized deployment_ids in src/lti/launch.js. Manually-registered
// platforms keep the strict, unchanged behavior from before Dynamic Registration existed.
addColumnIfMissing('platforms', 'dynamic_registration', 'dynamic_registration INTEGER NOT NULL DEFAULT 0');
// Presence of enc_iv/enc_tag on a tool_keys row is what distinguishes an
// at-rest-encrypted private_key_pem from a legacy plaintext one -- see
// src/security/toolKeys.js and src/security/keyEncryption.js.
addColumnIfMissing('tool_keys', 'enc_iv', 'enc_iv TEXT');
addColumnIfMissing('tool_keys', 'enc_tag', 'enc_tag TEXT');

// States/nonces are single-use and short-lived (10 min) -- sweep expired
// rows on every login attempt rather than running a separate cron.
function sweepExpiredStates() {
  db.prepare('DELETE FROM lti_states WHERE created_at < ?').run(Date.now() - 10 * 60 * 1000);
}

// Same idea as sweepExpiredStates, for the Dynamic Registration hand-off
// session (src/lti/dynamicRegistration.js).
function sweepExpiredRegistrationSessions() {
  db.prepare('DELETE FROM lti_registration_sessions WHERE created_at < ?').run(Date.now() - 10 * 60 * 1000);
}

function getPlatform({ issuer, clientId }) {
  if (clientId) {
    return db.prepare('SELECT * FROM platforms WHERE issuer = ? AND client_id = ? AND active = 1').get(issuer, clientId);
  }
  const rows = db.prepare('SELECT * FROM platforms WHERE issuer = ? AND active = 1').all(issuer);
  return rows.length === 1 ? rows[0] : null; // ambiguous without a client_id if more than one
}

function setPlatformActive(id, active) {
  db.prepare('UPDATE platforms SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
}

// Shared logic behind manual registration (the JSON API, the /admin/onboard
// form) and Dynamic Registration (src/lti/dynamicRegistration.js) -- one
// place that actually writes a platform row, so they can't drift.
// requireDeployment=false is what Dynamic Registration needs: not every
// platform's registration response includes a deployment_id upfront (Canvas
// typically doesn't; Moodle typically does) -- deployment_id stays NOT NULL
// at the column level (storing '' rather than loosening the schema), and
// platform_deployments simply starts empty for that platform, to be filled
// by launch.js's auto-discovery (gated on the `dynamic` flag this sets).
function upsertPlatform(fields, { requireDeployment, dynamic }) {
  const { product, tenantKey, tenantName, issuer, clientId, deploymentId, authLoginUrl, authTokenUrl, jwksUrl } = fields;
  const requiredFields = ['product', 'tenantKey', 'tenantName', 'issuer', 'clientId', 'authLoginUrl', 'jwksUrl'];
  if (requireDeployment) requiredFields.push('deploymentId');
  const missing = requiredFields.filter((k) => !fields[k]);
  if (missing.length) throw new Error(`Missing fields: ${missing.join(', ')}`);
  if (!['analytics', 'tutor_bot'].includes(product)) {
    throw new Error("product must be 'analytics' or 'tutor_bot'");
  }
  const now = Date.now();
  db.prepare(
    `INSERT INTO platforms (product, tenant_key, tenant_name, issuer, client_id, deployment_id, auth_login_url, auth_token_url, jwks_url, dynamic_registration, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(issuer, client_id) DO UPDATE SET
       product = excluded.product, tenant_key = excluded.tenant_key, tenant_name = excluded.tenant_name,
       deployment_id = excluded.deployment_id, auth_login_url = excluded.auth_login_url,
       auth_token_url = excluded.auth_token_url, jwks_url = excluded.jwks_url`
  ).run(product, tenantKey, tenantName, issuer, clientId, deploymentId || '', authLoginUrl, authTokenUrl || null, jwksUrl, dynamic ? 1 : 0, now);

  // Same row whether this was a fresh insert or an upsert of an existing
  // registration -- fetch it back by its natural key to get the id.
  const row = db.prepare('SELECT id FROM platforms WHERE issuer = ? AND client_id = ?').get(issuer, clientId);
  if (deploymentId) {
    db.prepare('INSERT OR IGNORE INTO platform_deployments (platform_id, deployment_id, created_at) VALUES (?, ?, ?)')
      .run(row.id, deploymentId, now);
  }
  return row.id;
}

function registerPlatform(fields) {
  return upsertPlatform(fields, { requireDeployment: true, dynamic: false });
}

// Fixes an already-registered platform in place (typo'd issuer/client_id, a
// token URL that was never captured, an LMS that moved hosts...) instead of
// deactivating it and re-onboarding. tenant_key and product are deliberately
// not editable: lti_user_map and tutor-service's per-tenant database are keyed
// on tenant_key, so changing it would silently detach every existing user.
const EDITABLE_PLATFORM_FIELDS = {
  tenantName: 'tenant_name',
  issuer: 'issuer',
  clientId: 'client_id',
  authLoginUrl: 'auth_login_url',
  authTokenUrl: 'auth_token_url',
  jwksUrl: 'jwks_url',
};
const PLATFORM_URL_FIELDS = ['issuer', 'authLoginUrl', 'authTokenUrl', 'jwksUrl'];

function updatePlatform(id, fields) {
  const existing = db.prepare('SELECT * FROM platforms WHERE id = ?').get(id);
  if (!existing) throw new Error('Platform not found.');
  const next = {};
  for (const [field, column] of Object.entries(EDITABLE_PLATFORM_FIELDS)) {
    const value = fields[field] === undefined ? existing[column] : String(fields[field]).trim();
    next[column] = value === '' && field === 'authTokenUrl' ? null : value;
  }
  const missing = Object.entries(EDITABLE_PLATFORM_FIELDS)
    .filter(([field, column]) => field !== 'authTokenUrl' && !next[column]).map(([field]) => field);
  if (missing.length) throw new Error(`Missing fields: ${missing.join(', ')}`);
  for (const field of PLATFORM_URL_FIELDS) {
    const value = next[EDITABLE_PLATFORM_FIELDS[field]];
    if (value && !/^https?:\/\/[^\s]+$/i.test(value)) throw new Error(`${field} must be an http(s) URL.`);
  }
  const clash = db.prepare('SELECT id FROM platforms WHERE issuer = ? AND client_id = ? AND id != ?')
    .get(next.issuer, next.client_id, id);
  if (clash) throw new Error('Another platform is already registered with that issuer and client ID.');
  db.prepare(
    `UPDATE platforms SET tenant_name = ?, issuer = ?, client_id = ?, auth_login_url = ?, auth_token_url = ?, jwks_url = ?
     WHERE id = ?`
  ).run(next.tenant_name, next.issuer, next.client_id, next.auth_login_url, next.auth_token_url, next.jwks_url, id);
  // The caller needs this to decide whether cached platform keys are stale.
  const changed = Object.values(EDITABLE_PLATFORM_FIELDS).filter((column) => (existing[column] || null) !== (next[column] || null));
  return { platform: db.prepare('SELECT * FROM platforms WHERE id = ?').get(id), changed };
}

function registerDynamicPlatform(fields) {
  return upsertPlatform(fields, { requireDeployment: false, dynamic: true });
}

// The full set of deployment ids a platform (an (issuer, client_id)
// registration) is allowed to launch from -- see platform_deployments above.
function isKnownDeployment(platformId, deploymentId) {
  return !!db.prepare('SELECT 1 FROM platform_deployments WHERE platform_id = ? AND deployment_id = ?').get(platformId, deploymentId);
}

function addDeployment(platformId, deploymentId) {
  db.prepare('INSERT OR IGNORE INTO platform_deployments (platform_id, deployment_id, created_at) VALUES (?, ?, ?)')
    .run(platformId, deploymentId, Date.now());
}

// ---- AGS (see src/lti/ags.js for the actual score-push logic) ----
// Called from src/lti/launch.js on every LtiResourceLinkRequest that carries
// an AGS endpoint claim -- refreshes lineitems_url/scope every launch (a
// platform could change them), but never clobbers an already-known
// lineitem_url with a blank one from a launch that didn't happen to include
// a direct lineitem reference.
function upsertAgsEndpoint(resourceLinkId, { platformId, tenantKey, lineitemUrl, lineitemsUrl, scope }) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO ags_lineitems (resource_link_id, platform_id, tenant_key, lineitem_url, lineitems_url, scope, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(resource_link_id) DO UPDATE SET
       lineitems_url = excluded.lineitems_url, scope = excluded.scope, updated_at = excluded.updated_at,
       lineitem_url = COALESCE(excluded.lineitem_url, ags_lineitems.lineitem_url)`
  ).run(resourceLinkId, platformId, tenantKey, lineitemUrl || null, lineitemsUrl || null, scope || null, now, now);
}

function getAgsLineItem(resourceLinkId) {
  return db.prepare('SELECT * FROM ags_lineitems WHERE resource_link_id = ?').get(resourceLinkId);
}

function setAgsLineItemUrl(resourceLinkId, lineitemUrl) {
  db.prepare('UPDATE ags_lineitems SET lineitem_url = ?, updated_at = ? WHERE resource_link_id = ?')
    .run(lineitemUrl, Date.now(), resourceLinkId);
}

// tutor-service's schema keys students by a small integer id (it grew up as
// a single Moodle-backed pilot, where that's just Moodle's own user id).
// LTI's own user identifier (the `sub` claim) is an opaque, platform-chosen
// string with no such guarantee -- so this is the one place that identity
// gets translated into a stable integer, scoped per tenant, allocated once
// and reused on every later launch by the same person. The 100000 starting
// point keeps freshly-allocated ids from ever colliding with any small id a
// tenant might already have from manual/legacy seeding.
//
// Before allocating fresh, this checks tutor-service for an existing student
// with the same email in this tenant -- essential for HTU specifically,
// which already has real students with real history (attendance, chat,
// notes) under small ids from the Moodle-plugin path; without this, the same
// person launching via LTI instead would silently become a second,
// historyless account. A tenant that only ever arrives via LTI never has a
// pre-existing row to match, so this is a no-op cost for it -- just
// allocating fresh, as before.
async function findExistingUserIdByEmail(tenantKey, email) {
  if (!email || !TENANT_ADMIN_SECRET) return null;
  try {
    const url = new URL('/admin/tenant-user-lookup', APP_BASE_URL);
    url.searchParams.set('tenant', tenantKey);
    url.searchParams.set('email', email);
    // Header, not a query param -- tutor-service's requireTenantAdmin no longer
    // accepts the secret via the URL (it would land in access/proxy logs).
    const resp = await fetch(url.toString(), { headers: { 'x-tenant-admin-secret': TENANT_ADMIN_SECRET } });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.userid || null;
  } catch (err) {
    require('./log').error('[LTI] existing-user lookup failed:', err.message);
    return null;
  }
}

async function getOrAllocateUserId(tenantKey, issuer, subject, email) {
  const existing = db.prepare(
    'SELECT userid FROM lti_user_map WHERE tenant_key = ? AND platform_issuer = ? AND subject = ?'
  ).get(tenantKey, issuer, subject);
  if (existing) return existing.userid;

  const matched = await findExistingUserIdByEmail(tenantKey, email);
  if (matched) {
    db.prepare(
      'INSERT INTO lti_user_map (tenant_key, platform_issuer, subject, userid) VALUES (?, ?, ?, ?)'
    ).run(tenantKey, issuer, subject, matched);
    return matched;
  }

  const allocate = db.transaction(() => {
    let seq = db.prepare('SELECT next_userid FROM tenant_userid_seq WHERE tenant_key = ?').get(tenantKey);
    if (!seq) {
      seq = { next_userid: 100000 };
      db.prepare('INSERT INTO tenant_userid_seq (tenant_key, next_userid) VALUES (?, ?)').run(tenantKey, seq.next_userid);
    }
    db.prepare('UPDATE tenant_userid_seq SET next_userid = next_userid + 1 WHERE tenant_key = ?').run(tenantKey);
    db.prepare(
      'INSERT INTO lti_user_map (tenant_key, platform_issuer, subject, userid) VALUES (?, ?, ?, ?)'
    ).run(tenantKey, issuer, subject, seq.next_userid);
    return seq.next_userid;
  });
  return allocate();
}

module.exports = {
  db, sweepExpiredStates, sweepExpiredRegistrationSessions, getPlatform,
  registerPlatform, registerDynamicPlatform, updatePlatform, setPlatformActive,
  isKnownDeployment, addDeployment, getOrAllocateUserId, findExistingUserIdByEmail,
  upsertAgsEndpoint, getAgsLineItem, setAgsLineItemUrl,
};
