const crypto = require('crypto');
const { SESSION_SECRET, LTI_BRIDGE_SECRET } = require('../config');

// The token tutor-service actually trusts to open the real app -- distinct
// from signSessionToken below, which is this service's own internal-only
// token for the proof-of-concept landing page.
function signBridgeToken(payload) {
  if (!LTI_BRIDGE_SECRET) throw new Error('LTI_BRIDGE_SECRET is not set');
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 8 * 60 * 60 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', LTI_BRIDGE_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function signSessionToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// ---- Admin session cookie -- replaces passing ADMIN_SECRET around in query
// strings/POST bodies on every request. A human logs in once (POST
// /admin/login, secret in the body only, never the URL), gets a signed,
// HttpOnly, short-lived cookie back, and that carries them from then on.
// x-admin-secret header auth stays available separately for scripted/API use
// (curl, CI), where a header doesn't end up in browser history or Referer
// headers the way a query string does. ----
const ADMIN_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function signAdminSession() {
  const body = Buffer.from(JSON.stringify({ type: 'admin', exp: Date.now() + ADMIN_SESSION_MAX_AGE_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyAdminSession(token) {
  if (!token || typeof token !== 'string') return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch (e) { return false; }
  return parsed.type === 'admin' && typeof parsed.exp === 'number' && parsed.exp > Date.now();
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

module.exports = {
  signBridgeToken, signSessionToken, signAdminSession, verifyAdminSession, parseCookies, ADMIN_SESSION_MAX_AGE_MS,
};
