const path = require('path');

const PORT = process.env.PORT || 3002;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'lti.db');
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const SESSION_SECRET = process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex');
// Where a verified launch hands off to -- the actual product. Points at
// tutor-service for now (single shared app across tenants); swap per-tenant
// once the multi-tenant app itself exists.
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://tutor.edu.rennix.ai';
// Shared with tutor-service specifically (separate from block_criterio's
// IDENTITY_SECRET) -- this is what lets a verified launch actually open the
// real app instead of the proof-of-concept page.
const LTI_BRIDGE_SECRET = process.env.LTI_BRIDGE_SECRET || '';
// Shared with tutor-service specifically, for the cross-service calls this
// service makes (tenant-user lookup, roster sync, onboarding's OpenAI-key set).
const TENANT_ADMIN_SECRET = process.env.TENANT_ADMIN_SECRET || '';
// Optional -- wraps the tool's own RSA private key (src/security/toolKeys.js)
// before it's stored in SQLite. Not required so that existing deployments
// don't break by redeploying without it set first: unset, the key stays
// plaintext at rest (as before); set, new keys are encrypted and any
// existing plaintext key gets transparently re-encrypted in place.
const KEY_ENCRYPTION_SECRET = process.env.KEY_ENCRYPTION_SECRET || '';

if (!ADMIN_SECRET) {
  require('./log').warn('ADMIN_SECRET is not set -- /admin/platforms is effectively open. Set it before registering a real platform.');
}
if (!KEY_ENCRYPTION_SECRET) {
  require('./log').warn('KEY_ENCRYPTION_SECRET is not set -- the tool\'s private key is stored in plaintext. Set it to encrypt it at rest.');
}

module.exports = {
  PORT, DB_PATH, ADMIN_SECRET, SESSION_SECRET, APP_BASE_URL, LTI_BRIDGE_SECRET, TENANT_ADMIN_SECRET, KEY_ENCRYPTION_SECRET,
};
