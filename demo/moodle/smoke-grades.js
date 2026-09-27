// End-to-end check of grade push (LTI AGS), as student1:
//   quick-check answer in tutor-service -> rennix-lti POST /ags/score ->
//   Moodle token.php (service token) -> Moodle gradebook
// Seeds two pop-up questions for the demo lecture, answers one correctly and
// one wrong, then reads the grade Moodle recorded for the Tutor Bot activity.
// Usage: node smoke-grades.js      (no credentials or tokens are printed)

const path = require('path');
const { execFileSync } = require('child_process');
const { env, go, cookieHeader, moodleLogin, ltiLinks, launchTool } = require('./smoke-launch');
const Database = require(path.join(__dirname, '..', '..', 'rennix-lti', 'node_modules', 'better-sqlite3'));

const COURSE_ID = process.argv[2] || '3';
const TUTOR_DB = path.join(__dirname, '..', 'data', 'tutor', 'tutor.db');
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function moodleGrade(username, activityName) {
  const php = `define("CLI_SCRIPT",1); require "/var/www/html/config.php"; require_once($CFG->libdir."/gradelib.php");
    $u = $DB->get_record("user", ["username"=>"${username}"]);
    $lti = $DB->get_record("lti", ["course"=>${COURSE_ID}, "name"=>"${activityName}"]);
    $g = grade_get_grades(${COURSE_ID}, "mod", "lti", $lti->id, $u->id);
    $item = $g->items[0] ?? null; $grade = $item ? ($item->grades[$u->id]->grade ?? null) : null;
    echo json_encode(["grade"=>$grade, "max"=>$item ? (float)$item->grademax : null]);`;
  return JSON.parse(execFileSync('docker', ['exec', 'rennix-local-moodle-moodle-1', 'php', '-r', php],
    { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim());
}

async function main() {
  // Two quick-check questions on the demo lecture (idempotent).
  const tdb = new Database(TUTOR_DB);
  tdb.prepare("DELETE FROM popup_responses WHERE popup_question_id IN (SELECT id FROM popup_questions WHERE lecture_id = 'for-loop-practical' AND placement = 'in_video')").run();
  tdb.prepare("DELETE FROM popup_questions WHERE lecture_id = 'for-loop-practical' AND placement = 'in_video'").run();
  const addQ = tdb.prepare('INSERT INTO popup_questions (lecture_id, timestamp, question, options, correct_index, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const q1 = addQ.run('for-loop-practical', 60, 'How many times does for (i = 0; i < 3; i++) run?', JSON.stringify(['2', '3', '4']), 1, Date.now()).lastInsertRowid;
  const q2 = addQ.run('for-loop-practical', 120, 'Which part of a for loop runs once?', JSON.stringify(['init', 'condition', 'update']), 0, Date.now()).lastInsertRowid;
  const totalQuestions = tdb.prepare("SELECT COUNT(*) AS n FROM popup_questions WHERE status = 'approved'").get().n;
  tdb.close();

  await moodleLogin('student1', env.STUDENT_PASSWORD);
  const tool = (await ltiLinks(COURSE_ID)).find((l) => /Tutor Bot/.test(l.name));
  await launchTool(tool.cmid);
  const answer = (qid, idx) => fetch('http://localhost:3001/popups/respond', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieHeader('http://localhost:3001/') },
    body: JSON.stringify({ popup_question_id: Number(qid), student_userid: 'ignored-server-uses-session', selected_index: idx }),
  }).then((r) => r.json());

  const a1 = await answer(q1, 1); // correct
  const a2 = await answer(q2, 2); // wrong
  check(a1.correct === true && a2.correct === false, 'quick-check answers recorded (1 right, 1 wrong)');

  const expected = Math.round((1 / totalQuestions) * 1000) / 10;
  let got = null;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    got = moodleGrade('student1', 'Rennix Tutor Bot');
    if (got.grade !== null && Math.abs(Number(got.grade) - expected) < 0.01) break;
  }
  console.log(`      Moodle gradebook: ${got.grade} / ${got.max} (expected ${expected}, from 1 correct of ${totalQuestions} questions)`);
  check(got.grade !== null && Math.abs(Number(got.grade) - expected) < 0.01, 'grade landed in the Moodle gradebook for the Tutor Bot activity');
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
