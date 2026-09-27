const crypto = require('crypto');
const express = require('express');
const { db, sweepExpiredRegistrationSessions, registerDynamicPlatform } = require('../db');
const { logAdminEvent } = require('../audit');
const { escapeHtml } = require('../util/html');
const log = require('../log');
const { NRPS_SCOPE } = require('./nrps');
const { AGS_SCOPES } = require('./ags');

// ---- LTI 1.3 Dynamic Registration (imsglobal.org/spec/lti-dr/v1p0) ----
// The platform (an admin adding Rennix as an External Tool from a
// registration-capable LMS -- Canvas, newer Moodle) sends the admin's
// browser here, usually in a popup/iframe the LMS itself opens. Unlike a
// resource-link launch, there's no signed id_token yet at this point --
// nothing here is a verified identity claim, it's a one-time setup flow
// that ends with us registering as a proper OAuth/LTI client of that
// platform.
const router = express.Router();

router.get('/lti/register', async (req, res) => {
  sweepExpiredRegistrationSessions();
  const { openid_configuration: openidConfigUrl, registration_token: registrationToken } = req.query;
  if (!openidConfigUrl) {
    return res.status(400).send('Missing openid_configuration.');
  }

  let openidConfig;
  try {
    const resp = await fetch(String(openidConfigUrl));
    if (!resp.ok) throw new Error(`platform returned ${resp.status}`);
    openidConfig = await resp.json();
  } catch (err) {
    log.error('[dynamic registration] failed to fetch openid_configuration:', err.message);
    return res.status(400).send('Could not fetch the platform\'s openid_configuration.');
  }

  const required = ['issuer', 'authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'jwks_uri'];
  const missing = required.filter((k) => !openidConfig[k]);
  if (missing.length) {
    return res.status(400).send(`Platform's openid_configuration is missing: ${missing.join(', ')}`);
  }

  const sessionId = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO lti_registration_sessions (id, openid_config, registration_token, created_at) VALUES (?, ?, ?, ?)')
    .run(sessionId, JSON.stringify(openidConfig), registrationToken || null, Date.now());

  logAdminEvent('dynamic_registration_started', `issuer=${openidConfig.issuer}`, req);
  res.set('Content-Type', 'text/html').send(renderPickerPage(sessionId, openidConfig));
});

function renderPickerPage(sessionId, openidConfig) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Register Rennix</title>
<style>
  body { font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif; background:#f7f8fa; margin:0; padding:32px 16px; }
  .card { max-width:480px; margin:0 auto; background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:24px; }
  h1 { font-size:18px; margin:0 0 4px; }
  p.sub { color:#57606a; font-size:13px; margin:0 0 16px; }
  label { display:block; font-weight:700; font-size:13px; margin:14px 0 4px; }
  input, select { width:100%; box-sizing:border-box; padding:9px 10px; border:1px solid #ccc; border-radius:6px; font-size:13px; }
  button { margin-top:20px; padding:10px 18px; border:none; border-radius:8px; background:#d41128; color:#fff; font-weight:700; cursor:pointer; }
</style></head>
<body>
  <div class="card">
    <h1>Register Rennix</h1>
    <p class="sub">Registering with <strong>${escapeHtml(openidConfig.issuer)}</strong>. Choose what this registration is for.</p>
    <form method="post" action="/lti/register/complete">
      <input type="hidden" name="session" value="${escapeHtml(sessionId)}">
      <label>Product</label>
      <select name="product">
        <option value="tutor_bot">Rennix Tutor Bot</option>
        <option value="analytics">Rennix Analytics</option>
      </select>
      <label>Tenant key (slug, e.g. "htu")</label>
      <input name="tenantKey" required pattern="[a-z0-9-]+" title="lowercase letters, numbers, hyphens only">
      <label>Tenant name</label>
      <input name="tenantName" placeholder="e.g. Al-Hussein Technical University" required>
      <button type="submit">Complete registration</button>
    </form>
  </div>
</body></html>`;
}

router.post('/lti/register/complete', async (req, res) => {
  const { session, product, tenantKey, tenantName } = req.body;
  const sessionRow = db.prepare('SELECT * FROM lti_registration_sessions WHERE id = ?').get(session);
  if (!sessionRow) return res.status(400).send('Unknown or expired registration session -- restart from your LMS.');
  db.prepare('DELETE FROM lti_registration_sessions WHERE id = ?').run(session); // single-use

  const openidConfig = JSON.parse(sessionRow.openid_config);
  const origin = `${req.protocol}://${req.get('host')}`;

  const registrationRequest = {
    application_type: 'web',
    response_types: ['id_token'],
    grant_types: ['client_credentials', 'implicit'],
    initiate_login_uri: `${origin}/lti/login`,
    redirect_uris: [`${origin}/lti/launch`],
    client_name: product === 'analytics' ? 'Rennix Analytics' : 'Rennix Tutor Bot',
    jwks_uri: `${origin}/lti/jwks`,
    token_endpoint_auth_method: 'private_key_jwt',
    scope: `${NRPS_SCOPE} ${AGS_SCOPES}`,
    'https://purl.imsglobal.org/spec/lti-tool-configuration': {
      domain: req.get('host'),
      target_link_uri: `${origin}/lti/launch`,
      claims: ['iss', 'sub', 'name', 'email'],
      messages: [
        { type: 'LtiResourceLinkRequest' },
        { type: 'LtiDeepLinkingRequest', target_link_uri: `${origin}/lti/launch` },
      ],
    },
  };

  let clientId;
  let deploymentId = null;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (sessionRow.registration_token) headers.Authorization = `Bearer ${sessionRow.registration_token}`;
    const resp = await fetch(openidConfig.registration_endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(registrationRequest),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`registration_endpoint returned ${resp.status}: ${text.slice(0, 200)}`);
    }
    const body = await resp.json();
    if (!body.client_id) throw new Error('registration response had no client_id');
    clientId = body.client_id;
    const toolConfig = body['https://purl.imsglobal.org/spec/lti-tool-configuration'];
    deploymentId = (toolConfig && toolConfig.deployment_id) || null;
  } catch (err) {
    log.error('[dynamic registration] registration_endpoint call failed:', err.message);
    logAdminEvent('dynamic_registration_failed', err.message, req);
    return res.status(502).send('Registration with the platform failed. Contact your LMS administrator.');
  }

  try {
    registerDynamicPlatform({
      product,
      tenantKey,
      tenantName,
      issuer: openidConfig.issuer,
      clientId,
      deploymentId,
      authLoginUrl: openidConfig.authorization_endpoint,
      authTokenUrl: openidConfig.token_endpoint,
      jwksUrl: openidConfig.jwks_uri,
    });
  } catch (err) {
    return res.status(400).send(`Registration succeeded with the platform but saving it failed: ${escapeHtml(err.message)}`);
  }

  logAdminEvent('dynamic_registration_completed', `${product} / ${tenantKey} issuer=${openidConfig.issuer} client_id=${clientId}`, req);
  res.set('Content-Type', 'text/html').send(renderCompletePage());
});

function renderCompletePage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Registration complete</title>
<style>
  body { font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif; background:#f7f8fa; margin:0; padding:60px 16px; text-align:center; }
  .card { max-width:400px; margin:0 auto; background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:28px; }
  h1 { font-size:18px; color:#1f9d55; margin-top:0; }
  p { color:#57606a; font-size:13px; }
</style></head>
<body>
  <div class="card">
    <h1>&#10003; Rennix is registered</h1>
    <p>You can close this window.</p>
  </div>
  <script>
    // The spec-defined signal a platform's registration popup listens for
    // to know registration finished and it can close itself.
    if (window.opener) {
      window.opener.postMessage({ subject: 'org.imsglobal.lti.close' }, '*');
    }
  </script>
</body></html>`;
}

module.exports = { router };
