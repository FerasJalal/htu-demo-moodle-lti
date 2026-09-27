const crypto = require('crypto');
const express = require('express');
const { SignJWT } = require('jose');
const { db } = require('../db');
const { logAdminEvent } = require('../audit');
const { getToolKeyPair } = require('../security/toolKeys');
const { escapeHtml } = require('../util/html');
const log = require('../log');
const { APP_BASE_URL, TENANT_ADMIN_SECRET } = require('../config');

// Same reasoning as src/lti/launch.js's launchErrorMessage: the raw
// exception text is useful to us (it's always in the audit log), not to
// whatever's rendering this page inside the LMS.
function deepLinkErrorMessage(err) {
  if (process.env.NODE_ENV === 'production') {
    return 'Deep linking failed. Contact your LMS administrator.';
  }
  return `Deep linking failed: ${err.message}`;
}

// ---- Deep Linking: let an instructor pick real content inside Rennix while
// adding the activity in Moodle, instead of creating one generic External Tool
// activity and always landing on the same page. Real content only -- the
// picker queries tutor-service's actual lecture list, nothing invented. ----
async function fetchTenantLectures(tenantKey) {
  const url = new URL('/content/lectures', APP_BASE_URL);
  url.searchParams.set('tenant', tenantKey);
  const resp = await fetch(url, { headers: { 'x-tenant-admin-secret': TENANT_ADMIN_SECRET } });
  if (!resp.ok) throw new Error(`tutor-service /content/lectures returned ${resp.status}`);
  const data = await resp.json();
  return data.lectures || [];
}

function renderDeepLinkPicker(sessionId, platform, pickerItems, fetchError) {
  const productLabel = platform.product === 'analytics' ? 'Rennix Analytics' : 'Rennix Tutor Bot';
  const generalTitle = platform.product === 'analytics' ? 'Rennix Analytics dashboard (whole course)' : 'General Tutor Bot (course-wide, no specific lecture)';
  const generalLink = `/lti/deep-link/select?session=${sessionId}&title=${encodeURIComponent(generalTitle)}`;
  const items = pickerItems.map((it) => {
    const label = `${it.chapterTitle} — ${it.title}`;
    const href = `/lti/deep-link/select?session=${sessionId}&lecture_id=${encodeURIComponent(it.lecture_id)}&title=${encodeURIComponent(label)}`;
    return `<a class="item" href="${href}">${escapeHtml(label)}</a>`;
  }).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Add ${escapeHtml(productLabel)}</title>
<style>
  body { font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif; background:#f7f8fa; margin:0; padding:32px 16px; }
  .card { max-width:560px; margin:0 auto; background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:24px; }
  h1 { font-size:18px; margin:0 0 4px; }
  p.sub { color:#57606a; font-size:13px; margin:0 0 16px; }
  .item { display:block; padding:10px 12px; border:1px solid #e2e8f0; border-radius:8px; margin-bottom:8px; text-decoration:none; color:#1a1a1a; font-size:13px; }
  .item:hover { border-color:#d41128; }
  .item.default { font-weight:700; margin-bottom:16px; }
  .err { color:#a10f22; font-size:12px; margin-bottom:12px; }
  .list { max-height:360px; overflow-y:auto; }
</style></head>
<body>
  <div class="card">
    <h1>Add ${escapeHtml(productLabel)}</h1>
    <p class="sub">Choose what this activity should link to.</p>
    ${fetchError ? `<div class="err">Couldn't load the lecture list (${escapeHtml(fetchError)}) -- only the general option is available.</div>` : ''}
    <a class="item default" href="${generalLink}">${escapeHtml(generalTitle)}</a>
    ${items ? `<div class="list">${items}</div>` : ''}
  </div>
</body></html>`;
}

async function handleDeepLinkingRequest(req, res, payload, platform, isInstructor) {
  if (!isInstructor) {
    logAdminEvent('deep_link_blocked_student', `tenant=${platform.tenant_key}`, req);
    return res.status(403).send('Only instructors can select content to add to a course.');
  }
  const dlSettings = payload['https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings'];
  if (!dlSettings || !dlSettings.deep_link_return_url) {
    return res.status(400).send('Missing deep linking settings in the launch.');
  }

  const sessionId = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO lti_dl_sessions (id, platform_id, deep_link_return_url, data, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, platform.id, dlSettings.deep_link_return_url, dlSettings.data || null, Date.now());

  let pickerItems = [];
  let fetchError = null;
  if (platform.product === 'tutor_bot') {
    try {
      pickerItems = await fetchTenantLectures(platform.tenant_key);
    } catch (err) {
      fetchError = err.message;
      logAdminEvent('deep_link_content_fetch_failed', `tenant=${platform.tenant_key} error=${err.message}`, req);
    }
  }

  logAdminEvent('deep_link_picker_shown', `tenant=${platform.tenant_key} product=${platform.product} items=${pickerItems.length}`, req);
  res.set('Content-Type', 'text/html').send(renderDeepLinkPicker(sessionId, platform, pickerItems, fetchError));
}

const router = express.Router();
router.get('/lti/deep-link/select', async (req, res) => {
  try {
    const { session, lecture_id, title } = req.query;
    const dlSession = db.prepare('SELECT * FROM lti_dl_sessions WHERE id = ?').get(session);
    if (!dlSession) return res.status(400).send('Unknown or expired selection session -- restart from Moodle.');
    db.prepare('DELETE FROM lti_dl_sessions WHERE id = ?').run(session); // single-use
    if (Date.now() - dlSession.created_at > 10 * 60 * 1000) {
      return res.status(400).send('This selection session expired -- restart from Moodle.');
    }

    const platform = db.prepare('SELECT * FROM platforms WHERE id = ?').get(dlSession.platform_id);
    if (!platform) return res.status(400).send('Platform no longer registered.');

    const contentItem = {
      type: 'ltiResourceLink',
      title: title ? String(title).slice(0, 200) : (platform.product === 'analytics' ? 'Rennix Analytics' : 'Rennix Tutor Bot'),
      url: `${req.protocol}://${req.get('host')}/lti/launch`,
    };
    if (lecture_id) contentItem.custom = { rennix_lecture_id: String(lecture_id) };

    const { privateKey, kid } = await getToolKeyPair();
    const now = Math.floor(Date.now() / 1000);
    const responseJwt = await new SignJWT({
      'https://purl.imsglobal.org/spec/lti/claim/deployment_id': platform.deployment_id,
      'https://purl.imsglobal.org/spec/lti/claim/message_type': 'LtiDeepLinkingResponse',
      'https://purl.imsglobal.org/spec/lti/claim/version': '1.3.0',
      'https://purl.imsglobal.org/spec/lti-dl/claim/content_items': [contentItem],
      ...(dlSession.data ? { 'https://purl.imsglobal.org/spec/lti-dl/claim/data': dlSession.data } : {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(platform.client_id)
      .setAudience(platform.issuer)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);

    logAdminEvent('deep_link_response_sent', `tenant=${platform.tenant_key} product=${platform.product} lecture_id=${lecture_id || 'none'}`, req);

    res.set('Content-Type', 'text/html').send(`<!doctype html><html><body onload="document.forms[0].submit()">
  <form method="POST" action="${escapeHtml(dlSession.deep_link_return_url)}">
    <input type="hidden" name="JWT" value="${escapeHtml(responseJwt)}">
  </form>
  <p>Adding content to your course&hellip;</p>
</body></html>`);
  } catch (err) {
    logAdminEvent('deep_link_response_failed', err.message, req);
    log.error('[LTI deep-link] response failed:', err.message);
    res.status(500).send(deepLinkErrorMessage(err));
  }
});

module.exports = { router, handleDeepLinkingRequest };
