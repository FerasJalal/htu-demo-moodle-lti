// Links the demo Vimeo video to a lecture in tutor-service and adds its
// knowledge-check questions, so the side panel, knowledge check and
// "paused at 2:45" context have something to show. Run once after
// `node start-all.js` has started tutor-service at least once (it creates the
// database). Safe to re-run.
//
// In a real deployment these come from ingesting the lecture transcript and
// generating questions with /quiz/generate, approved by an instructor in
// /quiz/review -- this just stands in for that without an OpenAI key.
// Usage: node seed-demo.js

const path = require('path');
const Database = require(path.join(__dirname, '..', 'rennix-lti', 'node_modules', 'better-sqlite3'));

const db = new Database(path.join(__dirname, 'data', 'tutor', 'tutor.db'));
const LECTURE = 'for-loop-practical';
const VIMEO_ID = '1084537'; // Blender's "Big Buck Bunny" (CC BY), embeddable

db.prepare(
  "INSERT INTO lectures (lecture_id, title, created_at, video_url, video_provider) VALUES (?, ?, ?, ?, 'vimeo') " +
  'ON CONFLICT(lecture_id) DO UPDATE SET video_url = excluded.video_url, video_provider = excluded.video_provider'
).run(LECTURE, 'For Loop- Practical Examples', Date.now(), VIMEO_ID);

db.prepare("DELETE FROM popup_responses WHERE popup_question_id IN (SELECT id FROM popup_questions WHERE lecture_id = ? AND placement = 'end_of_video')").run(LECTURE);
db.prepare("DELETE FROM popup_questions WHERE lecture_id = ? AND placement = 'end_of_video'").run(LECTURE);
const add = db.prepare(
  'INSERT INTO popup_questions (lecture_id, timestamp, question, options, correct_index, explanation, placement, status, created_at) ' +
  "VALUES (?, ?, ?, ?, ?, ?, 'end_of_video', 'approved', ?)"
);
const questions = [
  [30, 'What does this loop print?  for (int i = 1; i <= 50; i++) sum += i;  then print(sum)', ['50', '1275', '2500', '1225'], 1, 'It adds 1 + 2 + ... + 50, which is 50 x 51 / 2 = 1275.'],
  [60, 'Which loop header visits only the even numbers from 2 to 50?', ['for (int i = 0; i < 50; i++)', 'for (int i = 2; i <= 50; i += 2)', 'for (int i = 1; i <= 50; i += 2)', 'for (int i = 2; i < 50; i++)'], 1, 'Start at 2 and step by 2 while i <= 50, so 50 is included.'],
  [90, 'In  for (init; condition; update) , which part runs exactly once?', ['init', 'condition', 'update', 'the loop body'], 0, 'The initialisation runs once before the first check; the condition and update run on every iteration.'],
  [120, 'How many times does the body of  for (int i = 0; i < 5; i++)  run?', ['4', '5', '6', 'It never stops'], 1, 'i takes the values 0, 1, 2, 3, 4, which is five iterations; at i = 5 the condition is false.'],
];
for (const [ts, q, options, correct, why] of questions) add.run(LECTURE, ts, q, JSON.stringify(options), correct, why, Date.now());
console.log(`linked Vimeo ${VIMEO_ID} to lecture "${LECTURE}" with ${questions.length} knowledge-check questions`);
