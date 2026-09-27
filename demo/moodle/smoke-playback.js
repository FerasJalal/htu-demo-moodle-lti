// End-to-end check of Vimeo "option B" + course branding, as student1:
//   1. the Moodle video page carries the tracker config (local_rennixtutorbot hook)
//   2. launching the Tutor Bot shows the LMS course title (not hard-coded CS101)
//   3. a position report signed by Moodle (exactly what the tracker sends) is
//      accepted by rennix-lti and relayed to tutor-service
//   4. tutor-service's chat widget sees "lecture X at 2:45, paused"
// Usage: node smoke-playback.js     (no credentials or tokens are printed)

const { MOODLE, env, go, cookieHeader, moodleLogin, ltiLinks, launchTool } = require('./smoke-launch');

const VIDEO_PAGE_CMID = process.argv[2] || '34';
const COURSE_ID = process.argv[3] || '3';
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) process.exitCode = 1; };

async function main() {
  await moodleLogin('student1', env.STUDENT_PASSWORD);

  // 1. The tracker is on the video page, configured for this student.
  const videoPage = await go(`${MOODLE}/mod/page/view.php?id=${VIDEO_PAGE_CMID}`);
  const cfgMatch = videoPage.html.match(/window\.RennixPlaybackConfig = (\{.*?\});<\/script>/);
  const cfg = cfgMatch ? JSON.parse(cfgMatch[1]) : null;
  check(!!cfg && /\/lti\/playback$/.test(cfg.endpoint), `video page injects tracker config (endpoint ${cfg && cfg.endpoint})`);
  check(/vimeo_tracker\.js/.test(videoPage.html), 'video page loads vimeo_tracker.js');
  check(/player\.vimeo\.com\/video\/1084537/.test(videoPage.html), 'video page has the Vimeo embed');

  // 2. Tutor Bot launch (also gives us the tutor-service session cookie).
  const tool = (await ltiLinks(COURSE_ID)).find((l) => /Tutor Bot/.test(l.name));
  const home = await launchTool(tool.cmid);
  check(home.url.startsWith('http://localhost:3001/app/home'), `Tutor Bot launch lands on ${new URL(home.url).pathname}`);
  const widget = await go('http://localhost:3001/widget/course/chat');
  const header = (widget.html.match(/Course Tutor — ask about ([^<]+)</) || [])[1];
  check(header && !/CS101/.test(header), `chat header uses the LMS course: "${header}"`);

  // 3. Report "paused at 2:45" the way the tracker does.
  const resp = await fetch(cfg.endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: cfg.token, videoRef: '1084537', position: 165, state: 'paused' }),
  });
  check(resp.status === 204, `rennix-lti accepted the Moodle-signed report (HTTP ${resp.status})`);

  // 4. What the chat widget will use for the next question.
  const ctx = await (await fetch('http://localhost:3001/app/playback-context', {
    headers: { cookie: cookieHeader('http://localhost:3001/') },
  })).json();
  console.log('      playback-context:', JSON.stringify(ctx));
  check(ctx.active && ctx.lecture_id === 'for-loop-practical' && ctx.position === 165 && ctx.state === 'paused',
    'chat widget sees lecture "For Loop- Practical Examples" at 2:45 (paused)');

  // A tampered token must not be accepted.
  const bad = await fetch(cfg.endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: cfg.token.slice(0, -4) + 'AAAA', videoRef: '1084537', position: 10, state: 'paused' }),
  });
  check(bad.status === 401, `tampered token rejected (HTTP ${bad.status})`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
