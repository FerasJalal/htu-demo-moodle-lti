const crypto = require('crypto');
const express = require('express');
const { SESSION_SECRET } = require('../config');

// Proof-of-concept landing page: decodes (does not re-verify -- it's our own
// HMAC-signed token, not the platform's) the session token and shows the
// identity that came through a real, cryptographically verified LTI launch.
// No longer used by the real flow (see src/lti/launch.js) -- harmless to
// keep as a debug page.
const router = express.Router();
router.get('/lti/launched', (req, res) => {
  const token = req.query.session;
  if (!token) return res.status(400).send('Missing session token.');
  const [body, sig] = String(token).split('.');
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (sig !== expectedSig) return res.status(400).send('Invalid session token.');
  const identity = JSON.parse(Buffer.from(body, 'base64url').toString());

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>LTI Launch Verified</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; background:#f7f8fa; margin:0; padding:40px; }
  .card { max-width:480px; margin:0 auto; background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:28px; }
  h1 { font-size:18px; margin-top:0; color:#1f9d55; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:6px 14px; font-size:13px; }
  dt { color:#8a94a6; font-weight:700; }
  dd { margin:0; }
</style></head>
<body>
  <div class="card">
    <h1>&#10003; LTI 1.3 launch verified</h1>
    <p style="color:#57606a; font-size:13px;">This identity came from a signature-verified id_token issued by your LMS -- not from anything the browser sent us directly.</p>
    <dl>
      <dt>Product</dt><dd>${identity.product === 'analytics' ? 'Rennix Analytics' : 'Rennix Tutor Bot'}</dd>
      <dt>Tenant</dt><dd>${identity.tenantKey}</dd>
      <dt>Platform</dt><dd>${identity.platformIssuer}</dd>
      <dt>Name</dt><dd>${identity.name}</dd>
      <dt>Email</dt><dd>${identity.email || '—'}</dd>
      <dt>Role</dt><dd>${identity.role}</dd>
      <dt>Course</dt><dd>${identity.courseTitle || identity.courseId || '—'}</dd>
    </dl>
  </div>
</body></html>`);
});

module.exports = { router };
