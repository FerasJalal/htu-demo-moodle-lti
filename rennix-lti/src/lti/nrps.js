const crypto = require('crypto');
const { SignJWT } = require('jose');
const { getToolKeyPair } = require('../security/toolKeys');
const { getOrAllocateUserId } = require('../db');
const { mapLtiRolesToInternalRole } = require('./roles');
const { logAdminEvent } = require('../audit');
const { APP_BASE_URL, TENANT_ADMIN_SECRET } = require('../config');

// ---- LTI Advantage service calls (NRPS today, AGS later reuses the same
// token exchange) ----
// A service call means: sign a short-lived JWT asserting this tool's own
// identity (client_id) using OUR private key, trade it for an OAuth access
// token at the platform's token endpoint, then use that token as a normal
// Bearer credential against the actual service URL. Cached per
// platform+scope until shortly before expiry, rather than requesting a fresh
// token on every single service call -- the standard pattern for LTI
// Advantage service calls.
const serviceTokenCache = new Map(); // "platformId:scope" -> { token, expiresAt }
async function getServiceAccessToken(platform, scope) {
  const cacheKey = `${platform.id}:${scope}`;
  const cached = serviceTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  if (!platform.auth_token_url) {
    throw new Error(`Platform ${platform.tenant_key} has no auth_token_url registered -- cannot request a service token.`);
  }
  const { privateKey, kid } = await getToolKeyPair();
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({
    sub: platform.client_id,
    aud: platform.auth_token_url,
    jti: crypto.randomBytes(16).toString('hex'),
  })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(platform.client_id)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
    scope,
  });
  const resp = await fetch(platform.auth_token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Token request failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  serviceTokenCache.set(cacheKey, { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 });
  return data.access_token;
}

// ---- Names and Role Provisioning Service ----
// The launch-time roster (who has actually clicked into the tool) is a subset
// of the real course membership -- NRPS is what lets the instructor dashboard
// eventually distinguish "enrolled but never used the tutor" from "not
// enrolled at all", instead of only ever knowing about students who happened
// to launch.
const NRPS_SCOPE = 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly';
async function fetchCourseMembership(membershipsUrl, accessToken) {
  const resp = await fetch(membershipsUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.ims.lti-nrps.v2.membershipcontainer+json',
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`NRPS request failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  return resp.json(); // { id, context, members: [{ user_id, roles, status, name, email, ... }] }
}

// Fire-and-forget from /lti/launch -- never blocks the student/instructor's
// redirect on a roster sync. Pushes the full membership into tutor-service via
// the same /students/sync endpoint the legacy Moodle-native path uses, so both
// roster sources land in one place rather than needing two parallel systems.
async function syncRosterViaNrps(platform, membershipsUrl) {
  const accessToken = await getServiceAccessToken(platform, NRPS_SCOPE);
  const data = await fetchCourseMembership(membershipsUrl, accessToken);
  const members = data.members || [];

  const students = [];
  for (const m of members) {
    const roles = m.roles || [];
    const internalRole = mapLtiRolesToInternalRole(roles);
    const userid = await getOrAllocateUserId(platform.tenant_key, platform.issuer, m.user_id, m.email);
    students.push({
      userid,
      username: m.email ? m.email.split('@')[0] : `nrps-${m.user_id}`,
      fullname: m.name || [m.given_name, m.family_name].filter(Boolean).join(' ') || 'Unknown',
      email: m.email || null,
      role: internalRole,
    });
  }

  if (!TENANT_ADMIN_SECRET) {
    throw new Error('TENANT_ADMIN_SECRET is not configured -- cannot push the roster to tutor-service.');
  }
  const resp = await fetch(`${APP_BASE_URL}/students/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tenant-admin-secret': TENANT_ADMIN_SECRET },
    body: JSON.stringify({ tenant: platform.tenant_key, students }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`tutor-service /students/sync returned ${resp.status}: ${text.slice(0, 200)}`);
  }
  logAdminEvent('nrps_roster_synced', `tenant=${platform.tenant_key} members=${students.length}`, null);
}

module.exports = { getServiceAccessToken, fetchCourseMembership, syncRosterViaNrps, NRPS_SCOPE };
