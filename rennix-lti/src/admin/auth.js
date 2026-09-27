const express = require('express');
const { logAdminEvent } = require('../audit');
const { rateLimit } = require('../rateLimit');
const { signAdminSession, verifyAdminSession, parseCookies, ADMIN_SESSION_MAX_AGE_MS } = require('../security/tokens');
const { ADMIN_SECRET } = require('../config');

// ---- Admin auth: register a platform (manual registration -- no Dynamic
// Registration support yet). Two ways in: a browser-facing session cookie
// (POST /admin/login) for humans, or the x-admin-secret header for
// scripted/API callers. Deliberately does NOT accept the secret from
// req.query or req.body anymore -- a query string ends up in browser
// history, proxy/access logs, and Referer headers; a POST body posted over
// TLS is safer but still means re-sending the secret on every single call
// instead of authenticating once. ----
function requireAdmin(req, res, next) {
  const headerSecret = req.get('x-admin-secret');
  if (ADMIN_SECRET && headerSecret && headerSecret === ADMIN_SECRET) return next();
  const cookies = parseCookies(req.headers.cookie);
  if (verifyAdminSession(cookies.admin_session)) return next();
  if (req.method === 'GET' && req.accepts('html')) return res.redirect('/admin/login');
  return res.status(401).json({ error: 'Missing or invalid admin credentials.' });
}

const router = express.Router();

router.get('/admin/login', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  if (verifyAdminSession(cookies.admin_session)) return res.redirect('/admin');
  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Admin sign-in</title>
<style>
  body { font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif; background:#f7f8fa; margin:0; padding:80px 16px; }
  .card { max-width:360px; margin:0 auto; background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:24px; }
  h1 { font-size:18px; margin:0 0 16px; }
  label { display:block; font-weight:700; font-size:13px; margin:0 0 6px; }
  input { width:100%; box-sizing:border-box; padding:9px 10px; border:1px solid #ccc; border-radius:6px; font-size:13px; }
  button { margin-top:16px; width:100%; padding:10px 18px; border:none; border-radius:8px; background:#d41128; color:#fff; font-weight:700; cursor:pointer; }
  .err { color:#a10f22; font-size:13px; margin-top:10px; }
</style></head>
<body>
  <div class="card">
    <h1>Admin sign-in</h1>
    <form method="post" action="/admin/login">
      <label>Admin secret</label>
      <input name="secret" type="password" required autofocus>
      <button type="submit">Sign in</button>
    </form>
    ${req.query.error ? '<div class="err">Invalid secret.</div>' : ''}
  </div>
</body></html>`);
});

router.post('/admin/login', rateLimit('admin-login', 5, 15 * 60 * 1000), (req, res) => {
  const provided = req.body && req.body.secret;
  if (!ADMIN_SECRET || provided !== ADMIN_SECRET) {
    logAdminEvent('admin_login_failed', null, req);
    return res.redirect('/admin/login?error=1');
  }
  logAdminEvent('admin_login_success', null, req);
  res.cookie('admin_session', signAdminSession(), {
    httpOnly: true, secure: true, sameSite: 'strict', maxAge: ADMIN_SESSION_MAX_AGE_MS,
  });
  res.redirect('/admin');
});

router.post('/admin/logout', (req, res) => {
  res.clearCookie('admin_session');
  res.redirect('/admin/login');
});

module.exports = { router, requireAdmin };
