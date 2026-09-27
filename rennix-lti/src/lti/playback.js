const express = require('express');
const { decodeJwt, jwtVerify } = require('jose');
const { db, getPlatform } = require('../db');
const { getPlatformJwks } = require('./platformJwks');
const { rateLimit } = require('../rateLimit');
const { APP_BASE_URL, TENANT_ADMIN_SECRET } = require('../config');
const log = require('../log');

// ---- Video position reports from LMS-hosted Vimeo players ("option B") ----
// Institutions like HTU play lectures as Vimeo embeds inside their own LMS
// pages, which this service and tutor-service can't see into. The LMS-side
// plugin (local_rennixtutorbot) watches those players and posts play/pause/
// seek positions here, authenticated with a short-lived JWT the LMS signs with
// its own LTI platform key -- the same key we already trust for launches, so
// there's no extra shared secret to provision. We verify it, map the LMS user
// to the tenant's userid exactly as a launch would, and relay the position to
// tutor-service so the Tutor Bot can answer "at 2:45" questions from that
// moment of the lecture.

// Distinguishes these tokens from every other JWT the LMS signs with the same
// key (an LTI id_token also has iss/aud/sub) -- a captured launch token must
// not double as a playback credential.
const PLAYBACK_PURPOSE_CLAIM = 'https://rennix.ai/claim/purpose';
const PLAYBACK_PURPOSE = 'video_playback';
const STATES = ['playing', 'paused', 'ended'];

async function verifyPlaybackToken(token) {
  let unverified;
  try {
    unverified = decodeJwt(token);
  } catch (err) {
    throw Object.assign(new Error('Malformed token.'), { status: 400 });
  }
  const clientId = Array.isArray(unverified.aud) ? unverified.aud[0] : unverified.aud;
  const platform = unverified.iss && clientId ? getPlatform({ issuer: unverified.iss, clientId }) : null;
  if (!platform) throw Object.assign(new Error('Unknown platform.'), { status: 401 });
  const { payload } = await jwtVerify(token, getPlatformJwks(platform), {
    issuer: platform.issuer,
    audience: platform.client_id,
    requiredClaims: ['exp', 'sub'],
    maxTokenAge: '12h',
  });
  if (payload[PLAYBACK_PURPOSE_CLAIM] !== PLAYBACK_PURPOSE) {
    throw Object.assign(new Error('Not a playback token.'), { status: 401 });
  }
  return { platform, payload };
}

function validateReport(body) {
  const videoRef = String(body.videoRef || '');
  const position = Number(body.position);
  const state = String(body.state || '');
  if (!/^\d{1,20}$/.test(videoRef)) return 'videoRef must be a Vimeo video id.';
  if (!Number.isFinite(position) || position < 0 || position > 24 * 3600) return 'position must be seconds into the video.';
  if (!STATES.includes(state)) return `state must be one of ${STATES.join(', ')}.`;
  return null;
}

const router = express.Router();

// 240/min per IP is ~1 report every 15s for a whole computer lab behind one NAT.
router.post('/lti/playback', rateLimit('lti-playback', 240, 60 * 1000), async (req, res) => {
  const body = req.body || {};
  const invalid = validateReport(body);
  if (invalid) return res.status(400).json({ error: invalid });
  if (!body.token) return res.status(401).json({ error: 'Missing token.' });

  let platform;
  let payload;
  try {
    ({ platform, payload } = await verifyPlaybackToken(String(body.token)));
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.status ? err.message : 'Invalid token.' });
  }

  // Only students who already reached Rennix through a launch have a userid;
  // there's nothing to attach a position to before that (and no Tutor Bot
  // session to ask from), so this is a quiet no-op rather than an error.
  const mapped = db.prepare(
    'SELECT userid FROM lti_user_map WHERE tenant_key = ? AND platform_issuer = ? AND subject = ?'
  ).get(platform.tenant_key, platform.issuer, String(payload.sub));
  if (!mapped) return res.status(202).json({ ok: false, reason: 'User has not launched Rennix yet.' });

  if (!TENANT_ADMIN_SECRET) return res.status(503).json({ error: 'Relay to tutor-service is not configured.' });
  try {
    const resp = await fetch(new URL('/admin/playback', APP_BASE_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-admin-secret': TENANT_ADMIN_SECRET },
      body: JSON.stringify({
        tenant: platform.tenant_key,
        userid: mapped.userid,
        videoRef: String(body.videoRef),
        position: Number(body.position),
        state: String(body.state),
        courseId: payload.course_id ? String(payload.course_id) : null,
      }),
    });
    if (!resp.ok) {
      log.error('[playback] tutor-service relay failed with', resp.status);
      return res.status(502).json({ error: 'Relay failed.' });
    }
  } catch (err) {
    log.error('[playback] tutor-service relay failed:', err.message);
    return res.status(502).json({ error: 'Relay failed.' });
  }
  res.status(204).end();
});

// The knowledge check framed under each lecture video. The LMS plugin only
// knows this service's URL (its configured tool), not tutor-service's, so it
// frames this and we forward. The Vimeo id is the only input and is validated.
router.get('/embed/knowledge-check', (req, res) => {
  const video = String(req.query.video || '');
  if (!/^\d{1,20}$/.test(video)) return res.status(400).send('video must be a Vimeo id.');
  const dest = new URL('/widget/knowledge-check', APP_BASE_URL);
  dest.searchParams.set('video', video);
  res.redirect(302, dest.toString());
});

module.exports = { router, verifyPlaybackToken, validateReport, PLAYBACK_PURPOSE_CLAIM, PLAYBACK_PURPOSE };
