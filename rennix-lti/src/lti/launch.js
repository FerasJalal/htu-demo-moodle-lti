const express = require('express');
const { jwtVerify } = require('jose');
const { db } = require('../db');
const { getOrAllocateUserId, isKnownDeployment, addDeployment, upsertAgsEndpoint } = require('../db');
const { logAdminEvent } = require('../audit');
const { rateLimit } = require('../rateLimit');
const { escapeHtml } = require('../util/html');
const { signBridgeToken } = require('../security/tokens');
const { mapLtiRolesToInternalRole } = require('./roles');
const { getPlatformJwks } = require('./platformJwks');
const { handleDeepLinkingRequest } = require('./deepLinking');
const { syncRosterViaNrps } = require('./nrps');
const log = require('../log');
const { APP_BASE_URL } = require('../config');

// The raw exception text (jose verification errors, fetch failures, etc.) is
// useful to whoever operates this service but is not something to hand back
// to whatever's sitting in the LMS's redirect -- it can include internal
// URLs or library-specific wording. The full detail still always reaches
// logAdminEvent (admin-only); only the HTTP response is generic in
// production. Kept verbose outside production for local iteration speed.
function launchErrorMessage(err) {
  if (process.env.NODE_ENV === 'production') {
    return 'Launch verification failed. Contact your LMS administrator.';
  }
  return `Launch verification failed: ${err.message}`;
}

const router = express.Router();

// ---- Step 2: launch -- verify the platform's signed id_token ----
router.post('/lti/launch', rateLimit('lti-launch', 30, 60 * 1000), async (req, res) => {
  try {
    const { id_token, state } = req.body;
    if (!id_token || !state) return res.status(400).send('Missing id_token or state.');

    const stateRow = db.prepare('SELECT * FROM lti_states WHERE state = ?').get(state);
    if (!stateRow) return res.status(400).send('Unknown or expired state -- restart the launch from your LMS.');
    db.prepare('DELETE FROM lti_states WHERE state = ?').run(state); // single-use

    const platform = db.prepare('SELECT * FROM platforms WHERE id = ?').get(stateRow.platform_id);
    if (!platform) return res.status(400).send('Platform no longer registered.');

    const jwks = getPlatformJwks(platform);
    const { payload } = await jwtVerify(id_token, jwks, {
      issuer: platform.issuer,
      audience: platform.client_id,
    });

    if (payload.nonce !== stateRow.nonce) {
      logAdminEvent('lti_nonce_mismatch', `platform_id=${platform.id} tenant=${platform.tenant_key}`, req);
      return res.status(400).send('Nonce mismatch -- possible replay, rejecting launch.');
    }
    const messageType = payload['https://purl.imsglobal.org/spec/lti/claim/message_type'];
    const ltiVersion = payload['https://purl.imsglobal.org/spec/lti/claim/version'];
    const deploymentId = payload['https://purl.imsglobal.org/spec/lti/claim/deployment_id'];
    if (ltiVersion !== '1.3.0' || !['LtiResourceLinkRequest', 'LtiDeepLinkingRequest'].includes(messageType)) {
      logAdminEvent('lti_unsupported_message', `type=${messageType} version=${ltiVersion} platform_id=${platform.id}`, req);
      return res.status(400).send(`Unsupported LTI message (type=${messageType}, version=${ltiVersion}).`);
    }
    if (!isKnownDeployment(platform.id, deploymentId)) {
      // Dynamic Registration doesn't always learn a deployment_id upfront
      // (Canvas typically doesn't; Moodle typically does) -- for platforms
      // that came in that way, the first deployment_id seen inside an
      // already-signature-verified launch is auto-registered rather than
      // rejected. Manually-registered platforms keep the original strict
      // behavior: matching a specific deployment_id the admin copied from
      // their LMS is itself a meaningful confirmation step for those.
      if (platform.dynamic_registration) {
        addDeployment(platform.id, deploymentId);
        logAdminEvent('deployment_auto_registered', `platform_id=${platform.id} tenant=${platform.tenant_key} deployment_id=${deploymentId}`, req);
      } else {
        logAdminEvent('lti_deployment_mismatch', `platform_id=${platform.id} tenant=${platform.tenant_key} deployment_id=${deploymentId}`, req);
        return res.status(400).send('Deployment ID does not match this platform\'s registration.');
      }
    }

    const roles = payload['https://purl.imsglobal.org/spec/lti/claim/roles'] || [];
    const internalRole = mapLtiRolesToInternalRole(roles);
    const isInstructor = internalRole !== 'student';

    // Deep Linking: the platform is asking the instructor to pick content
    // *inside* Rennix, not launching an already-created activity -- a
    // completely different response shape (a signed content-selection JWT
    // POSTed back to Moodle, not a redirect into the app). Branches off
    // before any of the resource-link-specific handling below.
    if (messageType === 'LtiDeepLinkingRequest') {
      return handleDeepLinkingRequest(req, res, payload, platform, isInstructor);
    }

    const context = payload['https://purl.imsglobal.org/spec/lti/claim/context'] || {};
    const resourceLink = payload['https://purl.imsglobal.org/spec/lti/claim/resource_link'] || {};

    const identity = {
      product: platform.product,
      tenantKey: platform.tenant_key,
      platformIssuer: platform.issuer,
      subject: payload.sub,
      name: payload.name || [payload.given_name, payload.family_name].filter(Boolean).join(' ') || 'Unknown',
      email: payload.email || null,
      role: isInstructor ? 'instructor' : 'student',
      courseId: context.id || null,
      courseTitle: context.title || context.label || null,
      courseLabel: context.label || null,
      resourceLinkId: resourceLink.id || null,
    };

    // "Rennix Analytics" is an instructor-only product -- a student
    // launching it should see that plainly, not silently land on the
    // generic student home page as if they'd launched the (student-facing)
    // Tutor Bot instead. That would make Analytics look like it has no real
    // boundary at all, which defeats the point of it being sold as its own
    // separate, instructor-only tool.
    if (platform.product === 'analytics' && !isInstructor) {
      logAdminEvent('lti_analytics_blocked_student', `tenant=${platform.tenant_key}`, req);
      return res.set('Content-Type', 'text/html').status(403).send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Instructor access only</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; background:#f7f8fa; margin:0; padding:40px; }
  .card { max-width:440px; margin:0 auto; background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:28px; text-align:center; }
  h1 { font-size:17px; margin:0 0 8px; color:#1a1a1a; }
  p { color:#57606a; font-size:13px; line-height:1.6; margin:0; }
</style></head>
<body>
  <div class="card">
    <h1>Instructor access only</h1>
    <p>Rennix Analytics is an instructor tool. Your account (${escapeHtml(identity.name)}) is signed in as a student in this course, so there's nothing to show here.</p>
  </div>
</body></html>`);
    }

    // Hand off into the actual product: mint the signed bridge token
    // tutor-service trusts, and land straight on the real instructor/student
    // app for this person's own tenant.
    const userid = await getOrAllocateUserId(platform.tenant_key, platform.issuer, payload.sub, identity.email);
    const role = internalRole;
    const bridgeToken = signBridgeToken({
      tenant: platform.tenant_key,
      userid,
      role,
      fullname: identity.name,
      email: identity.email,
      // Which of the two independently-registered External Tools this
      // launch came through -- 'analytics' vs 'tutor_bot'. tutor-service
      // uses this to show only what that product actually includes (an
      // "analytics"-only launch never sees the chat/quiz-authoring tools
      // that belong to the separate "tutor_bot" product).
      product: platform.product,
      courseId: identity.courseId,
      resourceLinkId: identity.resourceLinkId,
      // Display-only (never used for authorization): lets tutor-service show
      // this school's name and the LMS's own course title instead of a
      // hard-coded pilot course.
      courseTitle: identity.courseTitle,
      courseLabel: identity.courseLabel,
      tenantName: platform.tenant_name,
    });

    const nrpsClaim = payload['https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice'];

    // AGS: capture the platform's per-activity gradebook endpoint(s) so a
    // later score push (tutor-service calling POST /ags/score, see
    // src/lti/ags.js) has something to resolve resourceLinkId against. Only
    // present when the platform actually granted the AGS scope for this
    // activity; harmless no-op otherwise.
    const agsClaim = payload['https://purl.imsglobal.org/spec/lti-ags/claim/endpoint'];
    if (agsClaim && identity.resourceLinkId) {
      upsertAgsEndpoint(identity.resourceLinkId, {
        platformId: platform.id,
        tenantKey: platform.tenant_key,
        lineitemUrl: agsClaim.lineitem || null,
        lineitemsUrl: agsClaim.lineitems || null,
        scope: (agsClaim.scope || []).join(' '),
      });
    }

    logAdminEvent('lti_launch_success', `tenant=${platform.tenant_key} product=${platform.product} role=${role} course=${identity.courseId || 'none'} resourceLink=${identity.resourceLinkId || 'none'} nrps=${nrpsClaim ? 'yes' : 'no'} ags=${agsClaim ? 'yes' : 'no'}`, req);

    // If this activity was created via Deep Linking with a specific lecture
    // chosen, every subsequent resource-link launch of it carries that choice
    // back in the custom claim -- route straight into that lecture (students)
    // or its analytics (instructors) instead of the generic landing page.
    const customClaim = payload['https://purl.imsglobal.org/spec/lti/claim/custom'] || {};
    const deepLinkedLectureId = customClaim.rennix_lecture_id || null;
    let destPath = isInstructor ? '/app/instructor' : '/app/home';
    if (deepLinkedLectureId) {
      destPath = isInstructor ? '/instructor/video-analytics' : `/lecture/${encodeURIComponent(deepLinkedLectureId)}`;
    }
    // A companion activity with custom parameter rennix_view=chat is what the
    // LMS-side plugin (local_rennixtutorbot) frames next to lecture videos --
    // it wants just the Tutor Bot chat panel, for every role, not a full app page.
    if (customClaim.rennix_view === 'chat' && platform.product === 'tutor_bot') {
      destPath = '/widget/course/chat';
    }
    const dest = new URL(destPath, APP_BASE_URL);
    dest.searchParams.set('t', bridgeToken);
    if (deepLinkedLectureId && isInstructor) dest.searchParams.set('lecture_id', deepLinkedLectureId);
    res.redirect(303, dest.toString());

    // Fire-and-forget: never delay the user's redirect on a roster sync. Only
    // instructor-tier launches trigger it -- a student's own launch has no
    // more course-membership visibility than what NRPS already grants any
    // launch, but there's no reason to fetch+push the whole roster on every
    // single student click when one instructor launch a day covers it.
    if (nrpsClaim && nrpsClaim.context_memberships_url && isInstructor) {
      syncRosterViaNrps(platform, nrpsClaim.context_memberships_url).catch((err) => {
        logAdminEvent('nrps_sync_failed', `tenant=${platform.tenant_key} error=${err.message}`.slice(0, 500), null);
      });
    }
  } catch (err) {
    // err.message only -- never the id_token itself, which is the platform's
    // signed credential for this user, not something to persist in a log.
    logAdminEvent('lti_jwt_verification_failed', err.message, req);
    log.error('[LTI launch] verification failed:', err.message);
    res.status(400).send(launchErrorMessage(err));
  }
});

module.exports = { router };
