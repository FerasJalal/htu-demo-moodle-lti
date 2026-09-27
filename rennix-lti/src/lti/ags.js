const express = require('express');
const { db, getAgsLineItem, setAgsLineItemUrl } = require('../db');
const { getServiceAccessToken } = require('./nrps');
const { logAdminEvent } = require('../audit');
const { TENANT_ADMIN_SECRET } = require('../config');

// ---- Assignment and Grade Services ----
// A grade event happens on tutor-service's side (tenant + userid + activity),
// but only this service holds what's needed to actually push it: the
// platform's AGS endpoint URLs (seen only inside a signed launch, captured
// into ags_lineitems by src/lti/launch.js) and the service-token machinery
// already built for NRPS (getServiceAccessToken is generic over scope, not
// NRPS-specific -- reused here as-is with an AGS scope instead).
const AGS_LINEITEM_SCOPE = 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem';
const AGS_SCORE_SCOPE = 'https://purl.imsglobal.org/spec/lti-ags/scope/score';
const AGS_SCOPES = `${AGS_LINEITEM_SCOPE} ${AGS_SCORE_SCOPE}`;

async function createLineItem(platform, lineitemsUrl, { scoreMaximum, label, resourceLinkId }) {
  const accessToken = await getServiceAccessToken(platform, AGS_LINEITEM_SCOPE);
  const resp = await fetch(lineitemsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.ims.lis.v2.lineitem+json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ scoreMaximum, label, resourceLinkId, tag: 'rennix' }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Line item creation failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  const created = await resp.json();
  // Spec quirk: a line item's own `id` field IS its URL, not a bare identifier.
  if (!created.id) throw new Error('Platform did not return a line item id/URL.');
  return created.id;
}

// A lineitem URL can carry its own query string (e.g. Moodle's
// `.../lineitem?type_id=1`) -- naive string concatenation of `/scores` would
// land after the query string instead of extending the path, producing an
// invalid URL the platform can't route (caught via real-Moodle testing;
// the mocked test platform's URLs happened to have no query string, which
// is exactly why this needs a real URL object, not a template literal).
function scoresUrlFor(lineitemUrl) {
  const url = new URL(lineitemUrl);
  url.pathname += '/scores';
  return url.toString();
}

async function pushScore(platform, lineitemUrl, { subject, scoreGiven, scoreMaximum, activityProgress, gradingProgress }) {
  const accessToken = await getServiceAccessToken(platform, AGS_SCORE_SCOPE);
  const resp = await fetch(scoresUrlFor(lineitemUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.ims.lis.v1.score+json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      userId: subject,
      scoreGiven,
      scoreMaximum,
      activityProgress: activityProgress || 'Completed',
      gradingProgress: gradingProgress || 'FullyGraded',
      timestamp: new Date().toISOString(),
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Score submission failed (${resp.status}): ${text.slice(0, 200)}`);
  }
}

// Symmetric use of the same shared secret rennix-lti already sends to
// tutor-service's own admin endpoints (see src/db.js's
// findExistingUserIdByEmail) -- here it's tutor-service calling in, so the
// check is the mirror image of requireAdmin (src/admin/auth.js).
function requireTenantAdmin(req, res, next) {
  const headerSecret = req.get('x-tenant-admin-secret');
  if (TENANT_ADMIN_SECRET && headerSecret === TENANT_ADMIN_SECRET) return next();
  return res.status(401).json({ error: 'Missing or invalid tenant admin credentials.' });
}

const router = express.Router();

// ---- Contract for tutor-service to call -- see README.md's "Grades
// (Assignment and Grade Services)" section for the full spec. Not called
// from anywhere in this repo; tutor-service is expected to call this when it
// decides a score is ready to report. ----
router.post('/ags/score', requireTenantAdmin, async (req, res) => {
  const { tenant, userid, resourceLinkId, score, scoreMaximum, label, activityProgress, gradingProgress } = req.body || {};
  if (!tenant || !userid || !resourceLinkId || score == null || scoreMaximum == null) {
    return res.status(400).json({ error: 'Missing tenant, userid, resourceLinkId, score, or scoreMaximum.' });
  }

  const lineItemRow = getAgsLineItem(resourceLinkId);
  if (!lineItemRow) {
    return res.status(404).json({ error: 'Unknown resourceLinkId -- either this platform never granted AGS, or the activity was never launched.' });
  }
  if (lineItemRow.tenant_key !== tenant) {
    logAdminEvent('ags_score_tenant_mismatch', `resource_link_id=${resourceLinkId} expected=${lineItemRow.tenant_key} got=${tenant}`, req);
    return res.status(403).json({ error: 'tenant does not match the tenant this resourceLinkId belongs to.' });
  }

  const platform = db.prepare('SELECT * FROM platforms WHERE id = ?').get(lineItemRow.platform_id);
  if (!platform) return res.status(404).json({ error: 'Platform no longer registered.' });

  const userMap = db.prepare('SELECT subject FROM lti_user_map WHERE tenant_key = ? AND platform_issuer = ? AND userid = ?')
    .get(tenant, platform.issuer, userid);
  if (!userMap) {
    return res.status(400).json({ error: 'This student has no recorded LTI launch for this platform -- no subject to attribute the score to.' });
  }

  try {
    let lineitemUrl = lineItemRow.lineitem_url;
    if (!lineitemUrl) {
      if (!lineItemRow.lineitems_url) {
        return res.status(404).json({ error: 'No line item and no lineitems collection URL known for this resourceLinkId.' });
      }
      lineitemUrl = await createLineItem(platform, lineItemRow.lineitems_url, {
        scoreMaximum, label: label || platform.tenant_name, resourceLinkId,
      });
      setAgsLineItemUrl(resourceLinkId, lineitemUrl);
    }

    await pushScore(platform, lineitemUrl, {
      subject: userMap.subject, scoreGiven: score, scoreMaximum, activityProgress, gradingProgress,
    });

    logAdminEvent('ags_score_pushed', `tenant=${tenant} resource_link_id=${resourceLinkId} score=${score}/${scoreMaximum}`, req);
    res.json({ ok: true });
  } catch (err) {
    logAdminEvent('ags_score_push_failed', `tenant=${tenant} resource_link_id=${resourceLinkId} error=${err.message}`, req);
    res.status(502).json({ error: 'Pushing the score to the platform failed.' });
  }
});

module.exports = { router, requireTenantAdmin, AGS_SCOPES, AGS_LINEITEM_SCOPE, AGS_SCORE_SCOPE, createLineItem, pushScore };
