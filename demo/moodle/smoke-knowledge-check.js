// End-to-end check, as student1, of:
//   - the Rennix dashboard offered at the top of the course page
//   - the knowledge check offered under the lecture video, and that it loads
//     the lecture's questions and grades answers once the Tutor Bot panel next
//     to the video has signed the student in
// Usage: node smoke-knowledge-check.js     (no credentials or tokens are printed)

const { MOODLE, env, go, cookieHeader, moodleLogin } = require('./smoke-launch');

const COURSE_ID = process.argv[2] || '3';
const VIDEO_PAGE_CMID = process.argv[3] || '34';
const VIDEO = '1084537';
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) process.exitCode = 1; };
const configOf = (html) => {
  const m = html.match(/window\.RennixPlaybackConfig = (\{.*?\});<\/script>/);
  return m ? JSON.parse(m[1]) : null;
};
function extractForm(html, base) {
  const m = html.match(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
  if (!m) return null;
  const d = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  const fields = {};
  for (const i of m[2].matchAll(/<input[^>]*>/gi)) {
    const n = i[0].match(/name="([^"]*)"/i);
    const v = i[0].match(/value="([^"]*)"/i);
    if (n) fields[d(n[1])] = v ? d(v[1]) : '';
  }
  return { action: new URL(d(m[1]), base).toString(), fields };
}
async function followLaunch(url) {
  let p = await go(url);
  for (let s = 0; s < 4; s++) {
    const f = extractForm(p.html, p.url);
    if (!f || new URL(p.url).port === '3001') break;
    p = await go(f.action, { method: 'POST', form: f.fields });
  }
  return p;
}

async function main() {
  await moodleLogin('student1', env.STUDENT_PASSWORD);

  // Dashboard on the course page.
  const course = configOf((await go(`${MOODLE}/course/view.php?id=${COURSE_ID}`)).html);
  check(course && course.dashboardUrl, `course page offers the Rennix dashboard (${course && course.dashboardUrl})`);
  const dash = await followLaunch(course.dashboardUrl);
  check(new URL(dash.url).pathname === '/app/home', `dashboard launch lands on ${new URL(dash.url).pathname}`);
  check(/rennix-embed-height/.test(dash.html), 'dashboard page has the embedded-mode script (hides its own nav, reports height)');

  // Knowledge check on the video page.
  const video = configOf((await go(`${MOODLE}/mod/page/view.php?id=${VIDEO_PAGE_CMID}`)).html);
  check(video && video.knowledgeCheckUrl, `video page offers the knowledge check (${video && video.knowledgeCheckUrl})`);
  check(video && !video.dashboardUrl, 'dashboard is only on the course page, not the video page');
  const kcPage = await go(`${video.knowledgeCheckUrl}?video=${VIDEO}`);
  check(new URL(kcPage.url).pathname === '/widget/knowledge-check' && /Knowledge check/.test(kcPage.html),
    `knowledge-check URL opens the widget (${new URL(kcPage.url).origin}${new URL(kcPage.url).pathname})`);

  // The panel launch signs the student in; then the questions load.
  await followLaunch(video.chatUrl);
  const kc = await (await fetch(`http://localhost:3001/app/knowledge-check?video=${VIDEO}`, {
    headers: { cookie: cookieHeader('http://localhost:3001/') },
  })).json();
  check(kc.lecture && kc.questions.length === 4, `loads "${kc.lecture && kc.lecture.title}" with ${kc.questions && kc.questions.length} questions`);
  const q = kc.questions[0];
  const wrong = await (await fetch('http://localhost:3001/popups/respond', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader('http://localhost:3001/') },
    body: JSON.stringify({ popup_question_id: q.id, student_userid: 'session', selected_index: 0 }),
  })).json();
  check(wrong.correct === false && wrong.correct_index === 1 && /1275/.test(wrong.explanation || ''),
    `a wrong answer comes back with the right option and explanation ("${wrong.explanation}")`);
  const again = await (await fetch(`http://localhost:3001/app/knowledge-check?video=${VIDEO}`, {
    headers: { cookie: cookieHeader('http://localhost:3001/') },
  })).json();
  check(again.questions[0].answered === false, 'reloading the knowledge check remembers the previous answer');
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
