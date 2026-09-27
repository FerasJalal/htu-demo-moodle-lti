// Smoke test: sign in to the local Moodle as a test user and follow a real LTI
// launch of each Rennix tool all the way to tutor-service, like a browser would.
// Usage: node smoke-launch.js [teacher1|student1] [courseId]   (password read from .env, never printed)

const fs = require('fs');
const path = require('path');

const MOODLE = 'http://localhost:8085';
const who = process.argv[2] || 'teacher1';
const courseId = process.argv[3] || '3'; // Programming-Summer/26 (All Section)
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
  .split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const password = who === 'student1' ? env.STUDENT_PASSWORD : env.TEACHER_PASSWORD;

const jars = new Map(); // host -> { name: value }
function cookieHeader(url) {
  const jar = jars.get(new URL(url).host) || {};
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}
function storeCookies(url, res) {
  const host = new URL(url).host;
  const jar = jars.get(host) || {};
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  jars.set(host, jar);
}

// Follows redirects by hand so cookies are kept per host. Returns the final page.
async function go(url, { method = 'GET', form } = {}) {
  const hops = [];
  for (let i = 0; i < 15; i++) {
    const res = await fetch(url, {
      method, redirect: 'manual',
      headers: { cookie: cookieHeader(url), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    storeCookies(url, res);
    hops.push(`${res.status} ${new URL(url).host}${new URL(url).pathname}`);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).toString();
      method = 'GET'; form = undefined;
      continue;
    }
    return { url, status: res.status, html: await res.text(), hops };
  }
  throw new Error('too many redirects');
}

// Auto-submitting forms (Moodle launch -> tool login, Moodle auth -> tool launch).
function extractForm(html, baseUrl) {
  const m = html.match(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
  if (!m) return null;
  const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const fields = {};
  for (const inp of m[2].matchAll(/<input[^>]*>/gi)) {
    const name = inp[0].match(/name="([^"]*)"/i);
    const value = inp[0].match(/value="([^"]*)"/i);
    if (name) fields[decode(name[1])] = value ? decode(value[1]) : '';
  }
  return { action: new URL(decode(m[1]), baseUrl).toString(), fields };
}

async function main() {
  await moodleLogin(who, password);
  console.log(`signed in to Moodle as ${who}`);

  for (const { cmid, name } of await ltiLinks(courseId)) {
    const page = await launchTool(cmid);
    const title = (page.html.match(/<title>([^<]*)<\/title>/) || [])[1] || '(no title)';
    const body = page.html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(`\n${name.trim()}: ended at ${page.status} ${new URL(page.url).origin}${new URL(page.url).pathname}`);
    console.log(`  title: ${title}`);
    if (new URL(page.url).port !== '3001') console.log(`  page says: ${body.slice(0, 300)}`);
  }
}

async function moodleLogin(username, pw) {
  const login = await go(`${MOODLE}/login/index.php`);
  const logintoken = login.html.match(/name="logintoken" value="([^"]+)"/)[1];
  const after = await go(`${MOODLE}/login/index.php`, { method: 'POST', form: { username, password: pw, logintoken } });
  if (/loginerrormessage|Invalid login/i.test(after.html)) throw new Error('Moodle login failed');
}

// [{cmid, name}] of the External Tool activities on a course page.
async function ltiLinks(id) {
  const course = await go(`${MOODLE}/course/view.php?id=${id}`);
  const links = [...course.html.matchAll(/href="([^"]*\/mod\/lti\/view\.php\?id=(\d+))"[^>]*>[\s\S]*?<span class="instancename">([^<]+)/g)];
  const seen = new Set();
  return links.filter(([, , cmid]) => !seen.has(cmid) && seen.add(cmid)).map(([, , cmid, name]) => ({ cmid, name: name.trim() }));
}

// launch.php -> (form POST) rennix-lti /lti/login -> Moodle auth.php -> (form POST) rennix-lti /lti/launch -> tutor-service
async function launchTool(cmid) {
  let page = await go(`${MOODLE}/mod/lti/launch.php?id=${cmid}&triggerview=0`);
  for (let step = 0; step < 4; step++) {
    const f = extractForm(page.html, page.url);
    if (!f || new URL(page.url).port === '3001') break;
    page = await go(f.action, { method: 'POST', form: f.fields });
  }
  return page;
}

module.exports = { MOODLE, env, go, cookieHeader, moodleLogin, ltiLinks, launchTool };
if (require.main === module) main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
