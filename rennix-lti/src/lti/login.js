const crypto = require('crypto');
const express = require('express');
const { db, sweepExpiredStates, getPlatform } = require('../db');
const { rateLimit } = require('../rateLimit');

// ---- Step 1: OIDC third-party initiated login ----
// The LTI 1.3 / OIDC spec allows the platform to send this via GET or POST
// (its choice); Moodle uses POST (a form_post autosubmit), so both must work.
function handleLtiLogin(req, res) {
  sweepExpiredStates();
  const params = req.method === 'POST' ? req.body : req.query;
  const { iss, login_hint, target_link_uri, client_id, lti_message_hint } = params;
  if (!iss || !login_hint || !target_link_uri) {
    return res.status(400).send('Missing required LTI login parameters (iss, login_hint, target_link_uri).');
  }

  const platform = getPlatform({ issuer: iss, clientId: client_id });
  if (!platform) {
    return res.status(400).send(`Unknown platform (issuer=${iss}${client_id ? `, client_id=${client_id}` : ''}). Register it first via /admin/platforms.`);
  }

  const state = crypto.randomBytes(24).toString('base64url');
  const nonce = crypto.randomBytes(24).toString('base64url');
  db.prepare(
    'INSERT INTO lti_states (state, nonce, platform_id, target_link_uri, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(state, nonce, platform.id, String(target_link_uri), Date.now());

  const authUrl = new URL(platform.auth_login_url);
  authUrl.searchParams.set('scope', 'openid');
  authUrl.searchParams.set('response_type', 'id_token');
  authUrl.searchParams.set('client_id', platform.client_id);
  authUrl.searchParams.set('redirect_uri', `${req.protocol}://${req.get('host')}/lti/launch`);
  authUrl.searchParams.set('login_hint', String(login_hint));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('response_mode', 'form_post');
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('prompt', 'none');
  if (lti_message_hint) authUrl.searchParams.set('lti_message_hint', String(lti_message_hint));

  res.redirect(302, authUrl.toString());
}

const router = express.Router();
const ltiEntryRateLimit = rateLimit('lti-login', 30, 60 * 1000);
router.get('/lti/login', ltiEntryRateLimit, handleLtiLogin);
router.post('/lti/login', ltiEntryRateLimit, handleLtiLogin);

module.exports = { router, handleLtiLogin };
