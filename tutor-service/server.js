const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const OpenAI = require('openai');
const pdfParse = require('pdf-parse');
const { marked } = require('marked');
marked.setOptions({ breaks: true });

const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'tutor.db');
const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 150;
const TOP_K = 5;

// ---- AI Learning Arena: swappable model/RAG backends ----
// Every chat/embedding call in this file goes through chatCompletionWithResilience()
// or embed(), which resolve the ACTIVE config here. Adding a self-hosted backend
// later (vLLM/Ollama, exposed as an OpenAI-compatible endpoint) is just a new entry
// in this registry plus flipping the active setting -- no call site changes, no
// Moodle plugin changes, no learner-journey changes. That's the whole point of the
// "Arena": HTU can compare configurations without rebuilding anything downstream.
const MODEL_CONFIGS = {
  'openai-default': {
    id: 'openai-default',
    label: 'OpenAI (gpt-4o-mini)',
    baseURL: undefined, // OpenAI's default endpoint
    apiKey: process.env.OPENAI_API_KEY,
    chatModel: 'gpt-4o-mini',
    embedModel: 'text-embedding-3-small',
  },
  // Example of what a self-hosted entry looks like once a GPU box exists -- same
  // OpenAI SDK, just pointed at our own vLLM/Ollama server instead of api.openai.com:
  // 'qwen-selfhosted': {
  //   id: 'qwen-selfhosted',
  //   label: 'Qwen2.5-7B-Instruct (self-hosted)',
  //   baseURL: process.env.QWEN_BASE_URL, // e.g. 'http://<gpu-host>:8000/v1'
  //   apiKey: process.env.QWEN_API_KEY || 'not-needed',
  //   chatModel: 'qwen2.5-7b-instruct',
  //   embedModel: 'bge-m3',
  // },
  // OpenRouter-hosted open-weight models, evaluated for the HTU Arena. Embeddings point
  // at an open model served through OpenRouter too (not OpenAI) to stay consistent with
  // the "no OpenAI in the HTU path" direction while BGE-M3 self-hosting is still pending.
  'qwen3.5-27b': {
    id: 'qwen3.5-27b',
    label: 'Qwen3.5-27B (OpenRouter)',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    chatModel: 'qwen/qwen3.5-27b',
    embedModel: 'qwen/qwen3-embedding-8b',
    extraBody: { reasoning: { exclude: true } },
    timeoutMs: 45000, // thinking model -- real latency, not just a flag fix; see chatCompletionWithResilience
    maxTokens: 2500, // this model reasons verbosely -- 700 was fully consumed by hidden thinking with zero visible answer; caps worst-case length, uncapped it can run away well past timeoutMs
  },
  'gemma4-26b-a4b': {
    id: 'gemma4-26b-a4b',
    label: 'Gemma 4 26B-A4B (OpenRouter)',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    chatModel: 'google/gemma-4-26b-a4b-it',
    embedModel: 'qwen/qwen3-embedding-8b',
  },
  'gemma4-31b': {
    id: 'gemma4-31b',
    label: 'Gemma 4 31B dense (OpenRouter)',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    chatModel: 'google/gemma-4-31b-it',
    embedModel: 'qwen/qwen3-embedding-8b',
  },
  'mistral-small-3.1-24b': {
    id: 'mistral-small-3.1-24b',
    label: 'Mistral Small 3.1 24B (OpenRouter)',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    chatModel: 'mistralai/mistral-small-3.1-24b-instruct',
    embedModel: 'qwen/qwen3-embedding-8b',
  },
  'llama4-scout': {
    id: 'llama4-scout',
    label: 'Llama 4 Scout (OpenRouter) -- not OSI open source, Meta community license',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    chatModel: 'meta-llama/llama-4-scout',
    embedModel: 'qwen/qwen3-embedding-8b',
  },
  'qwen3.6-27b': {
    id: 'qwen3.6-27b',
    label: 'Qwen3.6-27B (OpenRouter)',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    chatModel: 'qwen/qwen3.6-27b',
    embedModel: 'qwen/qwen3-embedding-8b',
    extraBody: { reasoning: { exclude: true } },
    timeoutMs: 45000, // thinking model -- real latency, not just a flag fix; see chatCompletionWithResilience
    maxTokens: 2500, // this model reasons verbosely -- 700 was fully consumed by hidden thinking with zero visible answer; caps worst-case length, uncapped it can run away well past timeoutMs
  },
};
const DEFAULT_MODEL_CONFIG_ID = 'openai-default';
// Legacy placeholder -- call sites still pass `model: CHAT_MODEL` for readability, but
// chatCompletionWithResilience() always overrides it with the active config's chatModel.
const CHAT_MODEL = 'gpt-4o-mini';

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set. Set it in the environment before starting.');
  process.exit(1);
}

// Shared with rennix-lti's onboarding form specifically -- separate from
// LTI_BRIDGE_SECRET (that one authenticates individual launches; this one
// authenticates a one-time "set this school's own billing key" admin action).
const TENANT_ADMIN_SECRET = process.env.TENANT_ADMIN_SECRET || '';
if (!TENANT_ADMIN_SECRET) {
  console.warn('WARNING: TENANT_ADMIN_SECRET is not set -- /admin/tenant-settings is disabled.');
}

const modelClientCache = {};
function getClientForConfig(config) {
  if (!modelClientCache[config.id]) {
    modelClientCache[config.id] = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  }
  return modelClientCache[config.id];
}

// Single global active config for now (env var, overridable live via /admin/model-config
// which persists the choice in the DB). Takes a studentUserid so a future cohort-based
// A/B assignment can slot in here without touching any caller.
//
// A tenant can override the API key via /admin/tenant-settings (their own OpenAI billing,
// not HTU's) -- since getSetting already resolves through the per-tenant `db`, this falls
// out for free as an app_settings row. The cache key gets tenant-qualified whenever a
// custom key is in play, so getClientForConfig() (keyed by config.id) never hands one
// tenant's cached client, built with their key, to a different tenant re-using the same
// base config id.
function getActiveModelConfig(studentUserid) {
  const activeId = getSetting('active_model_config', process.env.ACTIVE_MODEL_CONFIG || DEFAULT_MODEL_CONFIG_ID);
  const base = MODEL_CONFIGS[activeId] || MODEL_CONFIGS[DEFAULT_MODEL_CONFIG_ID];
  const tenantApiKey = getSetting('tenant_openai_api_key', null);
  if (!tenantApiKey) return base;
  const tenant = tenantContext.getStore()?.tenant || DEFAULT_TENANT;
  return { ...base, apiKey: tenantApiKey, id: `${base.id}:tenant:${tenant}` };
}

// ---- AI provider resilience: quotas, timeouts, retry/backoff ----
const RATE_LIMIT_PER_MINUTE = 6;
const RATE_LIMIT_PER_DAY_STUDENT = 100;
const RATE_LIMIT_PER_DAY_SYSTEM = 2000;
const CHAT_TIMEOUT_MS = 15000;

// Returns { allowed, reason } and records the event if allowed. DB-backed so quotas survive
// restarts, matching Criterio's real design (student/day, system/day, student/minute).
function checkAndRecordRateLimit(db, studentUserId) {
  const now = Date.now();
  const oneMinuteAgo = now - 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const perMinute = db.prepare(
    'SELECT COUNT(*) as c FROM chat_rate_events WHERE student_userid = ? AND created_at > ?'
  ).get(studentUserId, oneMinuteAgo).c;
  if (perMinute >= RATE_LIMIT_PER_MINUTE) {
    return { allowed: false, reason: `Rate limit: max ${RATE_LIMIT_PER_MINUTE} messages per minute. Please wait a moment.` };
  }

  const perDayStudent = db.prepare(
    'SELECT COUNT(*) as c FROM chat_rate_events WHERE student_userid = ? AND created_at > ?'
  ).get(studentUserId, oneDayAgo).c;
  if (perDayStudent >= RATE_LIMIT_PER_DAY_STUDENT) {
    return { allowed: false, reason: `Daily limit reached (${RATE_LIMIT_PER_DAY_STUDENT} messages/day). Try again tomorrow.` };
  }

  const perDaySystem = db.prepare('SELECT COUNT(*) as c FROM chat_rate_events WHERE created_at > ?').get(oneDayAgo).c;
  if (perDaySystem >= RATE_LIMIT_PER_DAY_SYSTEM) {
    return { allowed: false, reason: 'The course-wide daily AI quota has been reached. Try again tomorrow.' };
  }

  db.prepare('INSERT INTO chat_rate_events (student_userid, created_at) VALUES (?, ?)').run(studentUserId, now);
  return { allowed: true };
}

// Wraps a chat completion call with an explicit timeout and one retry with backoff on
// transient (network/5xx/timeout) failures -- a provider hiccup shouldn't take down the
// whole request. `params.model` is always overridden by the active config's chatModel,
// so callers just pass a logical model name (or omit it) and don't need to know which
// backend is currently active.
async function chatCompletionWithResilience(params, attempt = 1, studentUserid = null) {
  const config = getActiveModelConfig(studentUserid);
  const client = getClientForConfig(config);
  // extraBody carries provider-specific request fields a config needs (e.g. OpenRouter's
  // `reasoning: {exclude: true}` to keep the reasoning trace out of the response payload).
  // Note this does NOT stop the model from reasoning -- it still spends real time and
  // tokens on hidden chain-of-thought either way, it just isn't returned. That's why
  // thinking-capable configs also need a longer config.timeoutMs: the fix for their
  // latency is time budget, not this flag.
  const finalParams = {
    ...params,
    model: config.chatModel,
    ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
    ...(config.extraBody || {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs || CHAT_TIMEOUT_MS);
  try {
    return await client.chat.completions.create(finalParams, { signal: controller.signal });
  } catch (err) {
    const transient = err.name === 'AbortError' || err.status >= 500 || err.code === 'ECONNRESET' || !err.status;
    if (transient && attempt < 2) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      return chatCompletionWithResilience(params, attempt + 1, studentUserid);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// `db` starts as the one real connection to HTU's database while the schema/
// migration code below runs against it. Once that's done (see the tenant
// plumbing further down), this binding gets swapped to a Proxy that resolves
// to whichever tenant's own database applies to the current request -- so
// this has to be `let`, not `const`.
let db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ---- Global audit log ----
// Its own connection, deliberately not part of the per-tenant `db` above --
// audit events (admin actions, ingestion, dashboard authorization failures)
// are cross-cutting infrastructure concerns, not tenant business data, and
// some of them (a model-config change) aren't scoped to any one tenant at
// all. Never write raw secrets, tokens, or student prompt/answer content into
// `detail` -- this answers "who did what, when", not "what did they say".
const auditDb = new Database(path.join(path.dirname(DB_PATH), 'audit.db'));
auditDb.pragma('journal_mode = WAL');
auditDb.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    tenant TEXT,
    detail TEXT,
    ip TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
`);
function logAuditEvent(event, detail, req, tenant) {
  const ip = req ? (req.get('x-forwarded-for') || req.socket?.remoteAddress || '') : '';
  const resolvedTenant = tenant || (typeof tenantContext !== 'undefined' && tenantContext.getStore ? tenantContext.getStore()?.tenant : null) || null;
  auditDb.prepare('INSERT INTO audit_log (event, tenant, detail, ip, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(event, resolvedTenant, detail || null, String(ip || '').split(',')[0].trim(), Date.now());
}

db.exec(`
  CREATE TABLE IF NOT EXISTS lectures (
    lecture_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lecture_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding TEXT NOT NULL,
    start_time REAL,
    end_time REAL
  );
  CREATE INDEX IF NOT EXISTS idx_chunks_lecture ON chunks(lecture_id);

  CREATE TABLE IF NOT EXISTS students (
    userid INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    fullname TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lecture_id TEXT NOT NULL,
    student_userid INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    position REAL,
    duration REAL,
    payload TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_lecture ON events(lecture_id);
  CREATE INDEX IF NOT EXISTS idx_events_student ON events(student_userid);

  CREATE TABLE IF NOT EXISTS grades (
    userid INTEGER PRIMARY KEY,
    quiz_percent REAL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_userid INTEGER NOT NULL,
    lecture_id TEXT NOT NULL,
    position REAL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notes_student ON notes(student_userid);

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    starts_at INTEGER NOT NULL,
    duration_minutes INTEGER NOT NULL,
    capacity INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session_bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    student_userid INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(session_id, student_userid)
  );

  CREATE TABLE IF NOT EXISTS session_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    student_userid INTEGER NOT NULL,
    summary TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(session_id, student_userid)
  );

  CREATE TABLE IF NOT EXISTS popup_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lecture_id TEXT NOT NULL,
    timestamp REAL NOT NULL,
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    correct_index INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_popup_lecture ON popup_questions(lecture_id);

  CREATE TABLE IF NOT EXISTS popup_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    popup_question_id INTEGER NOT NULL,
    student_userid INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_popup_resp_question ON popup_responses(popup_question_id);

  CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    brief_markdown TEXT NOT NULL,
    rubric_json TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assignment_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id INTEGER NOT NULL,
    student_userid INTEGER NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    UNIQUE(assignment_id, student_userid)
  );

  CREATE TABLE IF NOT EXISTS formative_escalations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id INTEGER NOT NULL,
    student_userid INTEGER NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    report TEXT,
    resolved INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pdf_materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    moodle_url TEXT NOT NULL,
    text_content TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pdf_annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pdf_id INTEGER NOT NULL,
    student_userid INTEGER NOT NULL,
    page INTEGER NOT NULL,
    note TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pdf_ink_strokes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pdf_id INTEGER NOT NULL,
    student_userid INTEGER NOT NULL,
    page INTEGER NOT NULL,
    color TEXT NOT NULL,
    width REAL NOT NULL,
    mode TEXT NOT NULL DEFAULT 'pen',
    points TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ink_lookup ON pdf_ink_strokes(pdf_id, student_userid, page);

  CREATE TABLE IF NOT EXISTS lecture_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lecture_id TEXT NOT NULL,
    student_userid INTEGER NOT NULL,
    question TEXT NOT NULL,
    position REAL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_qa_lecture ON lecture_questions(lecture_id);

  CREATE TABLE IF NOT EXISTS lecture_question_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL,
    author_userid INTEGER NOT NULL,
    reply TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_rate_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_userid INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rate_student ON chat_rate_events(student_userid, created_at);
  CREATE INDEX IF NOT EXISTS idx_rate_created ON chat_rate_events(created_at);

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_event_id INTEGER NOT NULL,
    student_userid INTEGER NOT NULL,
    rating TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_event ON chat_feedback(chat_event_id);

  CREATE TABLE IF NOT EXISTS ai_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL,
    model_config_id TEXT,
    error_type TEXT NOT NULL,
    message TEXT,
    student_userid INTEGER,
    created_at INTEGER NOT NULL
  );
`);

// Small DB-backed key/value store for settings that need to change live (e.g. which
// model config is active) without a redeploy -- env vars only take effect at container
// start, which defeats the point of a swappable Arena.
function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).run(key, value, Date.now());
}

const VIDEO_EVENT_TYPES = new Set(['play', 'pause', 'seek', 'ended', 'heartbeat', 'leave']);

// Older databases created before timestamp support won't have these columns yet.
const chunkColumns = db.prepare("PRAGMA table_info(chunks)").all().map((c) => c.name);
if (!chunkColumns.includes('start_time')) {
  db.exec('ALTER TABLE chunks ADD COLUMN start_time REAL');
}
if (!chunkColumns.includes('end_time')) {
  db.exec('ALTER TABLE chunks ADD COLUMN end_time REAL');
}

const popupColumns = db.prepare("PRAGMA table_info(popup_questions)").all().map((c) => c.name);
if (!popupColumns.includes('status')) {
  db.exec("ALTER TABLE popup_questions ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'");
}
if (!popupColumns.includes('placement')) {
  db.exec("ALTER TABLE popup_questions ADD COLUMN placement TEXT NOT NULL DEFAULT 'in_video'");
}
if (!popupColumns.includes('explanation')) {
  db.exec('ALTER TABLE popup_questions ADD COLUMN explanation TEXT');
}

// Assignment briefs sit in 'draft' until a Course Supervisor approves them in the
// Verification Queue -- students never see a brief before it's published, matching the
// real product's "Untitled Assignment / Due No due date · Draft" Content-tab state.
const assignmentColumns = db.prepare("PRAGMA table_info(assignments)").all().map((c) => c.name);
if (!assignmentColumns.includes('status')) {
  db.exec("ALTER TABLE assignments ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'");
}
if (!assignmentColumns.includes('due_date')) {
  db.exec('ALTER TABLE assignments ADD COLUMN due_date INTEGER');
}

// Internal Verifier role: a QC layer distinct from the instructor that signs off on
// AI-generated escalation reports and pre-session summaries before they're treated as final.
const escalationColumns = db.prepare("PRAGMA table_info(formative_escalations)").all().map((c) => c.name);
if (!escalationColumns.includes('verifier_reviewed')) {
  db.exec('ALTER TABLE formative_escalations ADD COLUMN verifier_reviewed INTEGER NOT NULL DEFAULT 0');
}
if (!escalationColumns.includes('verifier_note')) {
  db.exec('ALTER TABLE formative_escalations ADD COLUMN verifier_note TEXT');
}
if (!escalationColumns.includes('verifier_reviewed_at')) {
  db.exec('ALTER TABLE formative_escalations ADD COLUMN verifier_reviewed_at INTEGER');
}

const summaryColumns = db.prepare("PRAGMA table_info(session_summaries)").all().map((c) => c.name);
if (!summaryColumns.includes('verifier_reviewed')) {
  db.exec('ALTER TABLE session_summaries ADD COLUMN verifier_reviewed INTEGER NOT NULL DEFAULT 0');
}
if (!summaryColumns.includes('verifier_reviewed_at')) {
  db.exec('ALTER TABLE session_summaries ADD COLUMN verifier_reviewed_at INTEGER');
}

// Multi-instructor course model: a course has several sections, each with its own
// instructor (or none, if unassigned), plus a course_supervisor role that oversees
// every section. Real data, not a display-only label -- feeds the Analytics tab's
// per-student section attribution now and the Overview tab's per-section cards later.
const studentColumns = db.prepare("PRAGMA table_info(students)").all().map((c) => c.name);
if (!studentColumns.includes('role')) {
  db.exec("ALTER TABLE students ADD COLUMN role TEXT NOT NULL DEFAULT 'student'");
}
if (!studentColumns.includes('section')) {
  db.exec('ALTER TABLE students ADD COLUMN section TEXT');
}
if (!studentColumns.includes('email')) {
  db.exec('ALTER TABLE students ADD COLUMN email TEXT');
}
db.exec(`
  CREATE TABLE IF NOT EXISTS course_sections (
    key TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    instructor_userid INTEGER
  );
  CREATE TABLE IF NOT EXISTS question_review_status (
    popup_question_id INTEGER PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'open',
    updated_at INTEGER NOT NULL
  );
`);

if (db.prepare('SELECT COUNT(*) as c FROM course_sections').get().c === 0) {
  const teacher = db.prepare("SELECT userid FROM students WHERE username = 'teacher1'").get();
  if (teacher) {
    db.prepare("UPDATE students SET role = 'course_supervisor' WHERE userid = ?").run(teacher.userid);
  }
  db.prepare("INSERT INTO course_sections (key, title, instructor_userid) VALUES ('A', 'Section A', ?)").run(teacher ? teacher.userid : null);
  db.prepare("INSERT INTO course_sections (key, title, instructor_userid) VALUES ('B', 'Section B', NULL)").run();

  const realStudents = db.prepare("SELECT userid FROM students WHERE role = 'student' AND section IS NULL ORDER BY userid").all();
  realStudents.forEach((s, i) => {
    db.prepare('UPDATE students SET section = ? WHERE userid = ?').run(i % 2 === 0 ? 'A' : 'B', s.userid);
  });
}

// Stores the original PDF bytes so the in-browser canvas viewer (needed for page-anchored ink
// annotations) can fetch them same-origin -- Moodle's pluginfile URLs aren't CORS-enabled for
// cross-origin fetch() the way a plain <embed> load is.
const pdfMaterialColumns = db.prepare("PRAGMA table_info(pdf_materials)").all().map((c) => c.name);
if (!pdfMaterialColumns.includes('file_blob')) {
  db.exec('ALTER TABLE pdf_materials ADD COLUMN file_blob BLOB');
}

// video_provider: 'file' (a direct URL, e.g. Moodle pluginfile.php -- the legacy path)
// or 'vimeo' (video_url holds the Vimeo video ID, played via the Vimeo Player SDK so we
// never download/rehost the underlying video, per HTU's requirement).
const lectureColumns = db.prepare("PRAGMA table_info(lectures)").all().map((c) => c.name);
if (!lectureColumns.includes('video_url')) {
  db.exec('ALTER TABLE lectures ADD COLUMN video_url TEXT');
}
if (!lectureColumns.includes('video_provider')) {
  db.exec("ALTER TABLE lectures ADD COLUMN video_provider TEXT NOT NULL DEFAULT 'file'");
}

// Extracts a target time in seconds from a question like "what happened at minute 1:44",
// "دقيقة 2:10", "around minute 3". Returns null if no timestamp reference is found.
function extractRequestedTime(message) {
  let m = message.match(/(\d{1,3}):(\d{2})/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);

  m = message.match(/(?:minute|min|دقيقة|الدقيقة)\s*(\d{1,3})/i);
  if (m) return parseInt(m[1], 10) * 60;

  m = message.match(/(\d{1,3})\s*(?:minutes?|min|دقيقة|دقائق)/i);
  if (m) return parseInt(m[1], 10) * 60;

  return null;
}

function formatTimestamp(seconds) {
  if (seconds === null || seconds === undefined) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Arabic vs English performance is a named AI Quality evaluation criterion in the HTU
// proposal -- tag every interaction with the question's actual language so it can be
// broken out later, rather than only ever measuring aggregate quality.
function detectLanguage(text) {
  return /[؀-ۿ]/.test(text) ? 'ar' : 'en';
}

// Every AI provider failure needs to be visible for the "reliability" evaluation
// criterion -- errors that only ever surface as an HTTP response to the student are
// invisible to an instructor looking at aggregate quality later.
function logAiError(endpoint, err, extra = {}) {
  try {
    db.prepare(
      'INSERT INTO ai_errors (endpoint, model_config_id, error_type, message, student_userid, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(endpoint, extra.modelConfigId || null, err.name || 'Error', String(err.message || err).slice(0, 500), extra.studentUserid || null, Date.now());
  } catch (e) { /* never let error-logging itself break the response */ }
}

// Pulls the "[[CITE:start-end]]" marker the model was instructed to always append in
// this exact literal (never-translated) format, straight out of its own reply text.
// This is the single source of truth for what the model actually grounded its answer
// in -- more reliable than guessing from which chunk we happened to inject (adjacent
// chunk boundaries can make that guess disagree), and language-invariant (an earlier
// "(see M:SS-M:SS)" version broke when the model translated "see" into Arabic).
// Returns { citation, cleanReply } -- cleanReply has the marker stripped so the
// student never sees the raw token.
function parseTimestampCitation(reply) {
  const m = reply.match(/\[\[CITE:(\d+)-(\d+)\]\]/);
  const cleanReply = reply.replace(/\s*\[\[CITE:\d+-\d+\]\]\s*$/, '').trim();
  if (!m) return { citation: null, cleanReply };
  return { citation: { start: parseInt(m[1], 10), end: parseInt(m[2], 10) }, cleanReply };
}

// Groups Whisper-style segments ({text, start, end}) into ~CHUNK_SIZE-character
// chunks, keeping each chunk's earliest start / latest end time.
function groupSegmentsIntoChunks(segments) {
  const chunks = [];
  let current = { text: '', start: null, end: null };

  for (const seg of segments) {
    const segText = seg.text.trim();
    if (!segText) continue;
    if (current.text && current.text.length + segText.length + 1 > CHUNK_SIZE) {
      chunks.push(current);
      current = { text: '', start: null, end: null };
    }
    if (current.start === null) current.start = seg.start;
    current.end = seg.end;
    current.text = current.text ? `${current.text} ${segText}` : segText;
  }
  if (current.text) chunks.push(current);
  return chunks;
}

function chunkText(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(start + CHUNK_SIZE, clean.length);
    chunks.push(clean.slice(start, end));
    if (end === clean.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function embed(text, attempt = 1) {
  const config = getActiveModelConfig();
  const client = getClientForConfig(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  try {
    const res = await client.embeddings.create({ model: config.embedModel, input: text }, { signal: controller.signal });
    return res.data[0].embedding;
  } catch (err) {
    const transient = err.name === 'AbortError' || err.status >= 500 || err.code === 'ECONNRESET' || !err.status;
    if (transient && attempt < 2) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      return embed(text, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Weaviate RAG pipeline: self-hosted embeddings -> Weaviate hybrid retrieval ----
// Deliberately separate from embed()/MODEL_CONFIGS above: embeddings for retrieval always
// come from the self-hosted BGE-M3 service, never an LLM provider's embedding API, while
// which LLM generates the final answer stays swappable via the Arena's active config (this
// pipeline calls the existing chatCompletionWithResilience for generation, so it works with
// whichever of the 6 registered configs is active -- OpenAI or any of the 5 OpenRouter
// models -- without any changes here). That split -- fixed self-hosted retrieval, swappable
// generation -- is what makes the Arena comparison fair: only the generation model varies.
const WEAVIATE_URL = process.env.WEAVIATE_URL;
const WEAVIATE_API_KEY = process.env.WEAVIATE_API_KEY;
const WEAVIATE_CLASS = 'CourseContent';
const BGE_EMBEDDINGS_URL = process.env.BGE_EMBEDDINGS_URL;
const DEFAULT_COURSE_ID = process.env.DEFAULT_COURSE_ID || 'CS101';

// Weaviate tenant names are the uppercased tenant slug ('htu' -> 'HTU') -- native
// multi-tenancy (separate shard per tenant), not a property filter, matching this
// codebase's existing per-tenant-database isolation pattern (getTenantDb()).
function weaviateTenantName(tenantSlug) {
  return (tenantSlug || DEFAULT_TENANT).toUpperCase();
}

async function weaviateFetch(path, options = {}) {
  if (!WEAVIATE_URL || !WEAVIATE_API_KEY) {
    throw new Error('WEAVIATE_URL/WEAVIATE_API_KEY not configured');
  }
  return fetch(`${WEAVIATE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${WEAVIATE_API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

async function weaviateGraphQL(query) {
  const res = await weaviateFetch('/v1/graphql', { method: 'POST', body: JSON.stringify({ query }) });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(JSON.stringify(body.errors || body));
  return body.data;
}

// Self-hosted embedding model (BGE-M3 via Hugging Face text-embeddings-inference),
// decoupled from whichever LLM config the Arena has active. Throws clearly if the
// service isn't deployed yet rather than silently falling back to an API embedding
// provider -- that fallback would violate the "no external embedding API for HTU"
// architecture principle, so a hard failure here is the correct behavior, not a bug.
async function embedForRag(text, attempt = 1) {
  if (!BGE_EMBEDDINGS_URL) {
    throw new Error('BGE_EMBEDDINGS_URL not configured -- self-hosted embedding service is not deployed yet');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  try {
    const res = await fetch(`${BGE_EMBEDDINGS_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: text }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Embedding service returned ${res.status}: ${await res.text()}`);
    const data = await res.json();
    // TEI's /embed returns [[...vector]] for a single input string.
    return Array.isArray(data[0]) ? data[0] : data;
  } catch (err) {
    const transient = err.name === 'AbortError' || err.code === 'ECONNRESET' || !err.status;
    if (transient && attempt < 2) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      return embedForRag(text, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Chunking ----

// Video transcripts: fixed time windows with overlap, not character counts -- so every
// chunk is a coherent, citeable span of the video regardless of how verbose that portion
// of speech was. ~65s windows with ~10s overlap, matching the spec.
function chunkSegmentsByTimeWindow(segments, windowSeconds = 65, overlapSeconds = 10) {
  if (!segments.length) return [];
  const lastEnd = Math.max(...segments.map((s) => s.end));
  const chunks = [];
  let windowStart = segments[0].start;
  while (windowStart < lastEnd) {
    const windowEnd = windowStart + windowSeconds;
    const covered = segments.filter((s) => s.start < windowEnd && s.end > windowStart);
    const text = covered.map((s) => s.text.trim()).filter(Boolean).join(' ');
    if (text) {
      chunks.push({ text, timestamp_start: covered[0].start, timestamp_end: covered[covered.length - 1].end });
    }
    windowStart += windowSeconds - overlapSeconds;
  }
  return chunks;
}

// PDFs: page-aware, since instructors and students think in "page 17", not character 4200.
// Captures per-page text via pdf-parse's pagerender hook (its default output concatenates
// all pages with no reliable separator, so this has to be explicit).
async function extractPdfTextByPage(buf) {
  const pageTexts = [];
  await pdfParse(buf, {
    pagerender: async (pageData) => {
      const content = await pageData.getTextContent();
      const text = content.items.map((item) => item.str).join(' ');
      pageTexts.push(text);
      return text;
    },
  });
  return pageTexts;
}

function chunkPdfByPage(pageTexts) {
  const chunks = [];
  pageTexts.forEach((pageText, i) => {
    chunkText(pageText).forEach((text) => chunks.push({ text, page_number: i + 1 }));
  });
  return chunks;
}

// ---- Weaviate insertion ----
async function insertChunksToWeaviate(tenantSlug, propertiesList) {
  const tenant = weaviateTenantName(tenantSlug);
  const objects = [];
  for (const properties of propertiesList) {
    const vector = await embedForRag(properties.text);
    objects.push({ class: WEAVIATE_CLASS, tenant, properties, vector });
  }
  const res = await weaviateFetch('/v1/batch/objects', { method: 'POST', body: JSON.stringify({ objects }) });
  const body = await res.json();
  if (!res.ok) throw new Error(`Weaviate batch insert failed: ${JSON.stringify(body)}`);
  const errors = body.filter((r) => r.result?.errors);
  if (errors.length) throw new Error(`Weaviate batch insert had ${errors.length} failures: ${JSON.stringify(errors.slice(0, 3))}`);
  return body.length;
}

// ---- Retrieval ----
const RAG_PROPERTIES = 'text course_id source_type source_id source_title video_id timestamp_start timestamp_end document_id page_number language';

// Course-wide hybrid (vector + BM25) search, always scoped to tenant (native Weaviate
// multi-tenancy) + course_id (property filter) -- never search all of a tenant's courses
// for one course's students.
async function hybridSearchCourse(tenantSlug, courseId, query, limit = 20) {
  const tenant = weaviateTenantName(tenantSlug);
  const queryVector = await embedForRag(query);
  const data = await weaviateGraphQL(`{
    Get {
      ${WEAVIATE_CLASS}(
        tenant: "${tenant}"
        hybrid: { query: ${JSON.stringify(query)}, vector: ${JSON.stringify(queryVector)}, alpha: 0.5 }
        where: { path: ["course_id"], operator: Equal, valueText: ${JSON.stringify(courseId)} }
        limit: ${limit}
      ) { ${RAG_PROPERTIES} _additional { score } }
    }
  }`);
  return data.Get[WEAVIATE_CLASS] || [];
}

// Self-hosted cross-encoder reranker (BAAI/bge-reranker-v2-m3 via TEI's /rerank), applied
// after Weaviate's hybrid top-K to pick the final top-N actually sent to the LLM. Optional
// by design: unlike embeddings, skipping this stage still keeps everything self-hosted --
// it degrades to "use Weaviate's hybrid ranking directly" rather than failing, since a
// missing reranker isn't a violation of the no-external-API principle the way a missing
// embedding model would be.
const RERANKER_URL = process.env.RERANKER_URL;

async function rerankChunks(query, chunks, topN = 5) {
  if (!RERANKER_URL || chunks.length === 0) return chunks.slice(0, topN);
  const res = await fetch(`${RERANKER_URL}/rerank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, texts: chunks.map((c) => c.text) }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Reranker returned ${res.status}: ${await res.text()}`);
  const ranked = await res.json(); // [{index, score}], sorted by score desc
  return ranked.slice(0, topN).map((r) => chunks[r.index]);
}

// Contextual Ask's "local" branch: chunks from the SAME video near the student's current
// playback position, regardless of semantic similarity to their question -- this is what
// makes vague questions ("why did he use this equation?") answerable.
async function retrieveTimestampWindow(tenantSlug, courseId, videoId, timestamp, windowSeconds = 120) {
  const tenant = weaviateTenantName(tenantSlug);
  const data = await weaviateGraphQL(`{
    Get {
      ${WEAVIATE_CLASS}(
        tenant: "${tenant}"
        where: {
          operator: And
          operands: [
            { path: ["course_id"], operator: Equal, valueText: ${JSON.stringify(courseId)} }
            { path: ["video_id"], operator: Equal, valueText: ${JSON.stringify(videoId)} }
            { path: ["timestamp_start"], operator: LessThanEqual, valueNumber: ${timestamp + windowSeconds} }
            { path: ["timestamp_end"], operator: GreaterThanEqual, valueNumber: ${timestamp - windowSeconds} }
          ]
        }
        limit: 10
      ) { ${RAG_PROPERTIES} }
    }
  }`);
  return data.Get[WEAVIATE_CLASS] || [];
}

// Merge the two Contextual Ask branches, de-duplicated so a chunk both branches surfaced
// doesn't get cited twice. Feeds into rerankChunks() afterward for final ordering -- this
// just interleaves local-first, then fills remaining slots from the semantic branch.
function mergeRetrievalBranches(local, semantic, maxTotal = 8) {
  const seen = new Set();
  const merged = [];
  for (const chunk of [...local, ...semantic]) {
    const key = `${chunk.source_id}:${chunk.timestamp_start ?? chunk.page_number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(chunk);
    if (merged.length >= maxTotal) break;
  }
  return merged;
}

// ---- Prompt building + structured citations ----
// buildRagPrompt returns a plain messages array, fed straight into the existing
// chatCompletionWithResilience -- so this is provider-neutral by construction, not by
// extra effort: it works with whichever of the 6 MODEL_CONFIGS is active.
function formatTimestamp(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function buildRagPrompt(courseLabel, question, chunks) {
  const context = chunks.map((c, i) => {
    const loc = c.video_id ? `${c.source_title} @ ${formatTimestamp(c.timestamp_start)}` : `${c.source_title}, p.${c.page_number}`;
    return `[${i + 1}] (${loc})\n${c.text}`;
  }).join('\n\n');
  return [
    {
      role: 'system',
      content: `You are the AI tutor for ${courseLabel}. Answer ONLY using the numbered course context below -- if it's insufficient to answer, say so plainly rather than guessing. When you use a piece of context, cite it inline as [n] matching its number.`,
    },
    { role: 'user', content: `COURSE CONTEXT:\n${context}\n\nSTUDENT QUESTION:\n${question}` },
  ];
}

// {answer, sources:[...]} instead of a bare string, so Moodle can render clickable
// "Lecture 5 -- 18:17" / "Week 5 Slides -- p.17" citations rather than just prose.
function formatStructuredCitations(chunks) {
  return chunks.map((c) => ({
    source_type: c.source_type,
    title: c.source_title,
    ...(c.video_id ? { video_id: c.video_id, timestamp_start: c.timestamp_start } : {}),
    ...(c.page_number ? { page_number: c.page_number } : {}),
  }));
}

// ---- Rate limiting (endpoint-level, IP-keyed) ----
// Separate from checkAndRecordRateLimit above, which is the per-student/per-day
// AI-cost quota enforced inside /chat once identity is known. This is a plain
// per-IP sliding window for endpoints that need protecting before or outside
// that identity check -- login brute-forcing, and ingestion (each call triggers
// paid embedding requests, cheap to hammer if unprotected). In-memory, per
// process -- same multi-replica caveat as rennix-lti's version and the state/
// nonce store; all three would move to a shared store together if this ever
// runs multi-replica.
const rateLimitBuckets = new Map(); // "name:ip" -> timestamps[]
function isRateLimited(key, maxRequests, windowMs) {
  const now = Date.now();
  const bucket = (rateLimitBuckets.get(key) || []).filter((t) => now - t < windowMs);
  bucket.push(now);
  rateLimitBuckets.set(key, bucket);
  return bucket.length > maxRequests;
}
function rateLimit(name, maxRequests, windowMs) {
  return (req, res, next) => {
    const ip = (req.get('x-forwarded-for') || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    if (isRateLimited(`${name}:${ip}`, maxRequests, windowMs)) {
      return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    }
    next();
  };
}

const app = express();
app.use(cors());
// Every page here is per-user, per-role dynamic content -- there's never a
// correct reason for a browser (or an intermediate cache) to serve a stale
// copy instead of hitting the server. Without this, a normal page load has no
// signal telling the browser NOT to cache, and a hard refresh on an outer
// page (e.g. Moodle, when this is loaded inside an LTI iframe) doesn't
// reliably force the nested iframe's own cached document to revalidate --
// confirmed as the likely cause of a real "I don't see the new tabs" report
// that persisted even after the user hard-refreshed.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '2mb' }));

// ---- Multi-tenant request scoping ----
// Which tenant (institution) a request belongs to has to be known before
// anything below touches `db`, so this is registered as the very first
// thing after body parsing -- everything else in the file, including the
// identity-verification middleware right below, runs inside this context.
// The tenant Proxy that actually reads `tenantContext` isn't defined until
// further down (after HTU's schema/migrations finish running against the
// real connection), but that's fine: this callback only executes per
// request, long after the whole module has finished loading.
const { AsyncLocalStorage } = require('node:async_hooks');
const tenantContext = new AsyncLocalStorage();
const DEFAULT_TENANT = 'htu';
const TENANT_SLUG_RE = /^[a-z0-9-]{1,64}$/;
// Tenant resolution is folded into the identity-verification middleware
// below (not a separate step) -- the tenant a request belongs to must only
// ever come from a cryptographically verified source (a signed token), the
// same as the user id, never a bare query param a browser could set to
// anything.

// ---- Identity verification ----
// Every route used to trust a bare ?student=/?as= query param or a
// student_userid in the POST body as-is -- meaning anyone who knew or
// guessed a small integer user id could view or act as that student from
// any browser, logged into Moodle or not (confirmed live: GET /app/home?
// student=8 rendered that student's full dashboard with zero auth). Moodle
// (block_criterio, running server-side with the real $USER->id) now signs a
// short-lived HMAC token and sends it via the postMessage identify handoff
// instead of a bare id. This middleware is the single choke point: it
// verifies that token (or an existing verified session cookie), then
// overwrites req.query.student/as and req.body.student_userid with the
// verified id -- so every existing route below, unchanged, automatically
// stops trusting anything the client merely claims.
const IDENTITY_SECRET = process.env.IDENTITY_SECRET || '';
if (!IDENTITY_SECRET) {
  console.warn('WARNING: IDENTITY_SECRET is not set -- identity verification is disabled and every request will be treated as anonymous. Set it to match block_criterio\'s configured secret.');
}
// Separate secret, shared with rennix-lti specifically (not block_criterio).
// Kept distinct from IDENTITY_SECRET because it authenticates a fleet of
// institutions through one connector, not one Moodle's own plugin config --
// rotating one should never require touching the other.
const LTI_BRIDGE_SECRET = process.env.LTI_BRIDGE_SECRET || '';
if (!LTI_BRIDGE_SECRET) {
  console.warn('WARNING: LTI_BRIDGE_SECRET is not set -- LTI-launched institutions cannot be verified. Set it to match rennix-lti\'s configured secret.');
}
const IDENTITY_COOKIE_MAX_AGE_MS = 8 * 60 * 60 * 1000;

// Our own persistent-cookie token, issued regardless of whether the request
// was originally authenticated via block_criterio's secret or rennix-lti's --
// once verified, the browser's ongoing session with us is just ours.
function signIdentityToken(userid, tenant, product, courseId, resourceLinkId) {
  const payload = Buffer.from(JSON.stringify({
    userid, tenant: tenant || DEFAULT_TENANT, product: product || null,
    courseId: courseId || null, resourceLinkId: resourceLinkId || null,
    exp: Date.now() + IDENTITY_COOKIE_MAX_AGE_MS,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', IDENTITY_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyIdentityToken(token) {
  if (!IDENTITY_SECRET || !token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', IDENTITY_SECRET).update(payload).digest('base64url');
  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch (e) { return null; }
  if (!parsed.userid || !parsed.exp || parsed.exp < Date.now()) return null;
  // Tokens signed by block_criterio's PHP side predate the tenant/product
  // fields entirely (that plugin only ever served HTU, one product) --
  // default rather than reject, so the existing Moodle-native flow keeps
  // working unchanged.
  return {
    userid: parsed.userid, tenant: parsed.tenant || DEFAULT_TENANT, product: parsed.product || null,
    courseId: parsed.courseId || null, resourceLinkId: parsed.resourceLinkId || null,
  };
}

// rennix-lti mints this after independently verifying a platform-signed
// id_token against that platform's own published JWKS -- a completely
// different, per-institution cryptographic check that never touches this
// secret. The tenant named inside is only ever one rennix-lti itself
// resolved from that check (via its own platforms registry), so trusting
// it here doesn't mean trusting whatever a browser happens to send --
// forging a tenant would require either secret, not a guessed query string.
function verifyLtiBridgeToken(token) {
  if (!LTI_BRIDGE_SECRET || !token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', LTI_BRIDGE_SECRET).update(payload).digest('base64url');
  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch (e) { return null; }
  if (!parsed.userid || !parsed.tenant || !parsed.exp || parsed.exp < Date.now()) return null;
  if (!TENANT_SLUG_RE.test(parsed.tenant)) return null;
  return parsed; // { userid, tenant, role, fullname, email, exp }
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

app.use((req, res, next) => {
  let verifiedUserId = null;
  let tenant = DEFAULT_TENANT;
  let product = null; // 'analytics' | 'tutor_bot' | null (null = legacy Moodle-native path, full access)
  let ltiProfile = null; // set only on a fresh, just-verified LTI bridge token
  // Verified from the signed launch, not the client -- which Moodle course and
  // which specific resource-link activity this session originated from.
  // Previously computed in rennix-lti and silently dropped before reaching
  // here; now carried through so it's actually available (audit logging,
  // and any future per-course scoping) instead of unrecoverable once lost.
  let courseId = null;
  let resourceLinkId = null;

  // A fresh signed token from Moodle's identify handoff, or from an LTI
  // launch -- verify it and (re)issue our own session cookie so subsequent
  // same-browser requests (including plain link clicks with no token) stay
  // authenticated, and stay pinned to the same tenant and product.
  if (req.query.t) {
    const legacy = verifyIdentityToken(String(req.query.t));
    if (legacy) {
      verifiedUserId = legacy.userid;
      tenant = legacy.tenant;
      product = legacy.product;
      courseId = legacy.courseId;
      resourceLinkId = legacy.resourceLinkId;
    } else {
      const lti = verifyLtiBridgeToken(String(req.query.t));
      if (lti) {
        verifiedUserId = lti.userid;
        tenant = lti.tenant;
        product = lti.product || null;
        courseId = lti.courseId || null;
        resourceLinkId = lti.resourceLinkId || null;
        ltiProfile = lti;
      }
    }
    if (verifiedUserId) {
      // Framed inside the LMS page (e.g. the Tutor Bot panel next to a lecture
      // video), this app is a cross-site iframe: a SameSite=Lax cookie would
      // never come back on the panel's own follow-up requests. There it's set
      // SameSite=None + Partitioned (CHIPS), i.e. scoped to that LMS site only.
      const framed = req.get('sec-fetch-dest') === 'iframe';
      res.cookie('identity', signIdentityToken(verifiedUserId, tenant, product, courseId, resourceLinkId), {
        httpOnly: true, secure: true, maxAge: IDENTITY_COOKIE_MAX_AGE_MS,
        ...(framed ? { sameSite: 'none', partitioned: true } : { sameSite: 'lax' }),
      });
    }
  }

  if (!verifiedUserId) {
    const cookies = parseCookies(req.headers.cookie);
    const verified = verifyIdentityToken(cookies.identity);
    if (verified) {
      verifiedUserId = verified.userid;
      tenant = verified.tenant;
      product = verified.product;
      courseId = verified.courseId;
      resourceLinkId = verified.resourceLinkId;
    }
  }

  req.verifiedUserId = verifiedUserId;
  req.ltiProduct = product;
  req.ltiCourseId = courseId;
  req.ltiResourceLinkId = resourceLinkId;

  // The security boundary: whatever the client actually sent in these
  // fields is discarded and replaced with the verified value (or blanked
  // out entirely if unverified). Target-selection params (lecture id,
  // section key, a specific student id an instructor is drilling into) are
  // untouched -- only the "who is making this request" fields are rewritten.
  if (req.query.student !== undefined) req.query.student = verifiedUserId ? String(verifiedUserId) : '';
  if (req.query.as !== undefined) req.query.as = verifiedUserId ? String(verifiedUserId) : '';
  if (req.body && typeof req.body === 'object' && 'student_userid' in req.body) {
    req.body.student_userid = verifiedUserId || null;
  }

  tenantContext.run({ tenant, courseId }, () => {
    if (ltiProfile) {
      rememberLtiBranding(ltiProfile);
      // No Moodle-style manual roster sync exists for institutions that
      // connect via LTI -- auto-provision the student row right here, from
      // claims the platform itself already vouched for in its signed
      // id_token (name/email/role), so a first-time launch just works.
      try {
        db.prepare(
          'INSERT INTO students (userid, username, fullname, role, email) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT(userid) DO UPDATE SET fullname = excluded.fullname, role = excluded.role, ' +
          'email = COALESCE(excluded.email, students.email)'
        ).run(
          ltiProfile.userid, `lti-${ltiProfile.userid}`, ltiProfile.fullname || `User ${ltiProfile.userid}`,
          ltiProfile.role, ltiProfile.email || null
        );
      } catch (e) {
        console.error('[LTI] student auto-provision failed:', e.message);
      }
    }
    next();
  });
});

// ---- Branding: which school and course a page is for ----
// These pages grew up as the single-tenant HTU CS101 pilot, so the school and
// course names used to be hard-coded. An LTI launch now carries the school's
// name and the LMS's own course title/code (display-only; see rennix-lti's
// launch.js), remembered per tenant database so later same-session page loads
// (which only have the identity cookie, not the launch token) can show them.
// The legacy Moodle-plugin path for the default tenant keeps the original
// pilot text, so nothing changes for it.
const LEGACY_BRANDING = { schoolShort: 'HTU', courseCode: 'CS101', courseTitle: 'Programming Fundamentals' };

function ensureLtiCoursesTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS lti_courses (
    course_id TEXT PRIMARY KEY, title TEXT, label TEXT, updated_at INTEGER NOT NULL
  )`);
}

function rememberLtiBranding(profile) {
  try {
    if (profile.tenantName && getSetting('tenant_display_name', null) !== profile.tenantName) {
      setSetting('tenant_display_name', String(profile.tenantName).slice(0, 200));
    }
    if (profile.courseId && (profile.courseTitle || profile.courseLabel)) {
      ensureLtiCoursesTable();
      db.prepare(
        'INSERT INTO lti_courses (course_id, title, label, updated_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(course_id) DO UPDATE SET title = excluded.title, label = excluded.label, updated_at = excluded.updated_at'
      ).run(String(profile.courseId), profile.courseTitle ? String(profile.courseTitle).slice(0, 255) : null,
        profile.courseLabel ? String(profile.courseLabel).slice(0, 100) : null, Date.now());
    }
  } catch (e) {
    console.error('[LTI] remembering branding failed:', e.message);
  }
}

// { schoolShort, schoolName, courseCode, courseTitle, courseFull } for the
// current request's tenant/course (from the tenantContext store).
function getBranding() {
  const store = tenantContext.getStore() || {};
  const tenant = store.tenant || DEFAULT_TENANT;
  const isLegacyTenant = tenant === DEFAULT_TENANT;
  let course = null;
  if (store.courseId) {
    try {
      ensureLtiCoursesTable();
      course = db.prepare('SELECT title, label FROM lti_courses WHERE course_id = ?').get(String(store.courseId));
    } catch (e) { /* fall through to defaults */ }
  }
  const schoolShort = getSetting('tenant_short_name', null) || (isLegacyTenant ? LEGACY_BRANDING.schoolShort : tenant.toUpperCase());
  const schoolName = getSetting('tenant_display_name', null) || schoolShort;
  const courseTitle = (course && (course.title || course.label))
    || getSetting('course_title', null) || (isLegacyTenant ? LEGACY_BRANDING.courseTitle : 'Your course');
  const courseCode = course
    ? (course.label && course.label !== courseTitle ? course.label : '')
    : (getSetting('course_code', null) || (isLegacyTenant ? LEGACY_BRANDING.courseCode : ''));
  return { schoolShort, schoolName, courseCode, courseTitle, courseFull: courseCode ? `${courseCode} — ${courseTitle}` : courseTitle };
}

// ---- Capability model ----
// Two internal roles exist above 'student': 'section_instructor' (content and
// analytics access) and 'course_supervisor' (everything section_instructor has,
// plus quality-control authority over the Verification queue). Call sites used
// to check `viewerRole.role === 'course_supervisor'` or an inline
// ['course_supervisor','section_instructor'].includes(...) array directly --
// readable in isolation, but it means "who can verify content" is defined by
// re-deriving it from a raw role string wherever it happens to be checked,
// rather than in one place. ROLE_CAPABILITIES is that one place.
const ROLE_CAPABILITIES = {
  student: [],
  section_instructor: ['view_dashboard', 'manage_content', 'view_analytics', 'view_attendance', 'view_reports'],
  course_supervisor: ['view_dashboard', 'manage_content', 'view_analytics', 'view_attendance', 'view_reports', 'verify_content', 'manage_attendance_policy'],
};
function hasCapability(role, capability) {
  return (ROLE_CAPABILITIES[role] || []).includes(capability);
}

function requireInstructor(req, res, next) {
  const viewer = req.verifiedUserId
    ? db.prepare("SELECT role FROM students WHERE userid = ?").get(req.verifiedUserId)
    : null;
  if (!viewer || !hasCapability(viewer.role, 'view_dashboard')) {
    logAuditEvent('instructor_route_denied', `path=${req.path} userid=${req.verifiedUserId || 'none'} role=${viewer ? viewer.role : 'none'}`, req);
    return res.status(403).send('Instructor access only. Open this from your Moodle course as a course instructor.');
  }
  next();
}

app.get('/health', (req, res) => res.json({ ok: true }));

// ---- AI Learning Arena control panel: view/switch the active model config live,
// no redeploy needed. This is the concrete "swap without rebuilding the Moodle
// plugin or the learner journey" mechanism the config registry above exists for. ----

app.get('/admin/model-config', requireTenantAdmin, (req, res) => {
  const activeId = getSetting('active_model_config', process.env.ACTIVE_MODEL_CONFIG || DEFAULT_MODEL_CONFIG_ID);
  const configs = Object.values(MODEL_CONFIGS);

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>AI Learning Arena — Model Config</title>
<style>
  ${APP_SHELL_STYLES}
  .cfg-row { display:flex; align-items:center; gap:12px; padding:14px; }
  .cfg-row + .cfg-row { border-top:1px solid #eef1f4; }
  .cfg-name { font-weight:700; font-size:14px; }
  .cfg-meta { color:#57606a; font-size:12px; margin-top:2px; }
  .cfg-active { background:#fdecee; color:#a10f22; font-weight:700; font-size:11px; padding:3px 10px; border-radius:20px; }
  form { margin:0; }
  button { border:1px solid #e2e8f0; background:#fff; border-radius:8px; padding:6px 14px; font-size:12px; font-weight:700; cursor:pointer; }
  button.primary { background:#d41128; border-color:#d41128; color:#fff; }
</style></head>
<body>
<div class="app-topbar"></div>
<div class="app-main">
  <div class="app-h1">AI Learning Arena</div>
  <p class="app-sub">Every chat and embedding call in tutor-service uses whichever config is active here. Switching takes effect immediately for all new requests -- no redeploy, no Moodle plugin change.</p>
  <div class="app-card" style="padding:0;">
    ${configs.map((c) => `
      <div class="cfg-row">
        <div style="flex:1;">
          <div class="cfg-name">${escapeHtml(c.label)}</div>
          <div class="cfg-meta">chat: ${escapeHtml(c.chatModel)} &middot; embed: ${escapeHtml(c.embedModel)} &middot; endpoint: ${escapeHtml(c.baseURL || 'api.openai.com (default)')}</div>
        </div>
        ${c.id === activeId
          ? '<span class="cfg-active">ACTIVE</span>'
          : `<form method="post" action="/admin/model-config"><input type="hidden" name="config_id" value="${escapeHtml(c.id)}"><button class="primary" type="submit">Make active</button></form>`}
      </div>`).join('')}
  </div>
  <p class="app-sub" style="margin-top:16px;">To add a self-hosted backend, add an entry to <code>MODEL_CONFIGS</code> in server.js (baseURL pointed at the vLLM/Ollama server, model names matching what's loaded there), redeploy once, then switch to it here whenever you're ready to test it.</p>
</div>
</body></html>`);
});

app.post('/admin/model-config', express.urlencoded({ extended: true }), requireTenantAdmin, (req, res) => {
  const { config_id } = req.body;
  if (!config_id || !MODEL_CONFIGS[config_id]) {
    return res.status(400).send('Unknown config_id');
  }
  setSetting('active_model_config', config_id);
  logAuditEvent('model_config_changed', config_id, req);
  res.redirect('/admin/model-config');
});

// ---- Per-tenant setup: give a new institution its own OpenAI billing ----
// The rest of onboarding (LTI platform registration) lives in rennix-lti's
// own admin form, which calls this endpoint over HTTP as its second step --
// this is the one setting tutor-service itself owns. Visiting/creating a
// tenant that doesn't exist yet is fine: getTenantDb() clones HTU's schema
// and wipes it, same as a real first launch would.
// ---- Tenant-admin session cookie ----
// Every route below used to accept TENANT_ADMIN_SECRET via req.query.secret or
// req.body.secret -- which meant it showed up in the URL for every browser-facing
// admin page (tenant-settings, billing, usage-report links), landing in browser
// history and any access logs. Same fix as rennix-lti's /admin: log in once via
// POST /admin/tenant-login (secret in the body only, distinct path from
// rennix-lti's own /admin/login -- these are two separate services sharing the
// /admin prefix, not one login), get a signed HttpOnly/Secure/
// SameSite=Strict cookie back, and every subsequent page load/redirect on this
// tenant-admin surface uses that instead of re-embedding the secret in the URL.
// The x-tenant-admin-secret header stays available for server-to-server callers
// (rennix-lti's onboarding flow) -- a header doesn't leak the way a URL does.
const TENANT_ADMIN_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function signTenantAdminSession() {
  const body = Buffer.from(JSON.stringify({ type: 'tenant_admin', exp: Date.now() + TENANT_ADMIN_SESSION_MAX_AGE_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', TENANT_ADMIN_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyTenantAdminSession(token) {
  if (!token || typeof token !== 'string' || !TENANT_ADMIN_SECRET) return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  const expectedSig = crypto.createHmac('sha256', TENANT_ADMIN_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch (e) { return false; }
  return parsed.type === 'tenant_admin' && typeof parsed.exp === 'number' && parsed.exp > Date.now();
}

function requireTenantAdmin(req, res, next) {
  const headerSecret = req.get('x-tenant-admin-secret');
  if (TENANT_ADMIN_SECRET && headerSecret && headerSecret === TENANT_ADMIN_SECRET) return next();
  const cookies = parseCookies(req.headers.cookie);
  if (verifyTenantAdminSession(cookies.tenant_admin_session)) return next();
  if (req.method === 'GET' && req.accepts('html')) return res.redirect('/admin/tenant-login');
  logAuditEvent('tenant_admin_denied', `path=${req.path}`, req);
  return res.status(401).json({ error: 'Missing or invalid admin credentials.' });
}

app.get('/admin/tenant-login', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  if (verifyTenantAdminSession(cookies.tenant_admin_session)) return res.redirect('/admin/billing');
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
    <form method="post" action="/admin/tenant-login">
      <label>Admin secret</label>
      <input name="secret" type="password" required autofocus>
      <button type="submit">Sign in</button>
    </form>
    ${req.query.error ? '<div class="err">Invalid secret.</div>' : ''}
  </div>
</body></html>`);
});

app.post('/admin/tenant-login', rateLimit('admin-login', 5, 15 * 60 * 1000), express.urlencoded({ extended: true }), (req, res) => {
  const provided = req.body && req.body.secret;
  if (!TENANT_ADMIN_SECRET || provided !== TENANT_ADMIN_SECRET) {
    logAuditEvent('tenant_admin_login_failed', null, req);
    return res.redirect('/admin/tenant-login?error=1');
  }
  logAuditEvent('tenant_admin_login_success', null, req);
  res.cookie('tenant_admin_session', signTenantAdminSession(), {
    httpOnly: true, secure: true, sameSite: 'strict', maxAge: TENANT_ADMIN_SESSION_MAX_AGE_MS,
  });
  res.redirect('/admin/billing');
});

app.post('/admin/tenant-logout', (req, res) => {
  res.clearCookie('tenant_admin_session');
  res.redirect('/admin/tenant-login');
});

// rennix-lti calls this before allocating a fresh synthetic id for a new LTI
// launch -- HTU specifically already has real students with real history
// (attendance, chat, notes) under their existing small-integer ids from the
// Moodle-plugin path; without this, the exact same person launching via LTI
// instead would silently become a second, historyless account. Any tenant
// that only ever arrives via LTI never has a pre-existing row to match, so
// this is a no-op cost for them -- just always allocating fresh, as before.
app.get('/admin/tenant-user-lookup', requireTenantAdmin, (req, res) => {
  const tenant = String(req.query.tenant || '').toLowerCase();
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!tenant || !TENANT_SLUG_RE.test(tenant) || !email) {
    return res.status(400).json({ error: 'tenant and email are required.' });
  }
  const tdb = getTenantDb(tenant);
  const row = tdb.prepare('SELECT userid FROM students WHERE lower(email) = ?').get(email);
  res.json({ userid: row ? row.userid : null });
});

// ---- Where each student is in an LMS-hosted video (Vimeo "option B") ----
// Institutions like HTU play lecture videos as Vimeo embeds inside their own
// LMS pages, not inside this app -- so this app can't read the player itself.
// A small script on the LMS page (local_rennixtutorbot) reports play/pause/
// seek positions to rennix-lti, which verifies the LMS-signed report, maps
// the LMS user to this tenant's userid, and relays it here. The chat widget
// then reads the student's latest position so a question asked while paused
// at 2:45 is answered from that moment of that lecture.
const PLAYBACK_FRESH_MS = 30 * 60 * 1000;
function ensurePlaybackTable(tdb) {
  tdb.exec(`CREATE TABLE IF NOT EXISTS playback_state (
    student_userid INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    video_ref TEXT NOT NULL,
    position REAL NOT NULL,
    state TEXT NOT NULL,
    lms_course_id TEXT,
    updated_at INTEGER NOT NULL
  )`);
}

app.post('/admin/playback', requireTenantAdmin, (req, res) => {
  const tenant = String(req.body.tenant || '').toLowerCase();
  const userid = Number(req.body.userid);
  const videoRef = String(req.body.videoRef || '');
  const position = Number(req.body.position);
  const state = String(req.body.state || '');
  if (!TENANT_SLUG_RE.test(tenant) || !Number.isInteger(userid) || !/^\d{1,20}$/.test(videoRef)
      || !Number.isFinite(position) || position < 0 || !['playing', 'paused', 'ended'].includes(state)) {
    return res.status(400).json({ error: 'tenant, userid, videoRef (Vimeo id), position and state are required.' });
  }
  const tdb = getTenantDb(tenant);
  ensurePlaybackTable(tdb);
  tdb.prepare(
    'INSERT INTO playback_state (student_userid, provider, video_ref, position, state, lms_course_id, updated_at) ' +
    "VALUES (?, 'vimeo', ?, ?, ?, ?, ?) ON CONFLICT(student_userid) DO UPDATE SET provider = excluded.provider, " +
    'video_ref = excluded.video_ref, position = excluded.position, state = excluded.state, ' +
    'lms_course_id = excluded.lms_course_id, updated_at = excluded.updated_at'
  ).run(userid, videoRef, position, state, req.body.courseId ? String(req.body.courseId).slice(0, 100) : null, Date.now());
  res.json({ ok: true });
});

// The signed-in student's own latest position (identity from the verified
// cookie, never a client-supplied id). `lecture_id` is set only when the Vimeo
// video is linked to an ingested lecture here (lectures.video_url = Vimeo id),
// which is what lets /chat ground the answer in that lecture's transcript.
app.get('/app/playback-context', (req, res) => {
  if (!req.verifiedUserId) return res.json({ active: false });
  ensurePlaybackTable(db);
  const row = db.prepare('SELECT * FROM playback_state WHERE student_userid = ?').get(req.verifiedUserId);
  if (!row || Date.now() - row.updated_at > PLAYBACK_FRESH_MS) return res.json({ active: false });
  const lecture = db.prepare("SELECT lecture_id, title FROM lectures WHERE video_provider = 'vimeo' AND video_url = ?").get(row.video_ref);
  res.json({
    active: true,
    video_ref: row.video_ref,
    position: row.position,
    state: row.state,
    age_seconds: Math.round((Date.now() - row.updated_at) / 1000),
    lecture_id: lecture ? lecture.lecture_id : null,
    lecture_title: lecture ? lecture.title : null,
  });
});

// ---- Knowledge check under an LMS-hosted video ----
// local_rennixtutorbot frames /widget/knowledge-check?video=<Vimeo id> under
// each lecture video (via rennix-lti's /embed/knowledge-check redirect). The
// questions are the lecture's approved end-of-video pop-up questions -- the
// ones /quiz/generate drafts from the lecture transcript and an instructor
// approves in /quiz/review. Identity comes from the Tutor Bot panel's LTI
// launch next to the video (same browser session), so there's no extra login.
app.get('/app/knowledge-check', (req, res) => {
  if (!req.verifiedUserId) return res.status(401).json({ error: 'not_identified' });
  const videoRef = String(req.query.video || '');
  if (!/^\d{1,20}$/.test(videoRef)) return res.status(400).json({ error: 'video must be a Vimeo id' });
  const lecture = db.prepare("SELECT lecture_id, title FROM lectures WHERE video_provider = 'vimeo' AND video_url = ?").get(videoRef);
  if (!lecture) return res.json({ lecture: null, questions: [] });
  const rows = db.prepare(
    "SELECT id, question, options FROM popup_questions WHERE lecture_id = ? AND status = 'approved' AND placement = 'end_of_video' ORDER BY timestamp ASC, id ASC"
  ).all(lecture.lecture_id);
  const latest = db.prepare(
    "SELECT status FROM popup_responses WHERE popup_question_id = ? AND student_userid = ? AND status IN ('answered_correct', 'answered_incorrect') ORDER BY id DESC LIMIT 1"
  );
  res.json({
    lecture: { id: lecture.lecture_id, title: lecture.title },
    questions: rows.map((r) => {
      const prev = latest.get(r.id, req.verifiedUserId);
      return { id: r.id, question: r.question, options: JSON.parse(r.options), answered: prev ? prev.status === 'answered_correct' : null };
    }),
  });
});

app.get('/widget/knowledge-check', (req, res) => {
  const videoRef = /^\d{1,20}$/.test(String(req.query.video || '')) ? String(req.query.video) : '';
  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Knowledge check</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; margin: 0; padding: 14px 16px; color: #1a1a1a; background: #fff; font-size: 14px; }
  h2 { font-size: 16px; margin: 0 0 2px; display: flex; align-items: center; gap: 8px; }
  h2 .dot { width: 10px; height: 10px; border-radius: 50%; background: #d6293e; display: inline-block; }
  .sub { color: #57606a; font-size: 12px; margin: 0 0 12px; }
  .q { border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 10px; }
  .q p { margin: 0 0 8px; font-weight: 600; }
  .opts { display: flex; flex-direction: column; gap: 6px; }
  .opts button { text-align: left; font: inherit; padding: 8px 10px; border: 1px solid #d0d7de; border-radius: 6px; background: #f6f8fa; cursor: pointer; }
  .opts button:hover:not(:disabled) { border-color: #d6293e; }
  .opts button:disabled { cursor: default; }
  .opts button.right { background: #e6f7ec; border-color: #1f9d55; }
  .opts button.wrong { background: #fdecee; border-color: #d6293e; }
  .fb { margin-top: 8px; font-size: 13px; }
  .fb.ok { color: #1f7a45; } .fb.no { color: #a10f22; }
  .retry { font: inherit; font-size: 12px; margin-top: 6px; background: none; border: none; color: #57606a; text-decoration: underline; cursor: pointer; padding: 0; }
  .muted { color: #57606a; }
  .score { margin: 4px 0 10px; font-weight: 600; }
</style>${FRAMED_EMBED_SCRIPT}</head>
<body>
  <h2><span class="dot"></span> Knowledge check</h2>
  <div class="sub" id="sub">Checking your answers on this lecture...</div>
  <div id="score" class="score" hidden></div>
  <div id="list"><p class="muted" id="status">Connecting to Rennix...</p></div>
<script>
(function () {
  var VIDEO = ${JSON.stringify(videoRef)};
  var list = document.getElementById('list');
  var statusEl = document.getElementById('status');
  var results = {};
  var attempts = 0;

  function renderScore(total) {
    var done = Object.keys(results).length, right = 0;
    for (var k in results) if (results[k]) right++;
    var el = document.getElementById('score');
    el.hidden = done === 0;
    el.textContent = right + ' of ' + total + ' correct' + (done < total ? ' (' + (total - done) + ' left)' : '');
  }

  function renderQuestion(q, total) {
    var box = document.createElement('div');
    box.className = 'q';
    var p = document.createElement('p');
    p.textContent = q.question;
    box.appendChild(p);
    var opts = document.createElement('div');
    opts.className = 'opts';
    var fb = document.createElement('div');
    fb.className = 'fb';
    q.options.forEach(function (text, idx) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.addEventListener('click', function () { answer(q, idx, opts, fb, total); });
      opts.appendChild(b);
    });
    box.appendChild(opts);
    box.appendChild(fb);
    if (q.answered !== null) {
      results[q.id] = q.answered;
      fb.className = 'fb ' + (q.answered ? 'ok' : 'no');
      fb.textContent = q.answered ? 'You answered this correctly.' : 'Your last answer was incorrect -- try again.';
      if (q.answered) opts.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    }
    return box;
  }

  function answer(q, idx, opts, fb, total) {
    var buttons = opts.querySelectorAll('button');
    buttons.forEach(function (b) { b.disabled = true; b.className = ''; });
    fetch('/popups/respond', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      // student_userid is replaced server-side with the verified session user.
      body: JSON.stringify({ popup_question_id: q.id, student_userid: 'session', selected_index: idx })
    }).then(function (r) { return r.json(); }).then(function (d) {
      results[q.id] = !!d.correct;
      buttons[idx].className = d.correct ? 'right' : 'wrong';
      if (!d.correct && typeof d.correct_index === 'number' && buttons[d.correct_index]) buttons[d.correct_index].className = 'right';
      fb.className = 'fb ' + (d.correct ? 'ok' : 'no');
      fb.textContent = (d.correct ? 'Correct! ' : 'Not quite. ') + (d.explanation || '');
      if (!d.correct) {
        var again = document.createElement('button');
        again.className = 'retry';
        again.textContent = 'Try again';
        again.addEventListener('click', function () {
          buttons.forEach(function (b) { b.disabled = false; b.className = ''; });
          fb.textContent = ''; again.remove();
        });
        fb.appendChild(document.createElement('br'));
        fb.appendChild(again);
      }
      renderScore(total);
    }).catch(function () {
      buttons.forEach(function (b) { b.disabled = false; });
      fb.className = 'fb no';
      fb.textContent = 'Could not save your answer -- please try again.';
    });
  }

  function load() {
    if (!VIDEO) { statusEl.textContent = 'No video found for this knowledge check.'; return; }
    fetch('/app/knowledge-check?video=' + encodeURIComponent(VIDEO), { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) throw new Error('not_identified');
        return r.json();
      })
      .then(function (d) {
        if (!d.lecture) { statusEl.textContent = 'This video is not linked to a Rennix lecture yet.'; document.getElementById('sub').textContent = ''; return; }
        document.getElementById('sub').textContent = d.lecture.title;
        if (!d.questions.length) { statusEl.textContent = 'No knowledge-check questions have been published for this lecture yet.'; return; }
        list.innerHTML = '';
        d.questions.forEach(function (q) { list.appendChild(renderQuestion(q, d.questions.length)); });
        renderScore(d.questions.length);
      })
      .catch(function (e) {
        // The Tutor Bot panel beside the video signs the student in via LTI;
        // until that finishes there's no session yet -- wait for it.
        if (e.message === 'not_identified' && ++attempts < 30) { setTimeout(load, 2000); return; }
        statusEl.textContent = e.message === 'not_identified'
          ? 'Open the Tutor Bot next to the video to load your knowledge check.'
          : 'Could not load the knowledge check.';
      });
  }
  load();
})();
</script>
</body></html>`);
});

app.get('/admin/tenant-settings', requireTenantAdmin, (req, res) => {
  const tenant = String(req.query.tenant || '');
  let hasKey = false;
  if (tenant && TENANT_SLUG_RE.test(tenant)) {
    const tdb = getTenantDb(tenant);
    hasKey = !!tdb.prepare('SELECT 1 FROM app_settings WHERE key = ?').get('tenant_openai_api_key');
  }
  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Tenant setup</title>
<style>
  ${APP_SHELL_STYLES}
  label { display:block; font-weight:700; font-size:13px; margin:14px 0 4px; }
  input { width:100%; box-sizing:border-box; padding:9px 10px; border:1px solid #ccc; border-radius:6px; font-size:13px; }
  button { margin-top:20px; padding:10px 18px; border:none; border-radius:8px; background:#d41128; color:#fff; font-weight:700; cursor:pointer; }
  .hint { color:#57606a; font-size:12px; margin-top:4px; }
</style></head>
<body>
<div class="app-topbar"></div>
<div class="app-main" style="max-width:480px;">
  <div class="app-h1">Tenant setup</div>
  <p class="app-sub">Set an institution's own OpenAI API key. Once set, every chat and embedding call for that tenant uses it instead of the default -- their own billing, not shared.</p>
  <form method="post" action="/admin/tenant-settings">
    <label>Tenant key (slug, e.g. "htu")</label>
    <input name="tenant" value="${escapeHtml(tenant)}" required pattern="[a-z0-9-]+" title="lowercase letters, numbers, hyphens only">
    <label>OpenAI API key</label>
    <input name="openai_api_key" type="password" placeholder="${hasKey ? 'Already set -- leave blank to keep it' : 'sk-...'}">
    <div class="hint">${hasKey ? 'A key is already set for this tenant.' : 'No key set yet for this tenant -- it will fall back to the shared default until one is set.'}</div>
    <button type="submit">Save</button>
  </form>
</div>
</body></html>`);
});

app.post('/admin/tenant-settings', express.urlencoded({ extended: true }), requireTenantAdmin, (req, res) => {
  const tenant = String(req.body.tenant || '').toLowerCase();
  const apiKey = String(req.body.openai_api_key || '').trim();
  if (!tenant || !TENANT_SLUG_RE.test(tenant)) {
    return res.status(400).send('Invalid tenant slug.');
  }
  const tdb = getTenantDb(tenant);
  if (apiKey) {
    logAuditEvent('tenant_openai_key_set', null, req, tenant);
    tdb.prepare(
      'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run('tenant_openai_api_key', apiKey, Date.now());
  }
  res.redirect(`/admin/tenant-settings?tenant=${encodeURIComponent(tenant)}`);
});

// Seed/update the student roster used to display names on the instructor dashboard.
// Body: { students: [{ userid, username, fullname, email }, ...] }
// This previously had no authentication at all -- anyone who found the route
// could inject fake roster rows into whichever tenant happened to be ambient
// from the request's own identity token, or none (defaulting to 'htu').
// requireTenantAdmin now gates it, and it operates on an explicit `tenant` in
// the body via getTenantDb() (same pattern as /admin/tenant-settings) instead
// of relying on ambient ombient tenant resolution -- the caller states which
// tenant's roster it's syncing, rather than it being inferred from ambient context.
app.post('/students/sync', requireTenantAdmin, (req, res) => {
  const { students } = req.body;
  const tenant = String(req.body.tenant || '').toLowerCase();
  if (!tenant || !TENANT_SLUG_RE.test(tenant)) {
    return res.status(400).json({ error: 'tenant is required.' });
  }
  if (!Array.isArray(students)) {
    return res.status(400).json({ error: 'students array is required' });
  }
  const tdb = getTenantDb(tenant);
  const upsert = tdb.prepare(
    'INSERT INTO students (userid, username, fullname, email, role) VALUES (?, ?, ?, ?, COALESCE(?, \'student\')) ' +
    'ON CONFLICT(userid) DO UPDATE SET username = excluded.username, fullname = excluded.fullname, ' +
    'email = COALESCE(excluded.email, students.email), ' +
    // Never downgrade an existing instructor-tier role back to 'student' just because
    // a roster sync run didn't happen to carry role info for them that time.
    'role = CASE WHEN excluded.role != \'student\' THEN excluded.role ELSE students.role END'
  );
  const tx = tdb.transaction(() => {
    for (const s of students) upsert.run(s.userid, s.username, s.fullname, s.email || null, s.role || null);
  });
  tx();

  // Auto-assign any newly-synced student to a section, round-robin across
  // the ones that exist, so nobody silently falls out of the Course
  // Overview cohort stats (which only count students with a section).
  const sectionKeys = tdb.prepare('SELECT key FROM course_sections ORDER BY key').all().map((r) => r.key);
  if (sectionKeys.length) {
    const unassigned = tdb.prepare("SELECT userid FROM students WHERE role = 'student' AND section IS NULL ORDER BY userid").all();
    unassigned.forEach((s, i) => {
      tdb.prepare('UPDATE students SET section = ? WHERE userid = ?').run(sectionKeys[i % sectionKeys.length], s.userid);
    });
  }

  logAuditEvent('roster_synced', `members=${students.length}`, req, tenant);
  res.json({ ok: true, count: students.length });
});

// Real, pickable content for rennix-lti's Deep Linking content picker -- an
// instructor choosing a specific lecture to deep-link into needs to see
// actual course content, not a hardcoded/invented list. Read-only, tenant-
// admin gated (same as every other cross-service call rennix-lti makes).
app.get('/content/lectures', requireTenantAdmin, (req, res) => {
  const tenant = String(req.query.tenant || '').toLowerCase();
  if (!tenant || !TENANT_SLUG_RE.test(tenant)) {
    return res.status(400).json({ error: 'tenant is required.' });
  }
  const tdb = getTenantDb(tenant);
  const lectures = tdb.prepare('SELECT * FROM lectures').all()
    .filter((l) => !l.lecture_id.startsWith('pdf-'))
    .sort(compareGlobalLectureOrder)
    .map((l) => {
      const chapterKey = chapterSectionKeyOf(l.lecture_id);
      return { lecture_id: l.lecture_id, title: l.title, chapterKey, chapterTitle: CHAPTER_SECTION_TITLES[chapterKey] || chapterKey };
    });
  res.json({ lectures });
});

// Logs a single engagement event (video play/pause/seek/ended/heartbeat/leave).
app.post('/track', (req, res) => {
  const { lecture_id, student_userid, event_type, position, duration, payload } = req.body;
  if (!lecture_id || !student_userid || !event_type) {
    return res.status(400).json({ error: 'lecture_id, student_userid and event_type are required' });
  }
  if (!VIDEO_EVENT_TYPES.has(event_type)) {
    return res.status(400).json({ error: `unknown event_type: ${event_type}` });
  }
  db.prepare(
    'INSERT INTO events (lecture_id, student_userid, event_type, position, duration, payload, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(lecture_id, student_userid, event_type, position ?? null, duration ?? null, payload ?? null, Date.now());
  res.json({ ok: true });
});

// Ingest a lecture transcript: chunk, embed, store. Re-ingesting a lecture_id replaces prior chunks.
app.post('/ingest', rateLimit('ingest', 10, 60 * 1000), async (req, res) => {
  try {
    const { lecture_id, title, text } = req.body;
    if (!lecture_id || !text) {
      return res.status(400).json({ error: 'lecture_id and text are required' });
    }

    const pieces = chunkText(text);
    const embeddings = [];
    for (const piece of pieces) {
      embeddings.push(await embed(piece));
    }

    const insertLecture = db.prepare(
      'INSERT INTO lectures (lecture_id, title, created_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(lecture_id) DO UPDATE SET title = excluded.title'
    );
    const deleteChunks = db.prepare('DELETE FROM chunks WHERE lecture_id = ?');
    const insertChunk = db.prepare(
      'INSERT INTO chunks (lecture_id, chunk_index, text, embedding, start_time, end_time) VALUES (?, ?, ?, ?, NULL, NULL)'
    );

    const tx = db.transaction(() => {
      insertLecture.run(lecture_id, title || lecture_id, Date.now());
      deleteChunks.run(lecture_id);
      pieces.forEach((piece, i) => {
        insertChunk.run(lecture_id, i, piece, JSON.stringify(embeddings[i]));
      });
    });
    tx();

    logAuditEvent('content_ingested', `lecture_id=${lecture_id} chunks=${pieces.length}`, req);
    res.json({ ok: true, lecture_id, chunks: pieces.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Ingest a lecture from pre-timestamped transcription segments (e.g. Whisper verbose_json
// segments: [{ text, start, end }, ...]). Groups them into chunks that retain time ranges,
// so /chat can answer "what happened around minute X" questions. Replaces prior chunks.
app.post('/ingest-segments', async (req, res) => {
  try {
    const { lecture_id, title, segments } = req.body;
    if (!lecture_id || !Array.isArray(segments) || segments.length === 0) {
      return res.status(400).json({ error: 'lecture_id and a non-empty segments array are required' });
    }

    const pieces = groupSegmentsIntoChunks(segments);
    const embeddings = [];
    for (const piece of pieces) {
      embeddings.push(await embed(piece.text));
    }

    const insertLecture = db.prepare(
      'INSERT INTO lectures (lecture_id, title, created_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(lecture_id) DO UPDATE SET title = excluded.title'
    );
    const deleteChunks = db.prepare('DELETE FROM chunks WHERE lecture_id = ?');
    const insertChunk = db.prepare(
      'INSERT INTO chunks (lecture_id, chunk_index, text, embedding, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?)'
    );

    const tx = db.transaction(() => {
      insertLecture.run(lecture_id, title || lecture_id, Date.now());
      deleteChunks.run(lecture_id);
      pieces.forEach((piece, i) => {
        insertChunk.run(lecture_id, i, piece.text, JSON.stringify(embeddings[i]), piece.start, piece.end);
      });
    });
    tx();

    res.json({ ok: true, lecture_id, chunks: pieces.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- PDF slide materials: text extraction, RAG ingestion (reuses the lecture_id/chunks
// machinery with a synthetic "pdf-N" lecture_id), viewer, and per-page notes. ----

async function ingestPdfText(title, moodleUrl, text) {
  const cleanText = text.replace(/\s+/g, ' ').trim();
  const result = db.prepare(
    'INSERT INTO pdf_materials (title, moodle_url, text_content, created_at) VALUES (?, ?, ?, ?)'
  ).run(title, moodleUrl, cleanText, Date.now());
  const pdfId = result.lastInsertRowid;
  const lectureId = `pdf-${pdfId}`;

  const pieces = chunkText(cleanText);
  const embeddings = [];
  for (const piece of pieces) embeddings.push(await embed(piece));

  const insertLecture = db.prepare(
    'INSERT INTO lectures (lecture_id, title, created_at) VALUES (?, ?, ?) ON CONFLICT(lecture_id) DO UPDATE SET title = excluded.title'
  );
  const insertChunk = db.prepare(
    'INSERT INTO chunks (lecture_id, chunk_index, text, embedding) VALUES (?, ?, ?, ?)'
  );
  const tx = db.transaction(() => {
    insertLecture.run(lectureId, title, Date.now());
    pieces.forEach((piece, i) => insertChunk.run(lectureId, i, piece, JSON.stringify(embeddings[i])));
  });
  tx();

  return { pdfId, lectureId, chunks: pieces.length, chars: cleanText.length };
}

app.post('/pdf/ingest', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { title, moodle_url, wstoken } = req.body;
    if (!title || !moodle_url) return res.status(400).send('title and moodle_url are required');

    const fetchUrl = wstoken ? `${moodle_url}${moodle_url.includes('?') ? '&' : '?'}token=${wstoken}` : moodle_url;
    const fileRes = await fetch(fetchUrl);
    if (!fileRes.ok) return res.status(502).send(`Could not fetch PDF: ${fileRes.status}`);
    const buf = Buffer.from(await fileRes.arrayBuffer());
    const parsed = await pdfParse(buf);

    const result = await ingestPdfText(title, moodle_url, parsed.text);
    res.json({ ok: true, pdf_id: result.pdfId, lecture_id: result.lectureId, chunks: result.chunks, chars: result.chars });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Fallback for when the webservice pluginfile route rejects a server-side fetch (e.g. mod_resource
// access-control restrictions) — caller extracts the text itself and posts it directly.
app.post('/pdf/ingest-text', async (req, res) => {
  try {
    const { title, moodle_url, text } = req.body;
    if (!title || !text) return res.status(400).json({ error: 'title and text are required' });
    const result = await ingestPdfText(title, moodle_url || '', text);
    res.json({ ok: true, pdf_id: result.pdfId, lecture_id: result.lectureId, chunks: result.chunks, chars: result.chars });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Weaviate RAG ingestion (new pipeline; the SQLite/chunks path above is the older
// lecture-scoped one and is untouched) ----

app.post('/rag/ingest/transcript', rateLimit('rag-ingest', 20, 60 * 1000), async (req, res) => {
  try {
    const { course_id, source_id, source_title, video_id, segments, language } = req.body;
    if (!source_id || !Array.isArray(segments) || !segments.length) {
      return res.status(400).json({ error: 'source_id and a non-empty segments array are required' });
    }
    const tenant = tenantContext.getStore()?.tenant || DEFAULT_TENANT;
    const courseId = course_id || DEFAULT_COURSE_ID;
    const chunks = chunkSegmentsByTimeWindow(segments);
    const objects = chunks.map((c, i) => ({
      text: c.text,
      course_id: courseId,
      source_type: 'video_transcript',
      source_id,
      source_title: source_title || source_id,
      video_id: video_id || source_id,
      timestamp_start: c.timestamp_start,
      timestamp_end: c.timestamp_end,
      language: language || detectLanguage(c.text),
      chunk_index: i,
    }));
    const inserted = await insertChunksToWeaviate(tenant, objects);
    res.json({ ok: true, chunks: inserted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/rag/ingest/pdf', rateLimit('rag-ingest', 20, 60 * 1000), express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { title, moodle_url, wstoken, course_id, document_id } = req.body;
    if (!title || !moodle_url) return res.status(400).json({ error: 'title and moodle_url are required' });
    const tenant = tenantContext.getStore()?.tenant || DEFAULT_TENANT;
    const courseId = course_id || DEFAULT_COURSE_ID;
    const docId = document_id || title;

    const fetchUrl = wstoken ? `${moodle_url}${moodle_url.includes('?') ? '&' : '?'}token=${wstoken}` : moodle_url;
    const fileRes = await fetch(fetchUrl);
    if (!fileRes.ok) return res.status(502).json({ error: `Could not fetch PDF: ${fileRes.status}` });
    const buf = Buffer.from(await fileRes.arrayBuffer());
    const pageTexts = await extractPdfTextByPage(buf);

    const objects = [];
    pageTexts.forEach((pageText, pageIdx) => {
      chunkText(pageText).forEach((text, i) => {
        objects.push({
          text,
          course_id: courseId,
          source_type: 'pdf',
          source_id: docId,
          source_title: title,
          document_id: docId,
          page_number: pageIdx + 1,
          language: detectLanguage(text),
          chunk_index: i,
        });
      });
    });
    const inserted = await insertChunksToWeaviate(tenant, objects);
    res.json({ ok: true, chunks: inserted, pages: pageTexts.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Same-origin binary storage/serving so the browser's PDF.js canvas renderer can fetch()
// the file without hitting Moodle's cross-origin CORS restrictions.
app.post('/pdf/:id/file', express.raw({ type: 'application/pdf', limit: '25mb' }), (req, res) => {
  const pdf = db.prepare('SELECT id FROM pdf_materials WHERE id = ?').get(req.params.id);
  if (!pdf) return res.status(404).json({ error: 'Unknown pdf_id' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: 'Request body must be the raw PDF bytes (Content-Type: application/pdf)' });
  }
  db.prepare('UPDATE pdf_materials SET file_blob = ? WHERE id = ?').run(req.body, req.params.id);
  res.json({ ok: true, bytes: req.body.length });
});

app.get('/pdf/:id/file', (req, res) => {
  const pdf = db.prepare('SELECT file_blob FROM pdf_materials WHERE id = ?').get(req.params.id);
  if (!pdf || !pdf.file_blob) return res.status(404).send('No PDF file stored for this material yet.');
  res.set('Content-Type', 'application/pdf').send(pdf.file_blob);
});

app.post('/pdf/annotations', (req, res) => {
  const { pdf_id, student_userid, page, note } = req.body;
  if (!pdf_id || !student_userid || !note || !note.trim()) {
    return res.status(400).json({ error: 'pdf_id, student_userid and note are required' });
  }
  db.prepare(
    'INSERT INTO pdf_annotations (pdf_id, student_userid, page, note, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(pdf_id, student_userid, parseInt(page, 10) || 1, note.trim(), Date.now());
  res.json({ ok: true });
});

app.get('/pdf/annotations', (req, res) => {
  const { pdf_id, student } = req.query;
  const rows = db.prepare(
    'SELECT * FROM pdf_annotations WHERE pdf_id = ? AND student_userid = ? ORDER BY page ASC, created_at ASC'
  ).all(pdf_id, student);
  res.json({ annotations: rows });
});

// ---- PDF ink annotations: freehand pen/highlighter strokes anchored to a page, stored as
// normalized (0-1) point paths so they redraw correctly at any canvas/zoom size. ----

app.post('/pdf/ink', (req, res) => {
  const { pdf_id, student_userid, page, color, width, mode, points } = req.body;
  if (!pdf_id || !student_userid || !page || !Array.isArray(points) || points.length < 2) {
    return res.status(400).json({ error: 'pdf_id, student_userid, page and at least 2 points are required' });
  }
  const result = db.prepare(
    'INSERT INTO pdf_ink_strokes (pdf_id, student_userid, page, color, width, mode, points, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(pdf_id, student_userid, page, color || '#d6293e', Number(width) || 3, mode === 'highlighter' ? 'highlighter' : 'pen', JSON.stringify(points), Date.now());
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.get('/pdf/ink', (req, res) => {
  const { pdf_id, student, page } = req.query;
  const rows = db.prepare(
    'SELECT * FROM pdf_ink_strokes WHERE pdf_id = ? AND student_userid = ? AND page = ? ORDER BY created_at ASC'
  ).all(pdf_id, student, page);
  res.json({ strokes: rows.map((r) => ({ id: r.id, color: r.color, width: r.width, mode: r.mode, points: JSON.parse(r.points) })) });
});

app.delete('/pdf/ink/:id', (req, res) => {
  db.prepare('DELETE FROM pdf_ink_strokes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/pdf/ink/clear', (req, res) => {
  const { pdf_id, student_userid, page } = req.body;
  if (!pdf_id || !student_userid || !page) return res.status(400).json({ error: 'pdf_id, student_userid and page are required' });
  db.prepare('DELETE FROM pdf_ink_strokes WHERE pdf_id = ? AND student_userid = ? AND page = ?').run(pdf_id, student_userid, page);
  res.json({ ok: true });
});

app.get('/pdf/:id', (req, res) => {
  const pdf = db.prepare('SELECT * FROM pdf_materials WHERE id = ?').get(req.params.id);
  if (!pdf) return res.status(404).send('PDF not found');
  const lectureId = `pdf-${pdf.id}`;
  const hasFile = !!pdf.file_blob;
  const studentParam = req.query.student ? Number(req.query.student) : null;
  const backHref = `/app/course/cs101?student=${studentParam || ''}`;

  const INK_COLORS = ['#d41128', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#57606a', '#0b1220'];

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(pdf.title)}</title>
${hasFile ? '<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>' : ''}
<style>
  ${APP_SHELL_STYLES}
  html, body { height:100%; overflow:hidden; }
  #backdrop { position:fixed; inset:0; background:#e7eaee; display:flex; align-items:center; justify-content:center; padding:24px; }
  #modal { width:100%; max-width:1180px; height:90vh; background:#fff; border-radius:16px; box-shadow:0 20px 60px rgba(0,0,0,0.25); display:flex; flex-direction:column; overflow:hidden; }
  #modalHead { display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1px solid #eef1f4; }
  #modalHead .t { font-weight:800; font-size:16px; }
  #modalHead .s { color:#8a94a6; font-size:12px; }
  #modalHead .close { border:none; background:none; font-size:20px; cursor:pointer; color:#57606a; }
  #toolbar { display:flex; align-items:center; gap:6px; padding:8px 14px; border-bottom:1px solid #eef1f4; flex-wrap:wrap; }
  #toolbar button { background:#fff; color:#333; border:1px solid #e2e8f0; border-radius:8px; padding:6px 10px; cursor:pointer; font-size:12px; font-weight:600; }
  #toolbar button.active { background:#d41128; border-color:#d41128; color:#fff; }
  #toolbar .sep { width:1px; height:20px; background:#e2e8f0; margin:0 4px; }
  #pageIndicator { font-size:12px; color:#57606a; min-width:44px; text-align:center; }
  .swatch { width:18px; height:18px; border-radius:50%; border:2px solid transparent; cursor:pointer; padding:0; }
  .swatch.active { border-color:#0b1220; }
  #body { flex:1; display:flex; min-height:0; }
  #canvasWrap { flex:1; overflow:auto; background:#eef1f4; display:flex; justify-content:center; padding:20px; }
  #canvasInner { position:relative; height:fit-content; box-shadow:0 2px 16px rgba(0,0,0,0.15); background:#fff; }
  #pdfCanvas, #inkCanvas { position:absolute; top:0; left:0; }
  #inkCanvas { touch-action:none; }
  .page-badge { position:absolute; bottom:10px; right:10px; width:26px; height:26px; border-radius:50%; background:#d41128; color:#fff; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; }
  #side { width:320px; flex-shrink:0; border-left:1px solid #eef1f4; display:none; flex-direction:column; }
  #side.open { display:flex; }
  #side iframe { flex:1; border:none; }
  #notesPane { flex:1; display:flex; flex-direction:column; min-height:0; }
  #notesList { flex:1; overflow-y:auto; padding:12px; }
  .note { background:#f7f8fa; border-radius:8px; padding:8px 10px; margin-bottom:8px; font-size:13px; }
  .note .pg { font-size:11px; color:#8a94a6; margin-bottom:2px; }
  #noteForm { display:flex; gap:6px; padding:10px; border-top:1px solid #eef1f4; }
  #noteForm input { flex:1; border:1px solid #e2e8f0; border-radius:8px; padding:8px 10px; font-size:13px; }
  #noteForm button { border:none; background:#d41128; color:#fff; border-radius:8px; padding:0 14px; cursor:pointer; }
</style></head>
<body>
<div id="backdrop">
<div id="modal">
  <div id="modalHead">
    <div><div class="t">${escapeHtml(pdf.title)}</div><div class="s">Slides</div></div>
    <a class="close" href="${backHref}">&times;</a>
  </div>
  ${hasFile ? `
  <div id="toolbar">
    <button id="prevPage">&lsaquo;</button>
    <span id="pageIndicator">- / -</span>
    <button id="nextPage">&rsaquo;</button>
    <span class="sep"></span>
    <button id="tabNotes">Notes</button>
    <button id="tabAskAi" class="active">Ask AI</button>
    <span class="sep"></span>
    <button id="zoomOut">&minus;</button>
    <button id="zoomIn">+</button>
    <span class="sep"></span>
    <button id="modeHighlighter">Highlight</button>
    <button id="modeDraw" class="active">Draw</button>
    <button id="modeErase">Erase</button>
    <button id="addNoteBtn">Add Note</button>
    <span class="sep"></span>
    ${INK_COLORS.map((c, i) => `<button class="swatch ${i === 0 ? 'active' : ''}" data-color="${c}" style="background:${c};"></button>`).join('')}
    <span class="sep"></span>
    <button id="undoStroke">&#8634;</button>
    <button id="redoStroke">&#8635;</button>
  </div>
  <div id="body">
    <div id="canvasWrap"><div id="canvasInner"><canvas id="pdfCanvas"></canvas><canvas id="inkCanvas"></canvas><div class="page-badge" id="pageBadge">1</div></div></div>
    <div id="side" class="open">
      <iframe id="askaiFrame" src="/widget/${lectureId}"></iframe>
      <div id="notesPane" style="display:none;">
        <div id="notesList"></div>
        <div id="noteForm">
          <input id="noteText" placeholder="Add a note for this page...">
          <button id="saveNote">Save</button>
        </div>
      </div>
    </div>
  </div>
  ` : `<embed src="${pdf.moodle_url}" type="application/pdf" style="flex:1;border:none;">`}
</div>
</div>
<script>
  const PDF_ID = ${pdf.id};
  const LECTURE_ID = ${JSON.stringify(lectureId)};
  const HAS_FILE = ${hasFile ? 'true' : 'false'};
  let studentUserId = ${studentParam ? studentParam : 'null'};

  function loadNotes() {
    if (!studentUserId) return;
    fetch('/pdf/annotations?pdf_id=' + PDF_ID + '&student=' + studentUserId).then(r=>r.json()).then(function (data) {
      const list = document.getElementById('notesList');
      list.innerHTML = '';
      (data.annotations || []).forEach(function (n) {
        const div = document.createElement('div');
        div.className = 'note';
        div.innerHTML = '<div class="pg">Page ' + n.page + '</div>';
        const body = document.createElement('div');
        body.textContent = n.note;
        div.appendChild(body);
        list.appendChild(div);
      });
    });
  }
  if (document.getElementById('saveNote')) {
    document.getElementById('saveNote').addEventListener('click', function () {
      if (!studentUserId) return;
      const note = document.getElementById('noteText').value.trim();
      if (!note) return;
      fetch('/pdf/annotations', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ pdf_id: PDF_ID, student_userid: studentUserId, page: (typeof pageNum !== 'undefined' ? pageNum : 1), note }) })
        .then(function () { document.getElementById('noteText').value = ''; loadNotes(); });
    });
  }

  window.addEventListener('message', function (event) {
    if (event.data && event.data.type === 'identify' && event.data.userId) {
      studentUserId = event.data.userId;
      loadNotes();
      if (HAS_FILE && typeof pdfDoc !== 'undefined' && pdfDoc) loadStrokes();
    }
  });
  if (studentUserId) loadNotes();

  // ---- Notes / Ask AI toggle ----
  if (document.getElementById('tabNotes')) {
    const tabNotes = document.getElementById('tabNotes'), tabAi = document.getElementById('tabAskAi');
    const notesPane = document.getElementById('notesPane'), askaiFrame = document.getElementById('askaiFrame');
    tabNotes.addEventListener('click', function () {
      tabNotes.classList.add('active'); tabAi.classList.remove('active');
      notesPane.style.display = 'flex'; askaiFrame.style.display = 'none';
    });
    tabAi.addEventListener('click', function () {
      tabAi.classList.add('active'); tabNotes.classList.remove('active');
      askaiFrame.style.display = 'block'; notesPane.style.display = 'none';
      if (studentUserId && askaiFrame.contentWindow) askaiFrame.contentWindow.postMessage({type:'identify', userId: studentUserId}, '*');
    });
    askaiFrame.addEventListener('load', function () {
      if (studentUserId) askaiFrame.contentWindow.postMessage({type:'identify', userId: studentUserId}, '*');
    });
  }

  // ---- Ink annotations: PDF.js renders the page onto a canvas; a same-sized transparent
  // canvas on top captures freehand pen/highlighter strokes, stored as page-normalized points. ----
  if (HAS_FILE) {
    var pdfDoc = null, pageNum = 1, numPages = 0, zoomFactor = 1;
    var mode = 'draw', inkColor = ${JSON.stringify(INK_COLORS[0])}, inkWidth = 3;
    var drawing = false, currentPoints = [];
    var currentPageStrokes = [], redoStack = [];

    // Classic Workers can't be constructed from a cross-origin script URL (browsers throw
    // a SecurityError), and pdf.js doesn't surface that failure -- it just leaves the first
    // render() promise pending forever. Fetch the worker script ourselves and hand pdf.js a
    // same-origin blob: URL instead, which sidesteps the restriction entirely.
    fetch('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js')
      .then(function (r) { return r.text(); })
      .then(function (code) {
        var blob = new Blob([code], { type: 'application/javascript' });
        pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
        return pdfjsLib.getDocument('/pdf/' + PDF_ID + '/file').promise;
      })
      .then(function (doc) {
        pdfDoc = doc;
        numPages = doc.numPages;
        renderPage(1);
      })
      .catch(function (err) {
        document.getElementById('canvasWrap').innerHTML = '<p style="color:#8a94a6;padding:20px;">Could not load PDF for annotation: ' + err.message + '</p>';
      });

    function renderPage(n) {
      pageNum = Math.max(1, Math.min(numPages, n));
      redoStack = [];
      pdfDoc.getPage(pageNum).then(function (page) {
        var wrap = document.getElementById('canvasWrap');
        var unscaled = page.getViewport({ scale: 1 });
        var scale = Math.min((wrap.clientWidth - 40) / unscaled.width, 1.4) * zoomFactor;
        var viewport = page.getViewport({ scale: scale });
        var pdfCanvas = document.getElementById('pdfCanvas');
        var inkCanvas = document.getElementById('inkCanvas');
        var inner = document.getElementById('canvasInner');
        pdfCanvas.width = inkCanvas.width = viewport.width;
        pdfCanvas.height = inkCanvas.height = viewport.height;
        inner.style.width = viewport.width + 'px';
        inner.style.height = viewport.height + 'px';
        page.render({ canvasContext: pdfCanvas.getContext('2d'), viewport: viewport }).promise.then(function () {
          document.getElementById('pageIndicator').textContent = pageNum + ' / ' + numPages;
          document.getElementById('pageBadge').textContent = pageNum;
          if (studentUserId) loadStrokes(); else { currentPageStrokes = []; redrawAll(); }
        }).catch(function (err) {
          console.error('PDF render failed', err);
          document.getElementById('pageIndicator').textContent = 'Error';
        });
      }).catch(function (err) {
        console.error('PDF getPage failed', err);
      });
    }

    function loadStrokes() {
      fetch('/pdf/ink?pdf_id=' + PDF_ID + '&student=' + studentUserId + '&page=' + pageNum)
        .then(function (r) { return r.json(); })
        .then(function (data) {
          currentPageStrokes = data.strokes || [];
          redrawAll();
        });
    }

    function drawStroke(ctx, stroke, w, h) {
      ctx.save();
      ctx.globalAlpha = stroke.mode === 'highlighter' ? 0.35 : 1;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.mode === 'highlighter' ? stroke.width * 3 : stroke.width;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      stroke.points.forEach(function (p, i) {
        var x = p[0] * w, y = p[1] * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.restore();
    }

    function redrawAll() {
      var inkCanvas = document.getElementById('inkCanvas');
      var ctx = inkCanvas.getContext('2d');
      ctx.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
      currentPageStrokes.forEach(function (s) { drawStroke(ctx, s, inkCanvas.width, inkCanvas.height); });
    }

    document.getElementById('prevPage').addEventListener('click', function () { if (pageNum > 1) renderPage(pageNum - 1); });
    document.getElementById('nextPage').addEventListener('click', function () { if (pageNum < numPages) renderPage(pageNum + 1); });
    document.getElementById('zoomIn').addEventListener('click', function () { zoomFactor = Math.min(3, zoomFactor + 0.2); renderPage(pageNum); });
    document.getElementById('zoomOut').addEventListener('click', function () { zoomFactor = Math.max(0.4, zoomFactor - 0.2); renderPage(pageNum); });

    var modeButtons = { draw: document.getElementById('modeDraw'), highlighter: document.getElementById('modeHighlighter'), erase: document.getElementById('modeErase') };
    function setMode(m) {
      mode = m;
      Object.keys(modeButtons).forEach(function (k) { modeButtons[k].classList.toggle('active', k === m); });
      document.getElementById('inkCanvas').style.cursor = m === 'erase' ? 'crosshair' : (m === 'highlighter' ? 'cell' : 'crosshair');
    }
    modeButtons.draw.addEventListener('click', function () { setMode('draw'); });
    modeButtons.highlighter.addEventListener('click', function () { setMode('highlighter'); });
    modeButtons.erase.addEventListener('click', function () { setMode('erase'); });

    document.querySelectorAll('.swatch').forEach(function (btn) {
      btn.addEventListener('click', function () {
        inkColor = btn.dataset.color;
        document.querySelectorAll('.swatch').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
      });
    });

    document.getElementById('addNoteBtn').addEventListener('click', function () {
      document.getElementById('tabNotes').click();
      document.getElementById('noteText').focus();
    });

    document.getElementById('undoStroke').addEventListener('click', function () {
      var last = currentPageStrokes.pop();
      if (!last) return;
      redoStack.push(last);
      redrawAll();
      if (last.id) fetch('/pdf/ink/' + last.id, { method: 'DELETE' });
    });
    document.getElementById('redoStroke').addEventListener('click', function () {
      var stroke = redoStack.pop();
      if (!stroke || !studentUserId) return;
      fetch('/pdf/ink', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ pdf_id: PDF_ID, student_userid: studentUserId, page: pageNum, color: stroke.color, width: stroke.width, mode: stroke.mode, points: stroke.points }) })
        .then(function (r) { return r.json(); }).then(function (data) {
          stroke.id = data.id;
          currentPageStrokes.push(stroke);
          redrawAll();
        });
    });

    var inkCanvasEl = document.getElementById('inkCanvas');
    function addPoint(e) {
      var rect = inkCanvasEl.getBoundingClientRect();
      currentPoints.push([(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height]);
    }
    function eraseNear(nx, ny) {
      var w = inkCanvasEl.width, h = inkCanvasEl.height;
      var threshold = 14;
      for (var i = currentPageStrokes.length - 1; i >= 0; i--) {
        var s = currentPageStrokes[i];
        var hit = s.points.some(function (p) {
          var dx = p[0] * w - nx * w, dy = p[1] * h - ny * h;
          return Math.sqrt(dx * dx + dy * dy) < threshold;
        });
        if (hit) {
          currentPageStrokes.splice(i, 1);
          redrawAll();
          if (s.id) fetch('/pdf/ink/' + s.id, { method: 'DELETE' });
          break;
        }
      }
    }
    inkCanvasEl.addEventListener('pointerdown', function (e) {
      drawing = true;
      currentPoints = [];
      addPoint(e);
      if (mode === 'erase') {
        var last = currentPoints[currentPoints.length - 1];
        eraseNear(last[0], last[1]);
      }
    });
    inkCanvasEl.addEventListener('pointermove', function (e) {
      if (!drawing) return;
      addPoint(e);
      if (mode === 'erase') {
        var last = currentPoints[currentPoints.length - 1];
        eraseNear(last[0], last[1]);
        return;
      }
      var ctx = inkCanvasEl.getContext('2d');
      redrawAll();
      drawStroke(ctx, { color: inkColor, width: inkWidth, mode: mode, points: currentPoints }, inkCanvasEl.width, inkCanvasEl.height);
    });
    window.addEventListener('pointerup', function () {
      if (!drawing) return;
      drawing = false;
      if (mode !== 'erase' && currentPoints.length >= 2 && studentUserId) {
        var strokeObj = { color: inkColor, width: inkWidth, mode: mode, points: currentPoints.slice() };
        fetch('/pdf/ink', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pdf_id: PDF_ID, student_userid: studentUserId, page: pageNum, color: inkColor, width: inkWidth, mode: mode, points: strokeObj.points }),
        }).then(function (r) { return r.json(); }).then(function (data) {
          strokeObj.id = data.id;
          currentPageStrokes.push(strokeObj);
        });
      }
      currentPoints = [];
    });
  }
</script>
</body></html>`);
});

// The four learning journeys from HTU's proposal split along two independent axes:
// Contextual Ask / Course Ask decide WHICH content grounds the answer (handled above by
// lecture-scoped vs course-wide retrieval); Guide Me / Check Me decide HOW the AI responds
// to that same grounded content. mode is orthogonal to lecture_id/position, so it layers
// on cleanly here rather than needing separate endpoints.
//
// Guide Mode's give-up threshold used to be hardcoded in the prompt text itself -- every
// course got the same policy with no way for an instructor to say "never give the direct
// answer" (e.g. for a graded skill) or "give it up sooner" (e.g. for a quick warm-up
// concept). GUIDE_MODE_DEFAULTS + getGuideModePolicy() make that instructor-configurable,
// per HTU's proposal ("instructor-configurable direct-answer policy").
const GUIDE_MODE_DEFAULTS = { neverDirectAnswer: false, attemptsBeforeDirect: 3 };
function getGuideModePolicy() {
  const neverDirectAnswer = getCourseSetting('guide_never_direct_answer', '0') === '1';
  const attemptsBeforeDirectRaw = parseInt(getCourseSetting('guide_attempts_before_direct', String(GUIDE_MODE_DEFAULTS.attemptsBeforeDirect)), 10);
  const attemptsBeforeDirect = Number.isFinite(attemptsBeforeDirectRaw) && attemptsBeforeDirectRaw > 0 ? attemptsBeforeDirectRaw : GUIDE_MODE_DEFAULTS.attemptsBeforeDirect;
  return { neverDirectAnswer, attemptsBeforeDirect };
}

function buildJourneyModeInstruction(mode) {
  if (mode === 'guide') {
    const { neverDirectAnswer, attemptsBeforeDirect } = getGuideModePolicy();
    return `You are in GUIDE MODE. Do not give the student the direct answer, even if they ask for it directly. ` +
      `Instead, ask ONE leading question, offer a hint, or break the idea into a smaller first step that helps ` +
      `them reason toward the answer themselves. Keep it to 2-4 sentences. ` +
      (neverDirectAnswer
        ? `Never give the full direct answer under any circumstances, even if the student says they give up -- ` +
          `instead, narrow the hint further or restate the smaller first step more explicitly. This course's ` +
          `instructor has set this topic to guided-only.\n\n`
        : `Only give the full answer if the conversation history shows they've made a genuine attempt across at ` +
          `least ${attemptsBeforeDirect} exchanges and are still stuck, or if they explicitly say they give up.\n\n`);
  }
  if (mode === 'check') {
    return `You are in CHECK MODE, a comprehension check -- not a Q&A assistant. ` +
      `Look at the conversation history: if you have not yet posed a check question in this conversation, ` +
      `write ONE question that tests whether the student understood the excerpt below (not a yes/no question -- ` +
      `something that requires them to explain or apply the idea), and do NOT answer it yourself. ` +
      `If the student HAS already answered a question you posed, evaluate their answer against the excerpt: ` +
      `say clearly whether they understood it, correct any specific misconception, and briefly reinforce what ` +
      `they got right. Keep it conversational, one check at a time, 2-5 sentences.\n\n`;
  }
  return '';
}
// Kept as a plain lookup for any remaining call sites -- ask/guide/check keys resolve
// through the same function so behavior stays identical, just no longer hardcoded per mode.
const JOURNEY_MODE_INSTRUCTIONS = new Proxy({}, { get: (_, mode) => buildJourneyModeInstruction(String(mode)) });

app.post('/chat', async (req, res) => {
  const requestStartedAt = Date.now();
  const activeConfigForLogging = getActiveModelConfig(req.body.student_userid);
  try {
    const { lecture_id, message, history, student_userid, position, mode } = req.body;
    if (!lecture_id || !message) {
      return res.status(400).json({ error: 'lecture_id and message are required' });
    }

    const lecture = db.prepare('SELECT * FROM lectures WHERE lecture_id = ?').get(lecture_id);
    if (!lecture) {
      return res.status(404).json({ error: 'Unknown lecture_id. Ingest it first.' });
    }

    if (student_userid) {
      const rl = checkAndRecordRateLimit(db, student_userid);
      if (!rl.allowed) return res.status(429).json({ error: rl.reason });
    }

    const language = detectLanguage(message);
    const languageName = language === 'ar' ? 'Arabic' : 'English';

    const rows = db.prepare('SELECT text, embedding, start_time, end_time FROM chunks WHERE lecture_id = ?').all(lecture_id);
    const queryEmbedding = await embed(message);

    // "Contextual Ask": an explicit time named in the question text always wins ("what
    // happened at minute 8" while paused at minute 2 means minute 8). Otherwise, fall back
    // to the player's live position -- this is what makes "what does this mean?" work
    // without the student ever typing a timestamp.
    const requestedTime = extractRequestedTime(message);
    const usedLivePosition = requestedTime === null && typeof position === 'number' && isFinite(position);
    const effectiveTime = requestedTime !== null ? requestedTime : (usedLivePosition ? position : null);
    let timeMatch = null;
    if (effectiveTime !== null) {
      // Find the chunk whose [start, end] range covers the requested time; if none covers
      // it exactly, fall back to the chunk whose midpoint is closest.
      const withTimes = rows.filter((r) => r.start_time !== null && r.start_time !== undefined);
      // Chunk boundaries are contiguous (one chunk's end == the next one's start), so
      // treat the upper bound as exclusive to avoid two adjacent chunks both "covering"
      // the exact boundary second -- otherwise array order silently decides the winner.
      const covering = withTimes.find((r) => effectiveTime >= r.start_time && effectiveTime < r.end_time)
        || withTimes.find((r) => effectiveTime >= r.start_time && effectiveTime <= r.end_time);
      const closest = withTimes.length
        ? withTimes.reduce((best, r) => {
            const mid = (r.start_time + r.end_time) / 2;
            const bestMid = (best.start_time + best.end_time) / 2;
            return Math.abs(mid - effectiveTime) < Math.abs(bestMid - effectiveTime) ? r : best;
          })
        : null;
      const picked = covering || closest;
      if (picked) {
        timeMatch = { text: picked.text, start: picked.start_time, end: picked.end_time, score: 1 };
      }
    }

    const scored = rows
      .map((row) => ({
        text: row.text,
        start: row.start_time,
        end: row.end_time,
        score: cosineSimilarity(queryEmbedding, JSON.parse(row.embedding)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, timeMatch ? TOP_K - 1 : TOP_K);

    if (timeMatch && !scored.some((c) => c.text === timeMatch.text)) {
      scored.unshift(timeMatch);
    }

    const hasTimestamps = scored.some((c) => c.start !== null && c.start !== undefined);

    const context = scored
      .map((c, i) => {
        const isCurrentPosition = usedLivePosition && timeMatch && c.text === timeMatch.text;
        const label =
          c.start !== null && c.start !== undefined
            ? `[Excerpt ${i + 1}, ${formatTimestamp(c.start)}–${formatTimestamp(c.end)}${isCurrentPosition ? ' — WHERE THE STUDENT CURRENTLY IS' : ''}]`
            : `[Excerpt ${i + 1}]`;
        return `${label}\n${c.text}`;
      })
      .join('\n\n');

    const systemPrompt =
      `You are a course tutor bot for the lecture "${lecture.title}". ` +
      `Answer the student's question using ONLY the lecture excerpts below. ` +
      `The lecture material may be in Arabic even though the student's question is in ${languageName}. ` +
      `The student's question is written in ${languageName}. You MUST reply in ${languageName}, regardless of what language the excerpts are in. ` +
      (hasTimestamps
        ? `Each excerpt is labeled with the timestamp range (minutes:seconds) it was spoken at in the video. ` +
          `When the student asks about a specific time or "what happened at/around minute X", find the excerpt ` +
          `whose timestamp range covers that time and answer from it, citing the timestamp. ` +
          `If no excerpt covers the requested time, say so. ` +
          (usedLivePosition
            ? `The student did not name a specific time -- one excerpt is marked "WHERE THE STUDENT CURRENTLY IS" ` +
              `because that's their live position in the video. If their question is vague or clearly about ` +
              `"this"/"that"/what's on screen right now, ground your answer in that excerpt and cite its timestamp. ` +
              `If the question is clearly about something else, answer that instead.\n\n`
            : `\n\n`)
        : ``) +
      `Mention the timestamp naturally in your answer's own language (e.g. citing "2:15" or its Arabic ` +
      `equivalent is fine either way). ` +
      `If the excerpts don't contain the answer, say you don't have that information in this lecture, ` +
      `don't make anything up.\n\n` +
      (JOURNEY_MODE_INSTRUCTIONS[mode] || '') +
      context +
      (hasTimestamps
        ? `\n\nAfter your full answer, on its own new line, output exactly this marker with the RAW SECOND ` +
          `values (not minutes:seconds) of the excerpt range you grounded your answer in, e.g. [[CITE:135-289]]. ` +
          `Use this literal format always, in English, never translated or described -- it will be stripped ` +
          `before the student sees your reply, so it doesn't need to read naturally.`
        : '');

    const messages = [{ role: 'system', content: systemPrompt }];
    if (Array.isArray(history)) {
      for (const turn of history.slice(-6)) {
        if (turn.role === 'user' || turn.role === 'assistant') {
          messages.push({ role: turn.role, content: String(turn.content).slice(0, 2000) });
        }
      }
    }
    messages.push({ role: 'user', content: message });

    const completion = await chatCompletionWithResilience({
      model: CHAT_MODEL,
      messages,
      temperature: 0.3,
    });

    const rawReply = completion.choices[0].message.content;

    // Structured citation so the client can render a real clickable "jump to 2:15" link --
    // the exact video location backing the answer, per HTU's requirement to reference
    // where in the video a response comes from. Prefer what the model itself cited (single
    // source of truth, guaranteed to match the prose) via the [[CITE:start-end]] marker;
    // only fall back to a guess from the retrieved chunks if the model omitted it. The
    // marker itself is always stripped before the student sees the reply.
    const { citation: parsedCitation, cleanReply } = parseTimestampCitation(rawReply);
    const citedChunk = timeMatch || scored[0];
    const fallbackCitation = (citedChunk && citedChunk.start !== null && citedChunk.start !== undefined)
      ? { start: citedChunk.start, end: citedChunk.end }
      : null;
    const citation = parsedCitation || fallbackCitation;
    const reply = cleanReply;

    const latencyMs = Date.now() - requestStartedAt;
    const citationValid = hasTimestamps ? Boolean(parsedCitation) : null;

    // The actual retrieval confidence (top chunk's cosine similarity) and the citation's
    // real values were computed above and used to build the answer, but previously
    // discarded after the response was sent -- only a citationValid boolean survived.
    // Per HTU's evaluation requirement, every response needs structured, traceable source
    // metadata (not just "did it cite something"), so both are now persisted.
    const retrievalConfidence = scored.length ? Math.round(scored[0].score * 1000) / 1000 : null;

    let eventId = null;
    if (student_userid) {
      const info = db.prepare(
        'INSERT INTO events (lecture_id, student_userid, event_type, position, duration, payload, created_at) ' +
        'VALUES (?, ?, ?, NULL, NULL, ?, ?)'
      ).run(lecture_id, student_userid, 'chat_message', JSON.stringify({
        question: message,
        answer: reply,
        latencyMs,
        model_config_id: activeConfigForLogging.id,
        mode: mode || 'ask',
        language,
        citationValid,
        // Same lecture_id-prefix categorization already used to bucket "AI interactions by
        // bot" elsewhere (chatByCategory) -- kept consistent rather than inventing a second
        // classification scheme.
        contentType: lecture_id.startsWith('pdf-') ? 'pdf' : lecture_id.startsWith('assignment-') ? 'assignment' : 'video',
        citation,
        retrievalConfidence,
      }), Date.now());
      eventId = info.lastInsertRowid;
    }

    res.json({ reply, citation, event_id: eventId });
  } catch (err) {
    console.error(err);
    logAiError('/chat', err, { modelConfigId: activeConfigForLogging.id, studentUserid: req.body.student_userid });
    if (err.name === 'AbortError') return res.status(504).json({ error: 'The AI tutor took too long to respond. Please try again.' });
    res.status(500).json({ error: 'The AI tutor is temporarily unavailable. Please try again shortly.' });
  }
});

// ---- Course-wide Tutor Bot (grounded in course guidelines + material index, not one lecture) ----

const DEFAULT_COURSE_GUIDELINES = `A single communication channel is used for all students and instructors. Learning materials are released weekly. Each module includes pre-recorded lectures and accompanying reading materials. Students are expected to review materials before each practical session. A short knowledge-check quiz is available at the end of each module.`;

// Content tab (guidelines + per-chapter visibility/due-date) and Attendance
// tab (engagement policy) settings. Simple key-value store rather than one
// column per setting -- these are instructor-edited, low-write-frequency
// values, not something queried in a hot path.
db.exec(`
  CREATE TABLE IF NOT EXISTS course_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chapter_settings (
    key TEXT PRIMARY KEY,
    due_date INTEGER,
    visible INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS tutor_knowledge_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content_text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
function getCourseSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM course_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setCourseSetting(key, value) {
  db.prepare(
    'INSERT INTO course_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}
function getCourseGuidelines() {
  return getCourseSetting('guidelines_markdown', DEFAULT_COURSE_GUIDELINES);
}
if (db.prepare('SELECT COUNT(*) as c FROM course_settings').get().c === 0) {
  // HTU's real written policy (from the course guidelines text itself):
  // engagement-based attendance is already the intended mechanism, so it
  // defaults on rather than requiring an instructor to discover a toggle.
  setCourseSetting('engagement_attendance_enabled', '1');
  setCourseSetting('engagement_watch_threshold_percent', '70');
  setCourseSetting('max_absences_allowed', '5');
}

// ---- Multi-tenant database resolution ----
// Every schema/migration statement above has now run against the one real
// connection (HTU's), so its file on disk is a known-good, fully-migrated
// template. Each tenant after this point gets its own completely separate
// SQLite file -- not a shared table with a tenant_id column -- so one
// tenant's data can never leak into another's through a missed WHERE
// clause; the isolation is structural, not query-dependent. New tenants are
// created by cloning HTU's already-migrated file and wiping every row, so
// the table structure built by the migrations above never has to be
// duplicated or hand-maintained in a second place.
const TENANTS_DIR = path.join(path.dirname(DB_PATH), 'tenants');
const tenantConnections = new Map([[DEFAULT_TENANT, db]]);

function wipeAndCloneSchema(destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  // WAL mode keeps recent writes (including schema migrations run earlier
  // in this same startup) in a separate -wal file rather than the main .db
  // file on disk -- a raw copy of just the .db file can silently miss them.
  // Checkpointing folds the WAL back into the main file first so the copy
  // is a complete, self-contained snapshot.
  tenantConnections.get(DEFAULT_TENANT).pragma('wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(DB_PATH, destPath);
  const cloned = new Database(destPath);
  cloned.pragma('journal_mode = WAL');
  const tables = cloned.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const wipe = cloned.transaction(() => {
    for (const t of tables) cloned.exec(`DELETE FROM "${t.name}"`);
    cloned.exec('DELETE FROM sqlite_sequence');
  });
  wipe();
  return cloned;
}

function getTenantDb(slug) {
  const existing = tenantConnections.get(slug);
  if (existing) return existing;
  const destPath = path.join(TENANTS_DIR, slug, 'tutor.db');
  let instance;
  if (fs.existsSync(destPath)) {
    instance = new Database(destPath);
    instance.pragma('journal_mode = WAL');
  } else {
    instance = wipeAndCloneSchema(destPath);
  }
  tenantConnections.set(slug, instance);
  return instance;
}

// Every db.prepare/exec/transaction call in every route below (and above,
// once this assignment has happened) keeps working completely unchanged --
// this Proxy transparently resolves to whichever tenant's connection is
// active for the current request, via the AsyncLocalStorage context the
// very first middleware established.
db = new Proxy({}, {
  get(target, prop) {
    const slug = tenantContext.getStore()?.tenant || DEFAULT_TENANT;
    const real = getTenantDb(slug);
    const value = real[prop];
    return typeof value === 'function' ? value.bind(real) : value;
  },
});

// ---- Usage-based billing: the data a future Stripe integration would meter
// against, not Stripe itself (no account exists yet to connect to). Billed
// quantity is "students" (excludes instructor/supervisor rows) per tenant,
// per the chosen monthly-per-student model -- read this report and report
// quantities via Stripe's subscription-item usage API once billing is
// actually wired up; nothing here processes a payment or talks to Stripe.
function listKnownTenants() {
  const slugs = new Set([DEFAULT_TENANT]);
  try {
    for (const entry of fs.readdirSync(TENANTS_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) slugs.add(entry.name);
    }
  } catch (e) { /* TENANTS_DIR doesn't exist yet if no tenant has ever been created -- fine */ }
  return [...slugs];
}

function getTenantUsage(slug) {
  const tdb = getTenantDb(slug);
  const students = tdb.prepare(
    "SELECT COUNT(*) AS c FROM students WHERE role IS NULL OR role NOT IN ('course_supervisor', 'section_instructor')"
  ).get().c;
  const instructors = tdb.prepare(
    "SELECT COUNT(*) AS c FROM students WHERE role IN ('course_supervisor', 'section_instructor')"
  ).get().c;
  return { tenant: slug, billableStudents: students, instructors };
}

app.get('/admin/tenant-usage', requireTenantAdmin, (req, res) => {
  const tenant = String(req.query.tenant || '').toLowerCase();
  if (!tenant || !TENANT_SLUG_RE.test(tenant)) {
    return res.status(400).json({ error: 'tenant is required.' });
  }
  res.json(getTenantUsage(tenant));
});

// One-call monthly reconciliation report across every known tenant -- what
// you'd read before generating invoices by hand, or before this eventually
// feeds a Stripe usage-record push per tenant.
app.get('/admin/usage-report', requireTenantAdmin, (req, res) => {
  const rows = listKnownTenants().map((slug) => {
    try {
      return getTenantUsage(slug);
    } catch (e) {
      return { tenant: slug, error: e.message };
    }
  });
  res.json(rows);
});

app.get('/admin/billing', requireTenantAdmin, (req, res) => {
  const rows = listKnownTenants().map((slug) => {
    try {
      return getTenantUsage(slug);
    } catch (e) {
      return { tenant: slug, error: e.message };
    }
  });
  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Billing usage</title>
<style>
  ${APP_SHELL_STYLES}
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:10px 14px; border-bottom:1px solid #eef1f4; font-size:13px; }
  th { color:#57606a; font-weight:700; font-size:12px; text-transform:uppercase; }
</style></head>
<body>
<div class="app-topbar"></div>
<div class="app-main">
  <div class="app-h1">Billing usage</div>
  <p class="app-sub">Billable quantity per tenant is student count (instructors excluded) -- the number a monthly per-student charge would be based on. Nothing here talks to Stripe yet.</p>
  <div class="app-card" style="padding:0;">
    <table>
      <tr><th>Tenant</th><th>Billable students</th><th>Instructors</th></tr>
      ${rows.map((r) => `<tr><td>${escapeHtml(r.tenant)}</td><td>${r.error ? '&mdash;' : r.billableStudents}</td><td>${r.error ? escapeHtml(r.error) : r.instructors}</td></tr>`).join('')}
    </table>
  </div>
  <p class="app-sub" style="margin-top:16px;">JSON: <a href="/admin/usage-report">/admin/usage-report</a> &middot; single tenant: <a href="/admin/tenant-usage?tenant=htu">/admin/tenant-usage?tenant=...</a></p>
</div>
</body></html>`);
});

function getChapterSetting(key) {
  return db.prepare('SELECT * FROM chapter_settings WHERE key = ?').get(key) || { key, due_date: null, visible: 1 };
}

// ---- Weaviate-backed RAG chat (new pipeline, separate from /chat and /chat/course above
// which still use the SQLite chunks table). Kept as new endpoints rather than replacing
// /chat/course in place, since embedForRag() hard-fails until BGE-M3 is actually deployed
// -- cutting the live endpoint over is a deliberate later step, not a side effect of this.

app.post('/rag/chat/course', async (req, res) => {
  const requestStartedAt = Date.now();
  try {
    const { message, course_id, student_userid } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });
    const courseId = course_id || DEFAULT_COURSE_ID;
    const tenant = tenantContext.getStore()?.tenant || DEFAULT_TENANT;

    if (student_userid) {
      const rl = checkAndRecordRateLimit(db, student_userid);
      if (!rl.allowed) return res.status(429).json({ error: rl.reason });
    }

    const chunks = await hybridSearchCourse(tenant, courseId, message, 20);
    const top = await rerankChunks(message, chunks, 5);

    const messages = buildRagPrompt(courseId, message, top);
    const completion = await chatCompletionWithResilience({ messages, temperature: 0.3 }, 1, student_userid);
    const answer = completion.choices[0].message.content;

    if (student_userid) {
      db.prepare(
        "INSERT INTO events (lecture_id, student_userid, event_type, position, duration, payload, created_at) VALUES ('course', ?, 'chat_message', NULL, NULL, ?, ?)"
      ).run(student_userid, JSON.stringify({
        question: message, answer, latencyMs: Date.now() - requestStartedAt,
        model_config_id: getActiveModelConfig(student_userid).id, mode: 'rag_course',
      }), Date.now());
    }

    res.json({ answer, sources: formatStructuredCitations(top) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'RAG pipeline error' });
  }
});

app.post('/rag/chat/contextual', async (req, res) => {
  const requestStartedAt = Date.now();
  try {
    const { message, course_id, video_id, position, student_userid } = req.body;
    if (!message || !video_id) return res.status(400).json({ error: 'message and video_id are required' });
    const courseId = course_id || DEFAULT_COURSE_ID;
    const tenant = tenantContext.getStore()?.tenant || DEFAULT_TENANT;

    if (student_userid) {
      const rl = checkAndRecordRateLimit(db, student_userid);
      if (!rl.allowed) return res.status(429).json({ error: rl.reason });
    }

    const [local, semantic] = await Promise.all([
      typeof position === 'number' ? retrieveTimestampWindow(tenant, courseId, video_id, position) : Promise.resolve([]),
      hybridSearchCourse(tenant, courseId, message, 20),
    ]);
    const merged = mergeRetrievalBranches(local, semantic, 8);
    const top = await rerankChunks(message, merged, 5);

    const messages = buildRagPrompt(courseId, message, top);
    const completion = await chatCompletionWithResilience({ messages, temperature: 0.3 }, 1, student_userid);
    const answer = completion.choices[0].message.content;

    if (student_userid) {
      db.prepare(
        "INSERT INTO events (lecture_id, student_userid, event_type, position, duration, payload, created_at) VALUES (?, ?, 'chat_message', ?, NULL, ?, ?)"
      ).run(video_id, student_userid, position ?? null, JSON.stringify({
        question: message, answer, latencyMs: Date.now() - requestStartedAt,
        model_config_id: getActiveModelConfig(student_userid).id, mode: 'rag_contextual',
        local_hits: local.length, semantic_hits: semantic.length,
      }), Date.now());
    }

    res.json({ answer, sources: formatStructuredCitations(top) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'RAG pipeline error' });
  }
});

app.post('/chat/course', async (req, res) => {
  const requestStartedAt = Date.now();
  const activeConfigForLogging = getActiveModelConfig(req.body.student_userid);
  try {
    const { message, student_userid, history, mode } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    if (student_userid) {
      const rl = checkAndRecordRateLimit(db, student_userid);
      if (!rl.allowed) return res.status(429).json({ error: rl.reason });
    }

    const language = detectLanguage(message);
    const languageName = language === 'ar' ? 'Arabic' : 'English';

    const lectures = db.prepare('SELECT * FROM lectures').all()
      .sort((a, b) => lectureSortKey(a.lecture_id) - lectureSortKey(b.lecture_id));
    const materialIndex = lectures.map((l) => `- ${l.title}`).join('\n');
    const knowledgeSources = db.prepare('SELECT title, content_text FROM tutor_knowledge_sources ORDER BY created_at DESC').all();
    const knowledgeText = knowledgeSources.length
      ? knowledgeSources.map((s) => `### ${s.title}\n${s.content_text}`).join('\n\n').slice(0, 12000)
      : '';
    const tutorGuidance = getCourseSetting('tutor_bot_guidance', '');

    const systemPrompt = `You are the AI tutor for ${getBranding().courseFull}.

You are a formative learning aid, not an answer key. Ground every factual answer in the course guidelines, the additional knowledge base, or material index below; if a question needs specific lecture content, tell the student which lecture to open so the lecture-scoped Ask AI (which has the transcript) can help.

Course guidelines:
${getCourseGuidelines()}
${knowledgeText ? `\nAdditional knowledge base (instructor-provided):\n${knowledgeText}\n` : ''}
${tutorGuidance ? `\nInstructor guidance on how you should behave (does not override the rules below):\n${tutorGuidance}\n` : ''}
Course material index (titles only; not evidence):
${materialIndex}

Rules:
- Never answer a factual question from your own general/outside training knowledge. If the guidelines and material index don't cover it, say so honestly.
- Keep answers concise.
- Never write a student's assignment submission for them — explain concepts, don't produce final answers to graded work.
- Respond ONLY in the language of the student's most recent message.

${JOURNEY_MODE_INSTRUCTIONS[mode] || ''}`;

    const messages = [{ role: 'system', content: systemPrompt }];
    if (Array.isArray(history)) {
      for (const turn of history.slice(-6)) {
        if (turn.role === 'user' || turn.role === 'assistant') {
          messages.push({ role: turn.role, content: String(turn.content).slice(0, 2000) });
        }
      }
    }
    messages.push({ role: 'user', content: message });

    const completion = await chatCompletionWithResilience({ model: CHAT_MODEL, messages, temperature: 0.3 });
    const reply = completion.choices[0].message.content;

    const latencyMs = Date.now() - requestStartedAt;

    let eventId = null;
    if (student_userid) {
      const info = db.prepare(
        "INSERT INTO events (lecture_id, student_userid, event_type, position, duration, payload, created_at) VALUES ('course', ?, 'chat_message', NULL, NULL, ?, ?)"
      ).run(student_userid, JSON.stringify({
        question: message,
        answer: reply,
        latencyMs,
        model_config_id: activeConfigForLogging.id,
        mode: mode || 'ask',
        language,
        contentType: 'course',
      }), Date.now());
      eventId = info.lastInsertRowid;
    }

    res.json({ reply, event_id: eventId });
  } catch (err) {
    console.error(err);
    logAiError('/chat/course', err, { modelConfigId: activeConfigForLogging.id, studentUserid: req.body.student_userid });
    if (err.name === 'AbortError') return res.status(504).json({ error: 'The AI tutor took too long to respond. Please try again.' });
    res.status(500).json({ error: 'The AI tutor is temporarily unavailable. Please try again shortly.' });
  }
});

app.post('/feedback', (req, res) => {
  try {
    const { event_id, student_userid, rating } = req.body;
    if (!event_id || !student_userid || (rating !== 'up' && rating !== 'down')) {
      return res.status(400).json({ error: 'event_id, student_userid, and rating ("up" or "down") are required' });
    }
    db.prepare(
      'INSERT INTO chat_feedback (chat_event_id, student_userid, rating, created_at) VALUES (?, ?, ?, ?)'
    ).run(event_id, student_userid, rating, Date.now());
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save feedback.' });
  }
});

// ---- Formative Bot (assignment-brief-grounded, with a stuck-student escalation classifier) ----

app.post('/chat/formative', async (req, res) => {
  try {
    const { assignment_id, message, student_userid, history } = req.body;
    if (!assignment_id || !message) return res.status(400).json({ error: 'assignment_id and message are required' });

    const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(assignment_id);
    if (!assignment) return res.status(404).json({ error: 'Unknown assignment_id' });

    if (student_userid) {
      const rl = checkAndRecordRateLimit(db, student_userid);
      if (!rl.allowed) return res.status(429).json({ error: rl.reason });
    }

    const languageName = detectLanguage(message) === 'ar' ? 'Arabic' : 'English';

    const systemPrompt = `You are the Formative Bot for the assignment "${assignment.title}". Students ask you questions about this assignment and you try to help them understand what's expected.

Assignment brief:
${assignment.brief_markdown}

Answer clearly and specifically using the brief above. If a question is genuinely outside what you can determine from the brief — e.g. asking for feedback on their own submitted work (which you don't have access to), or something that needs the instructor's personal judgment call — say so plainly rather than guessing. You are not a substitute for the instructor.

The student's message is written in ${languageName}. You MUST respond in ${languageName}.`;

    const messages = [{ role: 'system', content: systemPrompt }];
    if (Array.isArray(history)) {
      for (const turn of history.slice(-6)) {
        if (turn.role === 'user' || turn.role === 'assistant') {
          messages.push({ role: turn.role, content: String(turn.content).slice(0, 2000) });
        }
      }
    }
    messages.push({ role: 'user', content: message });

    const completion = await chatCompletionWithResilience({ model: CHAT_MODEL, messages, temperature: 0.3 });
    const reply = completion.choices[0].message.content;

    // Second call: classify whether the answer likely resolved the question (Criterio's escalation path).
    let resolved = true;
    let report = '';
    try {
      const checkPrompt = `A student asked a Formative Bot a question about their assignment. Judge whether the bot's answer likely resolved the student's question, or whether the student probably still needs help from their instructor.

Question: ${message}

Bot's answer: ${reply}

Respond with STRICT JSON only, no markdown fences, no commentary, matching exactly this shape:
{"resolved": boolean, "report": string}

"report" is a one-sentence, factual summary of what the student is stuck on, written for the instructor. Only fill it in if resolved is false — otherwise use an empty string.`;
      const checkCompletion = await chatCompletionWithResilience({
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: checkPrompt }],
        temperature: 0,
      });
      const parsed = JSON.parse(checkCompletion.choices[0].message.content.replace(/```json|```/g, '').trim());
      resolved = !!parsed.resolved;
      report = parsed.report || '';
    } catch (e) { /* fail-soft: treat as resolved if the classifier call/parse fails */ }

    if (student_userid) {
      db.prepare(
        'INSERT INTO formative_escalations (assignment_id, student_userid, question, answer, report, resolved, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(assignment_id, student_userid, message, reply, report, resolved ? 1 : 0, Date.now());
    }

    res.json({ reply, resolved });
  } catch (err) {
    console.error(err);
    if (err.name === 'AbortError') return res.status(504).json({ error: 'The AI tutor took too long to respond. Please try again.' });
    res.status(500).json({ error: 'The AI tutor is temporarily unavailable. Please try again shortly.' });
  }
});

// ---- Assignment Assistant (brief + rubric + the student's OWN draft) ----

app.post('/chat/assistant', async (req, res) => {
  const requestStartedAt = Date.now();
  const activeConfigForLogging = getActiveModelConfig(req.body.student_userid);
  try {
    const { assignment_id, message, student_userid, history } = req.body;
    if (!assignment_id || !message || !student_userid) {
      return res.status(400).json({ error: 'assignment_id, message and student_userid are required' });
    }

    const rl = checkAndRecordRateLimit(db, student_userid);
    if (!rl.allowed) return res.status(429).json({ error: rl.reason });

    const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(assignment_id);
    if (!assignment) return res.status(404).json({ error: 'Unknown assignment_id' });
    const draft = db.prepare('SELECT * FROM assignment_drafts WHERE assignment_id = ? AND student_userid = ?').get(assignment_id, student_userid);
    const language = detectLanguage(message);
    const languageName = language === 'ar' ? 'Arabic' : 'English';

    const systemPrompt = `You are a formative learning assistant for university students.

Assignment brief:
${assignment.brief_markdown}

Rubric:
${assignment.rubric_json || '(no rubric provided)'}

The student's current draft:
${draft?.content ? stripHtml(draft.content) : '(no draft written yet)'}

Rules:
- Respond to the student's own draft and questions.
- Help them understand the criteria, not write the final answer.
- Validate their draft against the rubric and point out gaps.
- When explaining a higher-level answer, describe the quality without providing a copy-paste paragraph.
- Be concise and actionable.
- The student's message is written in ${languageName}. You MUST respond in ${languageName}.`;

    const messages = [{ role: 'system', content: systemPrompt }];
    if (Array.isArray(history)) {
      for (const turn of history.slice(-6)) {
        if (turn.role === 'user' || turn.role === 'assistant') {
          messages.push({ role: turn.role, content: String(turn.content).slice(0, 2000) });
        }
      }
    }
    messages.push({ role: 'user', content: message });

    const completion = await chatCompletionWithResilience({ model: CHAT_MODEL, messages, temperature: 0.3 });
    const reply = completion.choices[0].message.content;

    db.prepare(
      "INSERT INTO events (lecture_id, student_userid, event_type, position, duration, payload, created_at) VALUES (?, ?, 'chat_message', NULL, NULL, ?, ?)"
    ).run(`assignment-${assignment_id}`, student_userid, JSON.stringify({
      question: message,
      answer: reply,
      latencyMs: Date.now() - requestStartedAt,
      model_config_id: activeConfigForLogging.id,
      language,
      contentType: 'assignment',
    }), Date.now());

    res.json({ reply });
  } catch (err) {
    console.error(err);
    logAiError('/chat/assistant', err, { modelConfigId: activeConfigForLogging.id, studentUserid: req.body.student_userid });
    if (err.name === 'AbortError') return res.status(504).json({ error: 'The AI tutor took too long to respond. Please try again.' });
    res.status(500).json({ error: 'The AI tutor is temporarily unavailable. Please try again shortly.' });
  }
});

function lectureSortKey(lectureId) {
  const m = lectureId.match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Drafts are stored as the rich editor's HTML; AI grounding prompts need plain text.
function stripHtml(html) {
  return String(html)
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Cross-week ordering (lectureSortKey only orders *within* a week/section).
// PDFs are early Week 4 material, so they sort just before the Week 4 videos.
function globalLectureSortKey(lectureId) {
  const m = lectureId.match(/^week(\d+)-video(\d+)$/);
  if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  const p = lectureId.match(/^pdf-(\d+)$/);
  if (p) return [4, -1000 + parseInt(p[1], 10)];
  return [999, 0];
}
function compareGlobalLectureOrder(a, b) {
  const ka = globalLectureSortKey(a.lecture_id), kb = globalLectureSortKey(b.lecture_id);
  return ka[0] - kb[0] || ka[1] - kb[1];
}

function startOfWeek(ts) {
  const d = new Date(ts);
  const day = d.getDay();
  d.setDate(d.getDate() + ((day === 0 ? -6 : 1) - day));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfIsoWeekLabel(ts) {
  const d = new Date(startOfWeek(ts));
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// PDFs are early Week 4 material (recorded before the week4 video lectures),
// so group them there instead of giving each one its own pseudo-section.
function chapterSectionKeyOf(lectureId) {
  if (lectureId.startsWith('pdf-')) return 'week4';
  const m = lectureId.match(/^week(\d+)-video/);
  return m ? 'week' + m[1] : lectureId;
}
const CHAPTER_SECTION_TITLES = {
  week4: '2 — Environment Setup + Getting Started with Java',
  week5: 'Week 5 — Lecture Videos',
  week6: 'Week 6',
  week7: 'Week 7',
};

function isLectureCompleted(lectureId, studentUserid, progressByLecture) {
  if (lectureId.startsWith('pdf-')) {
    const pdfId = parseInt(lectureId.split('-')[1], 10);
    const chatCount = db.prepare("SELECT COUNT(*) as c FROM events WHERE student_userid = ? AND lecture_id = ? AND event_type = 'chat_message'").get(studentUserid, lectureId).c;
    const inkCount = db.prepare('SELECT COUNT(*) as c FROM pdf_ink_strokes WHERE pdf_id = ? AND student_userid = ?').get(pdfId, studentUserid).c;
    return chatCount > 0 || inkCount > 0;
  }
  const p = progressByLecture[lectureId];
  return !!p && p.pct >= 90;
}

// Builds the "Chapters" list for the course-detail page: every lecture (video
// or PDF) grouped into its week section, in canonical cross-week order, with
// a per-student completion flag and per-section progress percentage.
function buildCourseChapters(studentUserid) {
  const allLectures = db.prepare('SELECT * FROM lectures').all().sort(compareGlobalLectureOrder);
  const progressRows = db.prepare(
    `SELECT lecture_id, MAX(position) as maxpos, MAX(duration) as dur
     FROM events WHERE student_userid = ? AND event_type IN ('heartbeat','pause','ended','seek') AND position IS NOT NULL
     GROUP BY lecture_id`
  ).all(studentUserid);
  const progressByLecture = {};
  for (const r of progressRows) {
    if (!r.dur) continue;
    progressByLecture[r.lecture_id] = { pct: Math.min(100, (r.maxpos / r.dur) * 100) };
  }

  const sections = {};
  for (const l of allLectures) {
    const key = chapterSectionKeyOf(l.lecture_id);
    (sections[key] ||= []).push({
      lecture_id: l.lecture_id,
      title: l.title,
      isSlide: l.lecture_id.startsWith('pdf-'),
      completed: isLectureCompleted(l.lecture_id, studentUserid, progressByLecture),
    });
  }

  const sectionKeys = Object.keys(sections)
    .filter((key) => getChapterSetting(key).visible !== 0)
    .sort((a, b) => (parseInt(a.replace('week', ''), 10) || 0) - (parseInt(b.replace('week', ''), 10) || 0));
  const chapters = sectionKeys.map((key) => {
    const items = sections[key];
    const completedCount = items.filter((i) => i.completed).length;
    return {
      key,
      title: CHAPTER_SECTION_TITLES[key] || key,
      items,
      completedCount,
      total: items.length,
      pct: items.length ? Math.round((completedCount / items.length) * 100) : 0,
    };
  });

  const totalItems = chapters.reduce((a, c) => a + c.total, 0);
  const totalCompleted = chapters.reduce((a, c) => a + c.completedCount, 0);
  const overallPct = totalItems ? Math.round((totalCompleted / totalItems) * 100) : 0;

  return { chapters, overallPct };
}

// Everything the Home dashboard needs for one student, in one place so the
// route itself just renders it.
function buildHomeDashboardData(studentUserid) {
  const allLectures = db.prepare('SELECT * FROM lectures').all();
  const videoLectures = allLectures.filter((l) => !l.lecture_id.startsWith('pdf-'));

  const progressRows = db.prepare(
    `SELECT lecture_id, MAX(position) as maxpos, MAX(duration) as dur, MAX(created_at) as last
     FROM events WHERE student_userid = ? AND event_type IN ('heartbeat','pause','ended','seek') AND position IS NOT NULL
     GROUP BY lecture_id`
  ).all(studentUserid);
  const progressByLecture = {};
  for (const r of progressRows) {
    if (!r.dur) continue;
    progressByLecture[r.lecture_id] = { pct: Math.min(100, (r.maxpos / r.dur) * 100), last: r.last };
  }

  const pcts = Object.values(progressByLecture).map((p) => p.pct);
  const overallProgress = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / videoLectures.length) : 0;

  const sortedVideos = [...videoLectures].sort(compareGlobalLectureOrder);
  const inProgress = sortedVideos
    .filter((l) => progressByLecture[l.lecture_id] && progressByLecture[l.lecture_id].pct < 99)
    .sort((a, b) => (progressByLecture[b.lecture_id].last) - (progressByLecture[a.lecture_id].last));
  const continueWatching = inProgress[0] || null;
  const nextUp = sortedVideos.find((l) => !progressByLecture[l.lecture_id]) || null;

  // ---- Assignments (due-soon proxy: assignments this student hasn't drafted yet) ----
  const assignments = db.prepare('SELECT * FROM assignments').all();
  const draftedIds = new Set(
    db.prepare('SELECT assignment_id FROM assignment_drafts WHERE student_userid = ?').all(studentUserid).map((r) => r.assignment_id)
  );
  const assignmentsDueSoon = assignments.filter((a) => !draftedIds.has(a.id)).length;

  // ---- Sessions ----
  const now = Date.now();
  const weekStart = startOfWeek(now);
  const weekEnd = weekStart + 7 * 24 * 60 * 60 * 1000;
  const bookings = db.prepare(
    `SELECT sb.*, s.title, s.starts_at, s.duration_minutes FROM session_bookings sb
     JOIN sessions s ON s.id = sb.session_id WHERE sb.student_userid = ? ORDER BY s.starts_at ASC`
  ).all(studentUserid);
  const upcomingSessions = bookings.filter((b) => b.starts_at > now);
  const thisWeekSessions = bookings.filter((b) => b.starts_at >= weekStart && b.starts_at < weekEnd);

  // ---- Leaderboard (reuse the same scoring as /leaderboard) ----
  const students = db.prepare('SELECT * FROM students').all();
  const allProgressRows = db.prepare(
    `SELECT student_userid, MAX(position) as maxpos, MAX(duration) as dur, lecture_id
     FROM events WHERE event_type IN ('heartbeat','pause','ended','seek') AND position IS NOT NULL
     GROUP BY student_userid, lecture_id`
  ).all();
  const allChatRows = db.prepare(`SELECT student_userid, COUNT(*) as cnt FROM events WHERE event_type = 'chat_message' GROUP BY student_userid`).all();
  const chatByStudent = {};
  for (const r of allChatRows) chatByStudent[r.student_userid] = r.cnt;
  const pctByStudent = {};
  for (const r of allProgressRows) {
    if (!r.dur) continue;
    (pctByStudent[r.student_userid] ||= []).push(Math.min(100, (r.maxpos / r.dur) * 100));
  }
  const grades = db.prepare('SELECT * FROM grades').all();
  const gradeByStudent = {};
  for (const g of grades) gradeByStudent[g.userid] = g.quiz_percent;
  const ranked = students
    .filter((s) => s.username !== 'teacher1')
    .map((s) => {
      const pcts2 = pctByStudent[s.userid] || [];
      const avgWatch = pcts2.length ? pcts2.reduce((a, b) => a + b, 0) / pcts2.length : 0;
      const quizPct = gradeByStudent[s.userid] ?? 0;
      const chatCount = chatByStudent[s.userid] || 0;
      const score = Math.round(avgWatch * 0.4 + quizPct * 0.4 + Math.min(chatCount * 5, 20));
      return { ...s, score };
    })
    .sort((a, b) => b.score - a.score);
  const myRank = ranked.findIndex((s) => s.userid === Number(studentUserid)) + 1;

  // ---- My Progress: tutor/formative activity per week, last 8 weeks ----
  const chatEvents = db.prepare(
    `SELECT created_at FROM events WHERE student_userid = ? AND event_type = 'chat_message'`
  ).all(studentUserid);
  const weekBuckets = [];
  for (let i = 7; i >= 0; i--) {
    const ws = weekStart - i * 7 * 24 * 60 * 60 * 1000;
    weekBuckets.push({ start: ws, label: startOfIsoWeekLabel(ws), count: 0 });
  }
  for (const e of chatEvents) {
    const bucket = weekBuckets.find((b) => e.created_at >= b.start && e.created_at < b.start + 7 * 24 * 60 * 60 * 1000);
    if (bucket) bucket.count++;
  }

  return {
    courseCount: 1,
    assignmentsDueSoon,
    overallProgress,
    upcomingSessionsCount: upcomingSessions.length,
    continueWatching,
    continueWatchingPct: continueWatching ? Math.round(progressByLecture[continueWatching.lecture_id].pct) : 0,
    nextUp,
    leaderboard: ranked.slice(0, 4),
    myRank,
    totalStudents: ranked.length,
    weekBuckets,
    thisWeekSessions,
    assignmentsTotal: assignments.length,
  };
}

// Normalizes a question for frequency grouping -- catches "What is JDK?" vs
// "what is jdk" as the same question without needing real NLP clustering.
function normalizeQuestionText(q) {
  return String(q).toLowerCase().replace(/[?!.٪،\s]+$/g, '').trim().replace(/\s+/g, ' ');
}

// Course Supervisor overview: course-wide performance plus a per-section
// rollup (student cohort, not the week/lecture "sections" elsewhere in this
// file). Mirrors the real Criterio product's getSupervisorOverview.ts --
// same three engagement signals (watch completion, tutor bot messages,
// formative-bot escalations), same "only count videos actually watched"
// avg-completion definition, same highest/lowest-completion badge rule.
function buildCourseSupervisorOverview() {
  const sections = db.prepare('SELECT * FROM course_sections ORDER BY key').all();
  const students = db.prepare("SELECT * FROM students WHERE role = 'student'").all();
  const videoLectures = db.prepare('SELECT * FROM lectures').all().filter((l) => !l.lecture_id.startsWith('pdf-'));
  const videoIds = new Set(videoLectures.map((l) => l.lecture_id));

  const studentsBySection = {};
  students.forEach((s) => {
    if (!s.section) return;
    (studentsBySection[s.section] ||= []).push(s.userid);
  });

  const instructorById = {};
  db.prepare("SELECT userid, fullname, username FROM students WHERE role IN ('course_supervisor', 'section_instructor')").all()
    .forEach((t) => { instructorById[t.userid] = t; });

  const watchRows = db.prepare(
    `SELECT student_userid, lecture_id, MAX(position) as maxpos, MAX(duration) as dur
     FROM events WHERE event_type IN ('heartbeat', 'pause', 'ended', 'seek') AND position IS NOT NULL
     GROUP BY student_userid, lecture_id`
  ).all().filter((r) => videoIds.has(r.lecture_id) && r.dur);
  const chatStudentIds = db.prepare("SELECT student_userid FROM events WHERE event_type = 'chat_message'").all().map((r) => r.student_userid);
  const escalationRows = db.prepare('SELECT student_userid, resolved FROM formative_escalations').all();

  function computeForCohort(cohortStudentIds) {
    const idSet = new Set(cohortStudentIds);
    let completionSum = 0, completionCount = 0;
    const watchedVideos = new Set();
    for (const r of watchRows) {
      if (!idSet.has(r.student_userid)) continue;
      watchedVideos.add(r.lecture_id);
      completionSum += Math.min(100, (r.maxpos / r.dur) * 100);
      completionCount += 1;
    }
    const tutorBotMessages = chatStudentIds.filter((id) => idSet.has(id)).length;
    let openEscalations = 0, resolvedEscalations = 0;
    escalationRows.forEach((r) => {
      if (!idSet.has(r.student_userid)) return;
      if (r.resolved) resolvedEscalations++; else openEscalations++;
    });
    return {
      studentCount: cohortStudentIds.length,
      videosWatchedCount: watchedVideos.size,
      avgCompletionRate: completionCount ? Math.round(completionSum / completionCount) : 0,
      tutorBotMessages, openEscalations, resolvedEscalations,
    };
  }

  const sectionSummaries = sections.map((sec) => {
    const cohort = studentsBySection[sec.key] || [];
    const instructor = sec.instructor_userid ? instructorById[sec.instructor_userid] : null;
    return {
      key: sec.key,
      title: sec.title,
      instructorName: instructor ? instructor.fullname : null,
      ...computeForCohort(cohort),
    };
  });

  const totalOpenEscalations = sectionSummaries.reduce((sum, s) => sum + s.openEscalations, 0);
  const sectionedStudentIds = Object.values(studentsBySection).flat();
  const overall = computeForCohort(sectionedStudentIds);

  const withCompletion = sectionSummaries.filter((s) => s.avgCompletionRate > 0);
  const highestKey = withCompletion.length
    ? withCompletion.reduce((best, s) => (s.avgCompletionRate > best.avgCompletionRate ? s : best)).key
    : null;
  const lowestKey = sectionSummaries.length
    ? sectionSummaries.reduce((worst, s) => (s.avgCompletionRate < worst.avgCompletionRate ? s : worst)).key
    : null;

  return {
    performance: {
      totalStudents: sectionedStudentIds.length,
      totalVideos: videoIds.size,
      avgCompletionRate: overall.avgCompletionRate,
      totalTutorBotMessages: chatStudentIds.length,
      totalOpenEscalations,
    },
    sections: sectionSummaries,
    highestKey, lowestKey,
  };
}

function renderCourseOverviewSection(overview) {
  const { performance, sections, highestKey, lowestKey } = overview;
  return `
    <div class="section-block">
      <h2>Overall course performance</h2>
      <div class="stat-grid">
        <div class="stat-card"><div class="val">${performance.totalStudents}</div><div class="lbl">Students</div></div>
        <div class="stat-card"><div class="val">${performance.avgCompletionRate}%</div><div class="lbl">Avg. watched, when watched</div></div>
        <div class="stat-card"><div class="val">${performance.totalVideos}</div><div class="lbl">Videos</div></div>
        <div class="stat-card"><div class="val">${performance.totalTutorBotMessages}</div><div class="lbl">Tutor bot messages</div></div>
        <div class="stat-card"><div class="val">${performance.totalOpenEscalations}</div><div class="lbl">Open escalations${performance.totalOpenEscalations > 0 ? ' — needs attention' : ''}</div></div>
      </div>
    </div>

    <div class="section-block">
      <h2>Sections</h2>
      <div class="ov-pills">
        <button class="active" onclick="ovFilterSection('all', this)">All sections</button>
        ${sections.map((s) => `<button onclick="ovFilterSection('${s.key}', this)">${escapeHtml(s.title)}</button>`).join('')}
      </div>
      <div class="ov-section-grid" id="ovSectionGrid">
        ${sections.map((s) => `
          <div class="ov-section-card" data-section="${s.key}">
            <div class="ov-section-top">
              <div class="ov-section-name">${escapeHtml(s.title)}</div>
              ${s.key === highestKey && s.avgCompletionRate > 0 ? '<span class="ov-badge success">Highest engagement</span>' : ''}
              ${s.key === lowestKey && s.key !== highestKey ? '<span class="ov-badge warn">Needs attention</span>' : ''}
            </div>
            <div class="ov-section-instructor">${s.instructorName ? escapeHtml(s.instructorName) : 'No instructor assigned'}</div>
            <div style="margin-top:10px;">
              <div style="display:flex; justify-content:space-between; font-size:12px;"><span style="color:#8a94a6;">Avg. watched, when watched</span><span style="font-weight:700;">${s.avgCompletionRate}%</span></div>
              <div class="bar-track" style="flex:none; width:100%; margin-top:4px;"><div class="bar-fill" style="width:${s.avgCompletionRate}%;"></div></div>
            </div>
            <div class="ov-section-stats">
              <div><div class="ov-stat-lbl">Students</div><div class="ov-stat-val">${s.studentCount}</div></div>
              <div><div class="ov-stat-lbl">Videos watched</div><div class="ov-stat-val">${s.videosWatchedCount} of ${performance.totalVideos}</div></div>
              <div><div class="ov-stat-lbl">Tutor bot msgs</div><div class="ov-stat-val">${s.tutorBotMessages}</div></div>
              <div><div class="ov-stat-lbl">Escalations</div><div class="ov-stat-val">${s.openEscalations} open${s.resolvedEscalations > 0 ? ` &middot; ${s.resolvedEscalations} resolved` : ''}</div></div>
            </div>
          </div>`).join('') || '<p class="empty">No sections configured yet.</p>'}
      </div>
    </div>

    <script>
      function ovFilterSection(key, btn) {
        document.querySelectorAll('.ov-pills button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('#ovSectionGrid .ov-section-card').forEach((card) => {
          card.style.display = (key === 'all' || card.dataset.section === key) ? '' : 'none';
        });
      }
    </script>
  `;
}

// ---- Content tab: sections/roster, assignments, editable guidelines, chapters ----
function buildContentTabData() {
  const sections = db.prepare('SELECT * FROM course_sections ORDER BY key').all();
  const studentsBySection = {};
  db.prepare("SELECT * FROM students WHERE role = 'student'").all().forEach((s) => {
    const key = s.section || 'Unassigned';
    (studentsBySection[key] ||= []).push(s);
  });

  const videoLectures = db.prepare('SELECT * FROM lectures').all().filter((l) => !l.lecture_id.startsWith('pdf-'));
  const chapterKeys = [...new Set(videoLectures.map((l) => chapterSectionKeyOf(l.lecture_id)))]
    .sort((a, b) => (parseInt(a.replace('week', ''), 10) || 0) - (parseInt(b.replace('week', ''), 10) || 0));

  const chapters = chapterKeys.map((key) => {
    const setting = getChapterSetting(key);
    return {
      key,
      title: CHAPTER_SECTION_TITLES[key] || key,
      videos: videoLectures.filter((l) => chapterSectionKeyOf(l.lecture_id) === key).sort(compareGlobalLectureOrder),
      visible: setting.visible !== 0,
      dueDate: setting.due_date,
    };
  });

  const assignments = db.prepare('SELECT * FROM assignments ORDER BY created_at DESC').all();

  const knowledgeSources = db.prepare('SELECT * FROM tutor_knowledge_sources ORDER BY created_at DESC').all();
  const tutorGuidance = getCourseSetting('tutor_bot_guidance', '');
  const guidePolicy = getGuideModePolicy();

  const studentById = {};
  db.prepare('SELECT userid, fullname FROM students').all().forEach((s) => { studentById[s.userid] = s.fullname; });
  const escalationRows = db.prepare('SELECT * FROM formative_escalations ORDER BY created_at DESC').all();
  const escalations = escalationRows.map((e) => ({
    ...e, studentName: studentById[e.student_userid] || `#${e.student_userid}`,
  }));

  return {
    sections, studentsBySection, chapters, assignments, guidelines: getCourseGuidelines(),
    knowledgeSources, tutorGuidance, escalations, guidePolicy,
  };
}

function renderContentTab(data) {
  const { sections, studentsBySection, chapters, assignments, guidelines, knowledgeSources, tutorGuidance, escalations, guidePolicy } = data;
  const openEscalations = escalations.filter((e) => !e.resolved);
  const resolvedEscalations = escalations.filter((e) => e.resolved);
  return `
    <div class="section-block">
      <h2>Sections</h2>
      <p class="desc">Roster access and participation status per section.</p>
      <div class="ov-section-grid">
        ${sections.map((s) => `
          <div class="ov-section-card">
            <div class="ov-section-name">${escapeHtml(s.title)}</div>
            <div class="ov-section-instructor">${(studentsBySection[s.key] || []).length} enrolled student${(studentsBySection[s.key] || []).length === 1 ? '' : 's'}</div>
            <div style="margin-top:12px;"><a href="/instructor/roster?section=${encodeURIComponent(s.key)}" class="btn-mini address" style="text-decoration:none;">View roster &rarr;</a></div>
          </div>`).join('') || '<p class="empty">No sections configured yet.</p>'}
      </div>
    </div>

    <div class="section-block">
      <h2>Import students</h2>
      <p class="desc">Pick a section, then upload or paste a roster as one student per line: <code>username,Full Name</code> (a bare email works too — only the part before @ is matched). Matches against students already synced from Moodle and assigns them to the section; new accounts still have to be created in Moodle first.</p>
      <form method="post" action="/content/import-students" class="app-card" style="display:flex; flex-direction:column; gap:10px;">
        <select name="section" required style="padding:7px 10px; border:1px solid #e2e8f0; border-radius:8px; font-size:13px; max-width:280px;">
          <option value="">Select a section...</option>
          ${sections.map((s) => `<option value="${s.key}">${escapeHtml(s.title)}</option>`).join('')}
        </select>
        <input type="file" accept=".csv,.txt" onchange="loadRosterFile(this)" style="font-size:12px;">
        <textarea name="roster" id="rosterTextarea" rows="6" placeholder="student1,Sara Ahmad&#10;student2,Omar Ali" style="width:100%; box-sizing:border-box; font-family:inherit; font-size:13px; padding:10px; border:1px solid #e2e8f0; border-radius:8px;"></textarea>
        <button class="btn-mini address" type="submit" style="align-self:flex-start;">Import &amp; assign</button>
      </form>
    </div>

    <div class="section-block">
      <h2>Assignments</h2>
      <p class="desc">Course briefs and their verification status. Assignment changes stay in the Verification Queue.</p>
      <div class="app-card" style="padding:0;">
        ${assignments.map((a) => `
          <div class="chapter-row">
            <div><div class="ct">${escapeHtml(a.title || 'Untitled Assignment')}</div><div class="cm">Due ${a.due_date ? new Date(a.due_date).toLocaleDateString() : 'No due date'} &middot; ${a.status === 'published' ? 'Published' : 'Draft'}</div></div>
            ${a.status !== 'published' ? '<a href="/app/instructor?tab=verification" class="btn-mini dismiss" style="text-decoration:none;">Review</a>' : ''}
          </div>`).join('') || '<p class="empty" style="padding:12px;">No assignments yet.</p>'}
      </div>
    </div>

    <div class="section-block">
      <h2>Instructor Instructions</h2>
      <p class="desc">Course guidelines shown to students and used to ground the Course Tutor's answers.</p>
      <div class="app-card">
        <div id="guidelinesView" class="guidelines-card markdown-body">${marked.parse(guidelines || '')}</div>
        <form id="guidelinesForm" method="post" action="/content/guidelines" style="display:none;">
          <textarea name="guidelines" rows="6" style="width:100%; box-sizing:border-box; font-family:inherit; font-size:13px; padding:10px; border:1px solid #e2e8f0; border-radius:8px;">${escapeHtml(guidelines)}</textarea>
          <div style="margin-top:8px;"><button class="btn-mini address" type="submit">Save</button> <button class="btn-mini dismiss" type="button" onclick="toggleGuidelinesEdit(false)">Cancel</button></div>
        </form>
        <div style="margin-top:10px;"><button class="btn-mini dismiss" type="button" id="guidelinesEditBtn" onclick="toggleGuidelinesEdit(true)">Edit</button></div>
      </div>
    </div>

    <div class="section-block">
      <h2>Guide Me policy</h2>
      <p class="desc">Controls how far Guide Me lets a student push before it gives the direct answer. Doesn't affect Ask or Check Me.</p>
      <div class="app-card">
        <form method="post" action="/content/guide-policy" style="display:flex; flex-direction:column; gap:12px;">
          <label style="display:flex; align-items:center; gap:8px; font-size:13px;">
            <input type="checkbox" name="never_direct_answer" value="1" ${guidePolicy.neverDirectAnswer ? 'checked' : ''} onchange="document.getElementById('attemptsRow').style.opacity = this.checked ? '0.4' : '1'">
            Never give the direct answer, even if the student gives up
          </label>
          <label id="attemptsRow" style="font-size:12px; color:#57606a; ${guidePolicy.neverDirectAnswer ? 'opacity:0.4;' : ''}">
            Exchanges before offering the direct answer<br>
            <input type="number" name="attempts_before_direct" min="1" max="20" value="${guidePolicy.attemptsBeforeDirect}" style="margin-top:4px; padding:6px 8px; border:1px solid #e2e8f0; border-radius:6px; width:80px;">
          </label>
          <button class="btn-mini address" type="submit" style="align-self:flex-start;">Save</button>
        </form>
      </div>
    </div>

    <div class="section-block">
      <h2>Chapters</h2>
      <p class="desc">This is what students see on their course page, with edit controls added. Set an attendance due date to feed the Attendance tab.</p>
      <div class="app-card" style="padding:0;">
        ${chapters.map((c) => `
          <div class="content-chapter">
            <div class="content-chapter-head">
              <div><div class="ct">${escapeHtml(c.title)}${c.visible ? '' : ' <span class="badge-pct">Hidden</span>'}</div><div class="cm">${c.videos.length} video${c.videos.length === 1 ? '' : 's'}</div></div>
              <div style="display:flex; align-items:center; gap:10px;">
                <form method="post" action="/content/chapter/${c.key}/due-date" style="display:flex; align-items:center; gap:4px;">
                  <label style="font-size:11px; color:#8a94a6;">Attendance due date</label>
                  <input type="date" name="due_date" value="${c.dueDate ? new Date(c.dueDate).toISOString().slice(0, 10) : ''}" onchange="this.form.submit()" style="font-size:12px; padding:4px 6px; border:1px solid #e2e8f0; border-radius:6px;">
                </form>
                <form method="post" action="/content/chapter/${c.key}/visibility">
                  <input type="hidden" name="visible" value="${c.visible ? '0' : '1'}">
                  <button class="btn-mini dismiss" type="submit">${c.visible ? 'Hide' : 'Show'}</button>
                </form>
              </div>
            </div>
            <div class="content-chapter-videos">
              ${c.videos.map((v) => `
                <div class="content-video-row">
                  <span>${escapeHtml(v.title)}</span>
                  <a href="/instructor/video-analytics?lecture_id=${encodeURIComponent(v.lecture_id)}" class="btn-mini dismiss" style="text-decoration:none;">Analytics</a>
                </div>`).join('')}
            </div>
          </div>`).join('') || '<p class="empty" style="padding:12px;">No chapters yet.</p>'}
      </div>
    </div>

    <div class="section-block">
      <h2>Course Tutor Bot</h2>
      <p class="desc">Grounded in the guidelines and chapters above. Add course-specific guidance while grounding and academic-integrity rules stay protected.</p>
      <div class="app-card">
        <div style="font-weight:700; font-size:13px; margin-bottom:2px;">Tutor Bot Instructions</div>
        <div style="color:#8a94a6; font-size:12px; margin-bottom:10px;">${tutorGuidance ? 'Instructor guidance added' : 'Using protected course defaults'}</div>
        <div id="tutorGuidanceView" class="guidelines-card">${tutorGuidance ? escapeHtml(tutorGuidance) : '<span style="color:#8a94a6;">No additional guidance yet — the bot uses the course guidelines and knowledge base below.</span>'}</div>
        <form id="tutorGuidanceForm" method="post" action="/content/tutor-guidance" style="display:none;">
          <textarea name="guidance" rows="4" maxlength="4000" style="width:100%; box-sizing:border-box; font-family:inherit; font-size:13px; padding:10px; border:1px solid #e2e8f0; border-radius:8px;">${escapeHtml(tutorGuidance)}</textarea>
          <div style="margin-top:8px;"><button class="btn-mini address" type="submit">Save</button> <button class="btn-mini dismiss" type="button" onclick="toggleTutorGuidanceEdit(false)">Cancel</button></div>
        </form>
        <div style="margin-top:10px;"><button class="btn-mini dismiss" type="button" id="tutorGuidanceEditBtn" onclick="toggleTutorGuidanceEdit(true)">Edit</button></div>
      </div>

      <div class="app-card" style="margin-top:14px;">
        <div style="font-weight:700; font-size:13px; margin-bottom:2px;">Knowledge Base</div>
        <div style="color:#8a94a6; font-size:12px; margin-bottom:10px;">Extra text sources the Course Tutor draws on, beyond the guidelines and lecture material.</div>
        ${knowledgeSources.map((k) => `
          <div class="content-video-row">
            <span>${escapeHtml(k.title)} <span style="color:#8a94a6;">(${k.content_text.length.toLocaleString()} chars)</span></span>
            <form method="post" action="/content/tutor-knowledge/${k.id}/delete" style="display:inline;" onsubmit="return confirm('Remove this knowledge source?');">
              <button class="btn-mini dismiss" type="submit">Delete</button>
            </form>
          </div>`).join('') || '<p class="empty">No knowledge sources added yet.</p>'}
        <form method="post" action="/content/tutor-knowledge/add" style="display:flex; flex-direction:column; gap:8px; margin-top:12px; border-top:1px solid #eef1f4; padding-top:12px;">
          <input type="text" name="title" placeholder="Source title (e.g. 'Java style guide')" required style="padding:7px 10px; border:1px solid #e2e8f0; border-radius:8px; font-size:13px;">
          <input type="file" accept=".txt,.md" onchange="loadKnowledgeFile(this)" style="font-size:12px;">
          <textarea name="content_text" id="knowledgeTextarea" rows="4" placeholder="Paste text, or upload a .txt/.md file above" required style="width:100%; box-sizing:border-box; font-family:inherit; font-size:13px; padding:10px; border:1px solid #e2e8f0; border-radius:8px;"></textarea>
          <button class="btn-mini address" type="submit" style="align-self:flex-start;">Add source</button>
        </form>
      </div>
    </div>

    <div class="section-block">
      <h2>Formative Bot — Needs Attention</h2>
      <p class="desc">Questions the bot (or the student) flagged as needing you — ${openEscalations.length} open, ${resolvedEscalations.length} resolved.</p>
      <div class="app-card">
        ${escalations.length ? [...openEscalations, ...resolvedEscalations].map((e) => `
          <div class="revisit-card" style="${e.resolved ? 'opacity:0.6;' : ''}">
            <div class="q-top">
              <div><span style="font-weight:700;">${escapeHtml(e.studentName)}</span> <span class="q-meta">${new Date(e.created_at).toLocaleString()}</span></div>
              ${e.resolved ? '<span class="ov-badge success">Resolved</span>' : '<span class="ov-badge warn">Open</span>'}
            </div>
            <div class="q-msg"><strong>Q:</strong> ${escapeHtml(e.question)}</div>
            ${e.report ? `<div style="font-size:12px; color:#57606a; margin-bottom:8px;">${escapeHtml(e.report)}</div>` : ''}
            <form method="post" action="/content/escalations/${e.id}/resolve" style="display:inline;">
              <input type="hidden" name="resolved" value="${e.resolved ? '0' : '1'}">
              <button class="btn-mini ${e.resolved ? 'dismiss' : 'address'}" type="submit">${e.resolved ? 'Mark unresolved' : 'Mark resolved'}</button>
            </form>
          </div>`).join('') : '<p class="empty">No escalations yet — the bot is handling questions on its own so far.</p>'}
      </div>
    </div>

    <script>
      function toggleTutorGuidanceEdit(show) {
        document.getElementById('tutorGuidanceView').style.display = show ? 'none' : 'block';
        document.getElementById('tutorGuidanceForm').style.display = show ? 'block' : 'none';
        document.getElementById('tutorGuidanceEditBtn').style.display = show ? 'none' : 'inline-block';
      }
      function loadKnowledgeFile(input) {
        const file = input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => { document.getElementById('knowledgeTextarea').value = reader.result; };
        reader.readAsText(file);
      }
      function toggleGuidelinesEdit(show) {
        document.getElementById('guidelinesView').style.display = show ? 'none' : 'block';
        document.getElementById('guidelinesForm').style.display = show ? 'block' : 'none';
        document.getElementById('guidelinesEditBtn').style.display = show ? 'none' : 'inline-block';
      }
      function loadRosterFile(input) {
        const file = input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => { document.getElementById('rosterTextarea').value = reader.result; };
        reader.readAsText(file);
      }
    </script>
  `;
}

// ---- Attendance tab: engagement-derived attendance ----
// HTU's real written policy is an absence-count cap (5 allowed, the 6th
// disqualifies), not a percentage threshold, and "absences" are derived
// rather than marked: every two chapters a student fails to sufficiently
// watch by their due date count as one absence. Ported 1:1 from the real
// Criterio product's calculateAttendance.ts (studied via the FerasJalal/
// criterio reference repo) -- same thresholds, same risk-level ladder.
function calculateAttendanceSummary(chapterInputs, engagementThresholdPercent, maxAbsencesAllowed) {
  let engagedChapters = 0, watchedPercentSum = 0;
  for (const c of chapterInputs) {
    if (c.watchedPercent >= engagementThresholdPercent) engagedChapters++;
    watchedPercentSum += c.watchedPercent;
  }
  const nonEngagedChapters = chapterInputs.length - engagedChapters;
  const avgWatchedPercent = chapterInputs.length > 0 ? Math.round(watchedPercentSum / chapterInputs.length) : null;
  const countableAbsences = Math.floor(nonEngagedChapters / 2);
  const riskLevel = attendanceRiskLevel(countableAbsences, maxAbsencesAllowed, chapterInputs.length);
  // "Falling behind" is a forward-looking advisory, distinct from the official absence
  // count: non-engaged in the most recent two DUE chapters specifically (not the
  // cumulative total), so it surfaces a slipping student before the every-two-counts-as-
  // one-absence rule catches up to them. Mutually exclusive with the approaching/critical/
  // disqualified group so the three buckets partition the roster with no double-count.
  const approachingLimit = ['warning', 'critical', 'disqualified'].includes(riskLevel);
  const lastTwo = chapterInputs.slice(-2);
  const fallingBehind = !approachingLimit && lastTwo.length === 2 && lastTwo.every((c) => c.watchedPercent < engagementThresholdPercent);
  return {
    evaluatedChapters: chapterInputs.length, engagedChapters, nonEngagedChapters, avgWatchedPercent,
    countableAbsences, maxAbsencesAllowed, riskLevel, approachingLimit, fallingBehind,
  };
}
function attendanceRiskLevel(countableAbsences, maxAbsencesAllowed, evaluatedChapters) {
  if (evaluatedChapters === 0) return 'no_data';
  if (countableAbsences > maxAbsencesAllowed) return 'disqualified';
  if (countableAbsences === maxAbsencesAllowed) return 'critical';
  if (countableAbsences === maxAbsencesAllowed - 1) return 'warning';
  return 'good_standing';
}

function buildAttendanceData(sectionFilter) {
  const engagementEnabled = getCourseSetting('engagement_attendance_enabled', '0') === '1';
  const thresholdPct = parseInt(getCourseSetting('engagement_watch_threshold_percent', '70'), 10);
  const maxAbsences = parseInt(getCourseSetting('max_absences_allowed', '5'), 10);
  const sections = db.prepare('SELECT * FROM course_sections ORDER BY key').all();

  if (!engagementEnabled) return { engagementEnabled, thresholdPct, maxAbsences, sections, chapters: [], rows: [] };

  const now = Date.now();
  const videoLectures = db.prepare('SELECT * FROM lectures').all().filter((l) => !l.lecture_id.startsWith('pdf-'));
  const chapterKeys = [...new Set(videoLectures.map((l) => chapterSectionKeyOf(l.lecture_id)))];
  // All chapters in course order (due or not) -- drives the per-student heatmap strip, which
  // shows a placeholder square for not-yet-due chapters instead of omitting them, so the
  // strip's length reflects the whole course rather than growing as chapters come due.
  const allChapters = chapterKeys
    .map((key) => ({ key, title: CHAPTER_SECTION_TITLES[key] || key, ...getChapterSetting(key) }))
    .sort((a, b) => (parseInt(a.key.replace('week', ''), 10) || 0) - (parseInt(b.key.replace('week', ''), 10) || 0));
  const dueChapters = allChapters
    .filter((c) => c.due_date && c.due_date <= now)
    .sort((a, b) => a.due_date - b.due_date);

  if (!dueChapters.length) return { engagementEnabled, thresholdPct, maxAbsences, sections, chapters: [], allChapters, rows: [] };

  const videosByChapter = {};
  videoLectures.forEach((l) => {
    const key = chapterSectionKeyOf(l.lecture_id);
    (videosByChapter[key] ||= []).push(l.lecture_id);
  });

  const pctByStudentLecture = {};
  db.prepare(
    `SELECT student_userid, lecture_id, MAX(position) as maxpos, MAX(duration) as dur
     FROM events WHERE event_type IN ('heartbeat', 'pause', 'ended', 'seek') AND position IS NOT NULL
     GROUP BY student_userid, lecture_id`
  ).all().forEach((r) => {
    if (!r.dur) return;
    pctByStudentLecture[`${r.student_userid}:${r.lecture_id}`] = Math.min(100, Math.round((r.maxpos / r.dur) * 100));
  });

  let students = db.prepare("SELECT * FROM students WHERE role = 'student'").all();
  if (sectionFilter) students = students.filter((s) => s.section === sectionFilter);
  const sectionTitleByKey = {};
  sections.forEach((s) => { sectionTitleByKey[s.key] = s.title; });

  function watchedPercentFor(studentId, chapterKey) {
    const videoIds = videosByChapter[chapterKey] || [];
    return videoIds.length
      ? Math.round(videoIds.reduce((sum, id) => sum + (pctByStudentLecture[`${studentId}:${id}`] || 0), 0) / videoIds.length)
      : 0;
  }

  const rows = students.map((s) => {
    const cells = {};
    const summaryInputs = dueChapters.map((chapter) => {
      const watchedPercent = watchedPercentFor(s.userid, chapter.key);
      const engaged = watchedPercent >= thresholdPct;
      cells[chapter.key] = { watchedPercent, engaged };
      return { watchedPercent };
    });
    const summary = calculateAttendanceSummary(summaryInputs, thresholdPct, maxAbsences);
    const heatmap = allChapters.map((chapter) => {
      const isDue = chapter.due_date && chapter.due_date <= now;
      if (!isDue) return { key: chapter.key, due: false };
      const watchedPercent = watchedPercentFor(s.userid, chapter.key);
      return { key: chapter.key, due: true, engaged: watchedPercent >= thresholdPct, watchedPercent };
    });
    return {
      userid: s.userid, fullname: s.fullname, username: s.username,
      sectionTitle: sectionTitleByKey[s.section] || s.section || 'Unassigned',
      cells, summary, heatmap,
    };
  }).sort((a, b) => a.fullname.localeCompare(b.fullname));

  return { engagementEnabled, thresholdPct, maxAbsences, sections, chapters: dueChapters, allChapters, rows };
}

function renderAttendanceTab(data, currentSectionFilter) {
  const { engagementEnabled, thresholdPct, maxAbsences, sections, chapters, rows } = data;

  const policyForm = `
    <div class="section-block">
      <h2>Attendance policy</h2>
      <p class="desc">Attendance is derived from video-watch engagement against each chapter's due date. Every two non-engaged chapters count as one absence.</p>
      <form method="post" action="/attendance/policy" class="app-card" style="display:flex; flex-wrap:wrap; gap:16px; align-items:flex-end;">
        <label style="display:flex; align-items:center; gap:6px; font-size:13px;"><input type="checkbox" name="enabled" value="1" ${engagementEnabled ? 'checked' : ''}> Enable engagement-based attendance</label>
        <label style="font-size:12px; color:#57606a;">Watch threshold to count as "engaged" (%)<br><input type="number" name="threshold" min="1" max="100" value="${thresholdPct}" style="margin-top:4px; padding:6px 8px; border:1px solid #e2e8f0; border-radius:6px; width:80px;"></label>
        <label style="font-size:12px; color:#57606a;">Absences allowed before disqualified<br><input type="number" name="max_absences" min="0" max="50" value="${maxAbsences}" style="margin-top:4px; padding:6px 8px; border:1px solid #e2e8f0; border-radius:6px; width:80px;"></label>
        <button class="btn-mini address" type="submit">Save policy</button>
      </form>
    </div>
  `;

  if (!engagementEnabled) {
    return policyForm + `
    <div class="section-block">
      <div class="app-card" style="text-align:center; padding:40px 20px; border-style:dashed;">
        <div style="font-weight:700;">Engagement-based attendance isn't enabled</div>
        <p class="desc" style="margin-top:6px;">Turn it on above and set the watch threshold to start tracking.</p>
      </div>
    </div>`;
  }
  if (!chapters.length) {
    return policyForm + `
    <div class="section-block">
      <div class="app-card" style="text-align:center; padding:40px 20px; border-style:dashed;">
        <div style="font-weight:700;">No due chapters yet</div>
        <p class="desc" style="margin-top:6px;">Set an attendance due date on a chapter with video materials (in Content) to start tracking engagement-based attendance.</p>
      </div>
    </div>`;
  }

  const withData = rows.filter((r) => r.summary.evaluatedChapters > 0);
  const avgPercent = withData.length ? Math.round(withData.reduce((sum, r) => sum + (r.summary.avgWatchedPercent || 0), 0) / withData.length) : null;
  const approaching = rows.filter((r) => r.summary.approachingLimit).length;
  const fallingBehind = rows.filter((r) => r.summary.fallingBehind).length;
  const onTrack = rows.length - approaching - fallingBehind;
  const riskLabels = { no_data: 'No data', good_standing: 'On track', warning: 'Approaching limit', critical: 'Approaching limit', disqualified: 'Disqualified' };
  const riskClass = { no_data: 'tag', good_standing: 'ov-badge success', warning: 'ov-badge warn', critical: 'risk-critical', disqualified: 'risk-critical' };
  const notDueCount = data.allChapters.length - chapters.length;

  function heatmapHtml(heatmap) {
    return heatmap.map((c) => {
      if (!c.due) return `<span class="att-square not-due" title="${escapeHtml(c.key)}: not due yet"></span>`;
      return `<span class="att-square ${c.engaged ? 'engaged' : 'not-engaged'}" title="${escapeHtml(c.key)}: ${c.watchedPercent}%${c.engaged ? ' (engaged)' : ' (not engaged)'}"></span>`;
    }).join('');
  }

  return policyForm + `
    <div class="section-block">
      <h2>Attendance</h2>
      <p class="desc">Attendance is derived from video-watch engagement. ${maxAbsences} absences allowed before a student is flagged disqualified; every two non-engaged chapters count as one absence.</p>
      <div style="display:flex; gap:8px; margin-bottom:12px;">
        <button class="btn-mini address" id="attViewList" onclick="attSetView('list')">List</button>
        <button class="btn-mini dismiss" id="attViewGrid" onclick="attSetView('grid')">Grid</button>
      </div>
      <div class="stat-grid">
        <div class="stat-card"><div class="val" style="color:#a10f22;">${approaching}</div><div class="lbl">Approaching the limit</div><div class="desc" style="margin-top:2px;">${maxAbsences - 1}+ absences of ${maxAbsences} allowed</div></div>
        <div class="stat-card"><div class="val" style="color:#946200;">${fallingBehind}</div><div class="lbl">Falling behind</div><div class="desc" style="margin-top:2px;">missed the last two due chapters — advisory, not an absence</div></div>
        <div class="stat-card"><div class="val" style="color:#1f9d55;">${onTrack}</div><div class="lbl">On track</div><div class="desc" style="margin-top:2px;">of ${rows.length} enrolled</div></div>
        <div class="stat-card"><div class="val">${avgPercent !== null ? avgPercent + '%' : '—'}</div><div class="lbl">Avg. watched %</div><div class="desc" style="margin-top:2px;">of due chapters across ${rows.length} students — unwatched counts as 0%</div></div>
      </div>

      <div style="display:flex; flex-wrap:wrap; gap:8px; margin:14px 0; align-items:center;">
        <select onchange="location.href='/app/instructor?tab=attendance' + (this.value ? '&section=' + this.value : '')" style="padding:7px 10px; border:1px solid #e2e8f0; border-radius:8px; font-size:12px;">
          <option value="">All sections</option>
          ${sections.map((s) => `<option value="${s.key}" ${currentSectionFilter === s.key ? 'selected' : ''}>${escapeHtml(s.title)}</option>`).join('')}
        </select>
        <input class="search-box" style="max-width:220px; margin-bottom:0;" id="attSearch" placeholder="Search name or student ID..." oninput="filterAttendance()">
        <span style="font-size:12px; color:#8a94a6;">${data.allChapters.length} chapters · ${notDueCount} not due yet, shown but never counted</span>
        <a href="/attendance/export.csv${currentSectionFilter ? '?section=' + currentSectionFilter : ''}" class="btn-mini dismiss" style="text-decoration:none; margin-left:auto;">Export all (CSV)</a>
      </div>

      <div class="ov-pills" id="attQuickFilters">
        <button class="active" onclick="attQuickFilter('all', this)">All students</button>
        <button onclick="attQuickFilter('approaching', this)">Approaching the limit</button>
        <button onclick="attQuickFilter('falling_behind', this)">Falling behind</button>
        <button onclick="attQuickFilter('on_track', this)">On track</button>
      </div>

      <div class="app-card" style="padding:0;" id="attListView">
        ${rows.map((r) => `
          <div class="att-row" data-name="${escapeHtml((r.fullname + ' ' + r.username).toLowerCase())}"
               data-bucket="${r.summary.approachingLimit ? 'approaching' : r.summary.fallingBehind ? 'falling_behind' : 'on_track'}">
            <div style="flex:1; min-width:180px;">
              <div style="font-weight:700; font-size:13px;"><a href="/instructor/student?id=${r.userid}" style="color:inherit; text-decoration:none;">${escapeHtml(r.fullname)}</a></div>
              <div style="color:#8a94a6; font-size:11px;">${escapeHtml(r.username)} &middot; ${escapeHtml(r.sectionTitle)}</div>
            </div>
            <div style="text-align:center; min-width:70px;"><div style="font-weight:700;">${r.summary.countableAbsences}/${r.summary.maxAbsencesAllowed}</div><div style="font-size:11px; color:#8a94a6;">absences</div></div>
            <div style="text-align:center; min-width:60px;"><div style="font-weight:700;">${r.summary.avgWatchedPercent ?? '—'}%</div><div style="font-size:11px; color:#8a94a6;">avg</div></div>
            <div class="att-heatmap">${heatmapHtml(r.heatmap)}</div>
          </div>`).join('') || '<p class="empty" style="padding:12px;">No students match this filter.</p>'}
      </div>

      <div class="app-card" style="padding:0; overflow-x:auto; display:none;" id="attGridView">
        <table class="perf-table" id="attTable">
          <thead><tr>
            <th>Student</th><th>Section</th><th style="text-align:center;">Absences</th><th style="text-align:center;">Avg %</th><th>Status</th>
            ${chapters.map((c) => `<th>${escapeHtml(c.title)}<div style="font-weight:400; color:#8a94a6;">due ${new Date(c.due_date).toLocaleDateString()}</div></th>`).join('')}
          </tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr data-name="${escapeHtml((r.fullname + ' ' + r.username).toLowerCase())}" data-bucket="${r.summary.approachingLimit ? 'approaching' : r.summary.fallingBehind ? 'falling_behind' : 'on_track'}">
                <td style="font-weight:700;"><a href="/instructor/student?id=${r.userid}" style="color:inherit;">${escapeHtml(r.fullname)}</a></td>
                <td>${escapeHtml(r.sectionTitle)}</td>
                <td style="text-align:center;">${r.summary.countableAbsences}/${r.summary.maxAbsencesAllowed}</td>
                <td style="text-align:center;">${r.summary.avgWatchedPercent ?? '—'}</td>
                <td>${r.summary.fallingBehind
                  ? '<span class="ov-badge warn">Falling behind</span>'
                  : `<span class="${riskClass[r.summary.riskLevel]}">${riskLabels[r.summary.riskLevel]}</span>`}</td>
                ${chapters.map((c) => {
                  const cell = r.cells[c.key];
                  return `<td>${cell ? `${cell.watchedPercent}% <span class="${cell.engaged ? 'ov-badge success' : 'ov-badge warn'}" style="padding:1px 6px;">${cell.engaged ? 'Engaged' : 'Not engaged'}</span>` : 'n/a'}</td>`;
                }).join('')}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <script>
      function attRowEls() {
        return [...document.querySelectorAll('#attListView .att-row'), ...document.querySelectorAll('#attGridView tbody tr')];
      }
      function filterAttendance() {
        const q = document.getElementById('attSearch').value.toLowerCase();
        attRowEls().forEach((row) => {
          row.dataset.hiddenBySearch = row.dataset.name.includes(q) ? '' : '1';
        });
        applyAttVisibility();
      }
      function attQuickFilter(kind, btn) {
        document.querySelectorAll('#attQuickFilters button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        attRowEls().forEach((row) => {
          row.dataset.hiddenByBucket = (kind === 'all' || row.dataset.bucket === kind) ? '' : '1';
        });
        applyAttVisibility();
      }
      function applyAttVisibility() {
        attRowEls().forEach((row) => {
          row.style.display = (row.dataset.hiddenBySearch || row.dataset.hiddenByBucket) ? 'none' : '';
        });
      }
      function attSetView(view) {
        document.getElementById('attListView').style.display = view === 'list' ? '' : 'none';
        document.getElementById('attGridView').style.display = view === 'grid' ? '' : 'none';
        document.getElementById('attViewList').className = 'btn-mini ' + (view === 'list' ? 'address' : 'dismiss');
        document.getElementById('attViewGrid').className = 'btn-mini ' + (view === 'grid' ? 'address' : 'dismiss');
      }
    </script>
  `;
}

// Everything the Analytics tab needs: at-risk
// flagging with a reason string, per-question accuracy with a persisted
// addressed/dismissed workflow, lecture-video groupings for drill-down, the
// per-bot-type AI interaction log, and the leaderboard ranking. Same events/
// popup_responses tables everything else already writes to, plus the new
// students.section column from the multi-instructor course model.
function buildAnalyticsTabData() {
  const students = db.prepare("SELECT * FROM students WHERE role = 'student'").all();
  const studentById = {};
  students.forEach((s) => { studentById[s.userid] = s; });
  const totalStudents = students.length;
  const allLectures = db.prepare('SELECT * FROM lectures').all();
  const lectures = allLectures.filter((l) => !l.lecture_id.startsWith('pdf-'));
  const grades = db.prepare('SELECT * FROM grades').all();
  const gradeByStudent = {};
  grades.forEach((g) => { gradeByStudent[g.userid] = g.quiz_percent; });

  const progressRows = db.prepare(
    `SELECT student_userid, lecture_id, MAX(position) as maxpos, MAX(duration) as dur
     FROM events WHERE event_type IN ('heartbeat', 'pause', 'ended', 'seek') AND position IS NOT NULL
     GROUP BY student_userid, lecture_id`
  ).all();
  const progressByStudent = {};
  for (const r of progressRows) {
    if (!r.dur) continue;
    (progressByStudent[r.student_userid] ||= []).push({ lecture_id: r.lecture_id, pct: Math.min(100, (r.maxpos / r.dur) * 100) });
  }

  const popupResponseRows = db.prepare('SELECT popup_question_id, student_userid, status FROM popup_responses').all();
  const popupByStudent = {};
  for (const r of popupResponseRows) {
    if (r.status === 'dropped') continue;
    const p = (popupByStudent[r.student_userid] ||= { correct: 0, total: 0 });
    p.total++;
    if (r.status === 'answered_correct') p.correct++;
  }

  // ---- Who needs you ----
  const whoNeedsYou = students.map((s) => {
    const lecturesCompleted = (progressByStudent[s.userid] || []).filter((p) => p.pct >= 90).length;
    const hasAnyProgress = (progressByStudent[s.userid] || []).length > 0;
    const pu = popupByStudent[s.userid];
    const accuracyPct = pu && pu.total ? Math.round((pu.correct / pu.total) * 100) : null;
    let reason = null;
    if (accuracyPct !== null && pu.total >= 3 && accuracyPct < 60) {
      reason = `Quiz accuracy is ${accuracyPct}% across ${pu.total} attempts.`;
    } else if (pu && pu.total > 0 && lecturesCompleted === 0) {
      reason = `Answering quizzes but hasn't marked any lecture complete.`;
    } else if (hasAnyProgress && lecturesCompleted === 0 && !pu) {
      reason = `Active in the course but hasn't marked any lecture complete.`;
    }
    return { userid: s.userid, fullname: s.fullname, email: s.email || '', section: s.section || 'Unassigned', reason };
  }).filter((s) => s.reason);

  // ---- Questions worth revisiting ----
  const popupQuestions = db.prepare("SELECT * FROM popup_questions WHERE status = 'approved'").all();
  const reviewByQ = {};
  db.prepare('SELECT * FROM question_review_status').all().forEach((r) => { reviewByQ[r.popup_question_id] = r.status; });
  const responsesByQ = {};
  for (const r of popupResponseRows) {
    if (r.status === 'dropped') continue;
    (responsesByQ[r.popup_question_id] ||= []).push(r);
  }
  const worthRevisiting = popupQuestions.map((q) => {
    const responses = responsesByQ[q.id] || [];
    const attempts = responses.length;
    const correct = responses.filter((r) => r.status === 'answered_correct').length;
    const wrong = attempts - correct;
    const distinctStudents = new Set(responses.map((r) => r.student_userid)).size;
    const accuracyPct = attempts ? Math.round((correct / attempts) * 100) : null;
    const lec = allLectures.find((l) => l.lecture_id === q.lecture_id);
    const notAttempted = Math.max(0, totalStudents - distinctStudents);
    let message = null;
    if (attempts > 0 && wrong > 0) {
      const base = `${wrong} of ${attempts} attempt${attempts > 1 ? 's' : ''} were wrong — ${distinctStudents} of ${totalStudents} students have attempted it, ${notAttempted} have not.`;
      message = distinctStudents < 5
        ? `${base} Too few have attempted it to judge the class yet — worth revisiting once more students reach this question.`
        : `${base} Worth going over again in class.`;
    }
    return {
      id: q.id, question: q.question, lectureTitle: lec ? lec.title : q.lecture_id,
      timestampLabel: formatTimestamp(q.timestamp), attempts, accuracyPct, distinctStudents, totalStudents,
      status: reviewByQ[q.id] || 'open', message,
    };
  }).filter((q) => q.status === 'open' && q.message)
    .sort((a, b) => (a.accuracyPct ?? 100) - (b.accuracyPct ?? 100));

  // ---- Lecture videos, grouped into the same chapters students see on their course page ----
  const chapterKeys = [...new Set(lectures.map((l) => chapterSectionKeyOf(l.lecture_id)))]
    .sort((a, b) => (parseInt(a.replace('week', ''), 10) || 0) - (parseInt(b.replace('week', ''), 10) || 0));
  const lectureVideoChapters = chapterKeys.map((key) => ({
    key,
    title: CHAPTER_SECTION_TITLES[key] || key,
    videos: lectures.filter((l) => chapterSectionKeyOf(l.lecture_id) === key).sort(compareGlobalLectureOrder),
  }));

  // ---- AI questions, by bot ----
  function summarizeInteractions(items) {
    const byStudent = {};
    const groups = {};
    for (const i of items) {
      const su = (byStudent[i.studentName] ||= { name: i.studentName, count: 0, lastActive: 0 });
      su.count++;
      su.lastActive = Math.max(su.lastActive, i.createdAt);
      const norm = normalizeQuestionText(i.question);
      if (norm) {
        const g = (groups[norm] ||= { text: i.question, count: 0 });
        g.count++;
      }
    }
    return {
      items: items.slice(0, 100),
      interactions: items.length,
      students: Object.keys(byStudent).length,
      repeated: Object.values(groups).filter((g) => g.count > 1).length,
      studentActivity: Object.values(byStudent).sort((a, b) => b.lastActive - a.lastActive).slice(0, 20),
      repeatedQuestions: Object.values(groups).filter((g) => g.count > 1).sort((a, b) => b.count - a.count).slice(0, 10),
    };
  }
  function loadChatCategory(matchLectureId) {
    const rows = db.prepare(
      `SELECT id, student_userid, lecture_id, payload, created_at FROM events WHERE event_type = 'chat_message' ORDER BY created_at DESC`
    ).all().filter((r) => matchLectureId(r.lecture_id));
    const items = rows.map((r) => {
      let p = {};
      try { p = JSON.parse(r.payload); } catch (e) { /* malformed, skip fields */ }
      const student = studentById[r.student_userid];
      return {
        id: r.id, studentName: student ? student.fullname : `#${r.student_userid}`,
        question: p.question || '', answer: p.answer || '', createdAt: r.created_at,
      };
    }).filter((i) => i.question);
    return summarizeInteractions(items);
  }
  const aiQuestions = {
    course: loadChatCategory((lid) => lid === 'course'),
    video: loadChatCategory((lid) => !lid.startsWith('pdf-') && !lid.startsWith('assignment-') && lid !== 'course'),
    pdf: loadChatCategory((lid) => lid.startsWith('pdf-')),
    assistant: loadChatCategory((lid) => lid.startsWith('assignment-')),
  };
  const formativeRows = db.prepare('SELECT id, student_userid, question, answer, created_at FROM formative_escalations ORDER BY created_at DESC').all();
  aiQuestions.formative = summarizeInteractions(formativeRows.map((r) => {
    const student = studentById[r.student_userid];
    return { id: r.id, studentName: student ? student.fullname : `#${r.student_userid}`, question: r.question, answer: r.answer, createdAt: r.created_at };
  }));

  // ---- Leaderboard (same composite scoring as /leaderboard) ----
  const chatByStudent = {};
  db.prepare("SELECT student_userid, COUNT(*) as cnt FROM events WHERE event_type = 'chat_message' GROUP BY student_userid").all()
    .forEach((r) => { chatByStudent[r.student_userid] = r.cnt; });
  const leaderboard = students.map((s) => {
    const pcts = (progressByStudent[s.userid] || []).map((p) => p.pct);
    const avgWatch = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : 0;
    const quizPct = gradeByStudent[s.userid] ?? 0;
    const chatCount = chatByStudent[s.userid] || 0;
    const score = Math.round(avgWatch * 0.4 + quizPct * 0.4 + Math.min(chatCount * 5, 20));
    return { userid: s.userid, fullname: s.fullname, section: s.section || 'Unassigned', score };
  }).sort((a, b) => b.score - a.score);

  const aiQuality = buildAiQualityData();

  return { students, totalStudents, whoNeedsYou, worthRevisiting, lectureVideoChapters, aiQuestions, leaderboard, aiQuality };
}

// Structured, aggregate evidence for the "is the AI grounded and reliable" evaluation
// dimension -- retrieval confidence and citation validity were computed per-response
// already (see /chat) but had nowhere instructors could see them in aggregate until now.
function buildAiQualityData() {
  const rows = db.prepare("SELECT payload FROM events WHERE event_type = 'chat_message'").all();
  const parsed = rows.map((r) => { try { return JSON.parse(r.payload); } catch (e) { return null; } }).filter(Boolean);

  const withConfidence = parsed.filter((p) => typeof p.retrievalConfidence === 'number');
  const avgRetrievalConfidence = withConfidence.length
    ? Math.round((withConfidence.reduce((sum, p) => sum + p.retrievalConfidence, 0) / withConfidence.length) * 100)
    : null;

  const citationEligible = parsed.filter((p) => p.citationValid !== null && p.citationValid !== undefined);
  const citationValidRate = citationEligible.length
    ? Math.round((citationEligible.filter((p) => p.citationValid).length / citationEligible.length) * 100)
    : null;

  const withLatency = parsed.filter((p) => typeof p.latencyMs === 'number');
  const avgLatencyMs = withLatency.length
    ? Math.round(withLatency.reduce((sum, p) => sum + p.latencyMs, 0) / withLatency.length)
    : null;

  const withLanguage = parsed.filter((p) => p.language === 'ar' || p.language === 'en');
  const arabicPct = withLanguage.length
    ? Math.round((withLanguage.filter((p) => p.language === 'ar').length / withLanguage.length) * 100)
    : null;

  const byContentType = {};
  parsed.forEach((p) => {
    const key = p.contentType || 'unknown';
    byContentType[key] = (byContentType[key] || 0) + 1;
  });

  const totalInteractions = parsed.length;
  const errorCount = db.prepare('SELECT COUNT(*) as c FROM ai_errors').get().c;
  const errorRate = (totalInteractions + errorCount) > 0
    ? Math.round((errorCount / (totalInteractions + errorCount)) * 1000) / 10
    : null;

  return {
    totalInteractions, avgRetrievalConfidence, citationValidRate, avgLatencyMs, arabicPct,
    byContentType, errorCount, errorRate,
  };
}

function renderAnalyticsTab(data) {
  const { totalStudents, whoNeedsYou, worthRevisiting, lectureVideoChapters, aiQuestions, leaderboard, students, aiQuality } = data;
  const botTabs = [
    { key: 'course', label: 'Course Tutor' },
    { key: 'video', label: 'Video Ask AI' },
    { key: 'pdf', label: 'PDF Ask AI' },
    { key: 'formative', label: 'Formative Bot' },
    { key: 'assistant', label: 'Assignment Assistant' },
  ];
  const medals = ['🥇', '🥈', '🥉'];
  const contentTypeLabels = { video: 'Video Q&A', pdf: 'PDF Q&A', assignment: 'Assignment Assistant', course: 'Course Ask', unknown: 'Unclassified (legacy)' };

  return `
    <div class="section-block" id="analytics-top">
      <h2>Analytics</h2>
      <p class="desc">Everything below covers every section of this course.</p>
      <div class="analytics-pills">
        <a href="#ai-quality">AI quality</a>
        <a href="#who-needs-you">Who needs you</a>
        <a href="#look-up-student">Look up a student</a>
        <a href="#lecture-videos">Lecture videos</a>
        <a href="#ai-questions">AI questions</a>
        <a href="#leaderboard-section">Leaderboard</a>
      </div>

      <div class="section-block" id="ai-quality" style="margin-top:24px;">
        <h2>AI quality</h2>
        <p class="desc">Structured, aggregate evidence for grounding and reliability — not anecdotal. Based on ${aiQuality.totalInteractions} logged interaction${aiQuality.totalInteractions === 1 ? '' : 's'}.</p>
        <div class="stat-grid">
          <div class="stat-card"><div class="val">${aiQuality.avgRetrievalConfidence !== null ? aiQuality.avgRetrievalConfidence + '%' : '—'}</div><div class="lbl">Avg. retrieval confidence</div><div class="desc" style="margin-top:2px;">cosine similarity of the top-matched excerpt, video/PDF Q&amp;A</div></div>
          <div class="stat-card"><div class="val">${aiQuality.citationValidRate !== null ? aiQuality.citationValidRate + '%' : '—'}</div><div class="lbl">Valid timestamp citation rate</div><div class="desc" style="margin-top:2px;">of responses where a citation was expected</div></div>
          <div class="stat-card"><div class="val">${aiQuality.avgLatencyMs !== null ? (aiQuality.avgLatencyMs / 1000).toFixed(1) + 's' : '—'}</div><div class="lbl">Avg. response latency</div></div>
          <div class="stat-card"><div class="val">${aiQuality.arabicPct !== null ? aiQuality.arabicPct + '%' : '—'}</div><div class="lbl">Questions asked in Arabic</div><div class="desc" style="margin-top:2px;">of the rest in English</div></div>
          <div class="stat-card"><div class="val">${aiQuality.errorRate !== null ? aiQuality.errorRate + '%' : '—'}</div><div class="lbl">AI provider error rate</div><div class="desc" style="margin-top:2px;">${aiQuality.errorCount} failed call${aiQuality.errorCount === 1 ? '' : 's'} logged</div></div>
        </div>
        <div class="app-card" style="margin-top:12px; padding:0;">
          ${Object.entries(aiQuality.byContentType).map(([key, count]) => `
            <div class="chapter-row"><span>${escapeHtml(contentTypeLabels[key] || key)}</span><span style="font-weight:700;">${count}</span></div>
          `).join('') || '<p class="empty" style="padding:12px;">No interactions logged yet.</p>'}
        </div>
      </div>
      <div class="stat-grid">
        <div class="stat-card"><div class="val">${totalStudents}</div><div class="lbl">Students across every section</div></div>
        <div class="stat-card"><div class="val">${whoNeedsYou.length} of ${totalStudents}</div><div class="lbl">Need attention — low quiz accuracy, or active but not completing lectures</div></div>
        <div class="stat-card"><div class="val">${worthRevisiting.length}</div><div class="lbl">Quiz questions worth revisiting</div></div>
      </div>
    </div>

    <div class="section-block" id="who-needs-you">
      <h2>Who needs you</h2>
      <p class="desc">Students showing low quiz accuracy, or activity without finishing lectures. Open one to see their full picture.
        ${whoNeedsYou.length ? '<a href="/analytics/who-needs-you/export.csv" class="btn-mini dismiss" style="text-decoration:none; margin-left:8px;">Export CSV</a>' : ''}</p>
      <div class="app-card">
        ${whoNeedsYou.map((s) => `
          <div class="attn-card">
            <div><div class="nm"><a href="/instructor/student?id=${s.userid}" style="color:inherit;">${escapeHtml(s.fullname)}</a></div><div class="sec">Section ${escapeHtml(s.section)}</div></div>
            <div class="reason">${escapeHtml(s.reason)}</div>
          </div>`).join('') || '<p class="empty">No students need outreach right now.</p>'}
      </div>
    </div>

    <div class="section-block" id="worth-revisiting">
      <h2>What to go over again</h2>
      <p class="desc">Quiz questions students are getting wrong, with the sample size behind each one. Suggestions only — marking one addressed or dismissed just files it out of this list; the quiz itself is unchanged and students see no difference either way.</p>
      ${worthRevisiting.map((q) => `
        <div class="revisit-card">
          <div class="q-top">
            <div><div class="q-title">${escapeHtml(q.question)}</div><div class="q-meta">${escapeHtml(q.lectureTitle)} &middot; ${q.timestampLabel}</div></div>
            ${q.accuracyPct !== null ? `<div class="badge-pct">${q.accuracyPct}% correct</div>` : ''}
          </div>
          <div class="q-msg">${escapeHtml(q.message)}</div>
          <div style="font-size:11px; color:#8a94a6; margin-bottom:8px;">${q.attempts} attempts from ${q.distinctStudents} of ${q.totalStudents} students</div>
          <form method="post" action="/analytics/question/${q.id}/address" style="display:inline;"><button class="btn-mini address" type="submit">Mark addressed</button></form>
          <form method="post" action="/analytics/question/${q.id}/dismiss" style="display:inline;"><button class="btn-mini dismiss" type="submit">Dismiss</button></form>
        </div>`).join('') || '<p class="empty">No questions flagged for review right now.</p>'}
    </div>

    <div class="section-block" id="look-up-student">
      <h2>Look up a student</h2>
      <p class="desc">Search the roster by name or username and jump straight to that student's insight.</p>
      <input class="search-box" id="rosterSearch" type="text" placeholder="Search students by name or username..." oninput="filterRoster()">
      <div class="app-card" id="rosterList" style="max-height:320px; overflow-y:auto;">
        ${students.map((s) => `
          <a href="/instructor/student?id=${s.userid}" class="roster-row" data-name="${escapeHtml((s.fullname + ' ' + s.username).toLowerCase())}" style="color:inherit; text-decoration:none;">
            <div>${escapeHtml(s.fullname)}<div class="em">${escapeHtml(s.username)}</div></div>
            <div class="em">Section ${escapeHtml(s.section || 'Unassigned')}</div>
          </a>`).join('')}
      </div>
    </div>

    <div class="section-block" id="lecture-videos">
      <h2>Lecture videos</h2>
      <p class="desc">Watch funnel and quiz performance per module — open a module for its full analysis, or a single video for its watch funnel, pause/seek segments, and per-section trends.</p>
      <div class="app-card" style="padding:0;">
        ${lectureVideoChapters.map((c) => `
          <div class="chapter-row" style="flex-direction:column; align-items:stretch; gap:8px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <div><div class="ct">${escapeHtml(c.title)}</div><div class="cm">${c.videos.length} video${c.videos.length === 1 ? '' : 's'}</div></div>
              <a href="/instructor/module-analysis?section=${encodeURIComponent(c.key)}" class="btn-mini address" style="text-decoration:none;">Module analysis</a>
            </div>
            <div style="display:flex; flex-direction:column; gap:4px; padding-left:4px;">
              ${c.videos.map((v) => `
                <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; padding:4px 0;">
                  <span style="color:#57606a;">${escapeHtml(v.title)}</span>
                  <a href="/instructor/video-analytics?lecture_id=${encodeURIComponent(v.lecture_id)}" class="btn-mini dismiss" style="text-decoration:none;">Video analytics</a>
                </div>`).join('')}
            </div>
          </div>`).join('') || '<p class="empty" style="padding:12px;">No lecture videos yet.</p>'}
      </div>
    </div>

    <div class="section-block" id="ai-questions">
      <h2>What students asked the AI</h2>
      <p class="desc">Every question put to each assistant, by learning context.</p>
      <div class="bot-tabs">
        ${botTabs.map((b, i) => `<button class="${i === 0 ? 'active' : ''}" onclick="showBotTab('${b.key}', this)">${b.label} <span style="opacity:0.7;">${aiQuestions[b.key].interactions}</span></button>`).join('')}
      </div>
      ${botTabs.map((b, i) => {
        const d = aiQuestions[b.key];
        return `
        <div class="bot-panel ${i === 0 ? 'active' : ''}" id="bot-panel-${b.key}">
          <div class="bot-stat-row">
            <div class="bs"><div class="n">${d.interactions}</div><div class="l">Interactions</div></div>
            <div class="bs"><div class="n">${d.students}</div><div class="l">Students</div></div>
            <div class="bs"><div class="n">${d.repeated}</div><div class="l">Repeated</div></div>
          </div>
          <div class="ai-grid">
            <div>
              <input class="search-box" placeholder="Search student or question..." oninput="filterQa(this, 'qa-${b.key}')">
              <div class="app-card" id="qa-${b.key}" style="max-height:420px; overflow-y:auto;">
                ${d.items.map((it) => `
                  <div class="qa-item" data-name="${escapeHtml((it.studentName + ' ' + it.question).toLowerCase())}">
                    <div class="who">${escapeHtml(it.studentName)}</div>
                    <div class="when">${new Date(it.createdAt).toLocaleString()}</div>
                    <div class="qtext">Q: ${escapeHtml(it.question)}</div>
                    <div class="atext">${escapeHtml((it.answer || '').slice(0, 400))}</div>
                    <form method="post" action="/analytics/interaction/${it.id}/delete" onsubmit="return confirm('Delete this interaction log entry? This cannot be undone.');" style="margin-top:6px;">
                      <input type="hidden" name="category" value="${b.key}">
                      <button type="submit" class="btn-mini dismiss" style="font-size:10px; padding:3px 8px;">Delete</button>
                    </form>
                  </div>`).join('') || '<p class="empty">No interactions yet.</p>'}
              </div>
            </div>
            <div>
              <div class="app-card" style="margin-bottom:12px;">
                <div style="font-weight:700; font-size:12px; margin-bottom:6px;">Student Activity</div>
                ${d.studentActivity.map((sa) => `<div class="side-list-row"><span>${escapeHtml(sa.name)}</span><span style="color:#8a94a6;">&times;${sa.count}</span></div>`).join('') || '<p class="empty">No activity yet.</p>'}
              </div>
              <div class="app-card">
                <div style="font-weight:700; font-size:12px; margin-bottom:6px;">Repeated Questions</div>
                ${d.repeatedQuestions.map((rq) => `<div class="side-list-row"><span>${escapeHtml(rq.text.slice(0, 60))}</span><span>&times;${rq.count}</span></div>`).join('') || '<p class="empty">No repeats yet.</p>'}
              </div>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>

    <div class="section-block" id="leaderboard-section">
      <h2>Leaderboard</h2>
      <p class="desc">Composite ranking — quiz mastery, lecture completion and Q&amp;A participation. An engagement ranking, not an attainment one.</p>
      <div class="app-card">
        ${leaderboard.slice(0, 10).map((s, i) => `
          <div class="lb-row">
            <div class="lb-rank">${medals[i] || '#' + (i + 1)}</div>
            <div class="lb-name">${escapeHtml(s.fullname)}<div class="lb-sec">Section ${escapeHtml(s.section)}</div></div>
            <div class="lb-pts">${s.score} pts</div>
          </div>`).join('') || '<p class="empty">No leaderboard data yet.</p>'}
      </div>
    </div>

    <script>
      function filterRoster() {
        const q = document.getElementById('rosterSearch').value.toLowerCase();
        document.querySelectorAll('#rosterList .roster-row').forEach((row) => {
          row.style.display = row.dataset.name.includes(q) ? '' : 'none';
        });
      }
      function filterQa(input, listId) {
        const q = input.value.toLowerCase();
        document.querySelectorAll('#' + listId + ' .qa-item').forEach((row) => {
          row.style.display = row.dataset.name.includes(q) ? '' : 'none';
        });
      }
      function showBotTab(key, btn) {
        document.querySelectorAll('.bot-tabs button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.bot-panel').forEach((p) => p.classList.remove('active'));
        document.getElementById('bot-panel-' + key).classList.add('active');
      }
    </script>
  `;
}

// Same data the standalone /verifier page shows, reshaped for the "Verification"
// tab inside the instructor dashboard, so it shares the light app theme instead
// of being a jarring dark-themed page reachable only through a forced redirect.
function buildVerificationTabData() {
  const pendingAssignments = db.prepare("SELECT * FROM assignments WHERE status = 'draft' ORDER BY created_at DESC").all();

  const pendingQuizByLecture = db.prepare(
    `SELECT pq.lecture_id, l.title, COUNT(*) as c FROM popup_questions pq
     LEFT JOIN lectures l ON l.lecture_id = pq.lecture_id
     WHERE pq.status = 'pending_review' GROUP BY pq.lecture_id`
  ).all().sort((a, b) => lectureSortKey(a.lecture_id) - lectureSortKey(b.lecture_id));
  const totalPendingQuiz = pendingQuizByLecture.reduce((sum, r) => sum + r.c, 0);

  const openEscalations = db.prepare(
    'SELECT COUNT(*) as c FROM formative_escalations WHERE resolved = 0 AND verifier_reviewed = 0'
  ).get().c;

  const unreviewedSummaries = db.prepare(
    `SELECT ss.session_id, ss.student_userid, se.title as session_title, s.fullname
     FROM session_summaries ss
     LEFT JOIN sessions se ON se.id = ss.session_id
     LEFT JOIN students s ON s.userid = ss.student_userid
     WHERE ss.verifier_reviewed = 0 ORDER BY ss.created_at DESC`
  ).all();

  return { pendingAssignments, pendingQuizByLecture, totalPendingQuiz, openEscalations, unreviewedSummaries };
}

function renderVerificationTab(data) {
  const { pendingAssignments, pendingQuizByLecture, totalPendingQuiz, openEscalations, unreviewedSummaries } = data;
  return `
    <p class="app-sub">Review, edit, and approve assignment briefs and auto-generated quiz questions before they go live to students.</p>

    <div class="section-block">
      <h2>Pending assignment review ${pendingAssignments.length ? `<span class="tag warn">${pendingAssignments.length}</span>` : ''}</h2>
      <p class="desc">${pendingAssignments.length} assignment${pendingAssignments.length === 1 ? '' : 's'} waiting on your review.</p>
      <div class="app-card" style="padding:0;">
        ${pendingAssignments.map((a) => `
          <div class="chapter-row">
            <div><div class="ct">${escapeHtml(a.title || 'Untitled Assignment')}</div><div class="cm">Due ${a.due_date ? new Date(a.due_date).toLocaleDateString() : 'No due date'}</div></div>
            <div style="display:flex; gap:8px;">
              <a href="/assignments/${a.id}/rubric" class="btn-mini dismiss" style="text-decoration:none;">Open</a>
              <form method="post" action="/assignments/${a.id}/approve" style="display:inline;">
                <button type="submit" class="btn-mini address">Approve &amp; publish</button>
              </form>
            </div>
          </div>`).join('') || '<p class="empty" style="padding:12px;">Nothing pending right now.</p>'}
      </div>
    </div>

    <div class="section-block">
      <h2>Draft quiz questions awaiting approval ${totalPendingQuiz ? `<span class="tag warn">${totalPendingQuiz}</span>` : ''}</h2>
      <div class="app-card" style="padding:0;">
        ${pendingQuizByLecture.map((r) => `
          <div class="chapter-row">
            <span>${escapeHtml(r.title || r.lecture_id)}</span>
            <a href="/quiz/review?lecture=${encodeURIComponent(r.lecture_id)}" class="btn-mini dismiss" style="text-decoration:none;">Review (${r.c})</a>
          </div>`).join('') || '<p class="empty" style="padding:12px;">Nothing pending.</p>'}
      </div>
    </div>

    <div class="section-block">
      <h2>Formative Bot escalations ${openEscalations ? `<span class="tag warn">${openEscalations}</span>` : ''}</h2>
      <div class="app-card">
        <a href="/formative/escalations" style="color:#d41128; font-weight:700; font-size:13px; text-decoration:none;">Review students who may still be stuck &rarr;</a>
        ${!openEscalations ? '<p class="empty" style="margin-top:8px;">No open escalations right now.</p>' : ''}
      </div>
    </div>

    <div class="section-block">
      <h2>Pre-session summaries awaiting review ${unreviewedSummaries.length ? `<span class="tag warn">${unreviewedSummaries.length}</span>` : ''}</h2>
      <div class="app-card" style="padding:0;">
        ${unreviewedSummaries.map((r) => `
          <div class="chapter-row">
            <a href="/sessions/${r.session_id}/summary?student=${r.student_userid}" style="color:inherit; text-decoration:none;">${escapeHtml(r.fullname || 'Unknown')} &mdash; ${escapeHtml(r.session_title || '')}</a>
          </div>`).join('') || '<p class="empty" style="padding:12px;">Nothing pending.</p>'}
      </div>
    </div>
  `;
}

// Per-student x per-chapter completion matrix, plus quiz accuracy -- a native
// equivalent of Criterio's own "Activity Completion Report", built fresh against
// this app's SQLite/events model rather than ported line-for-line.
function buildActivityCompletionData(sectionFilter) {
  const videoLectures = db.prepare('SELECT * FROM lectures').all().filter((l) => !l.lecture_id.startsWith('pdf-'));
  const chapterKeys = [...new Set(videoLectures.map((l) => chapterSectionKeyOf(l.lecture_id)))]
    .sort((a, b) => (parseInt(a.replace('week', ''), 10) || 0) - (parseInt(b.replace('week', ''), 10) || 0));
  const chapters = chapterKeys.map((key) => ({ key, title: CHAPTER_SECTION_TITLES[key] || key }));

  const videosByChapter = {};
  videoLectures.forEach((l) => {
    const key = chapterSectionKeyOf(l.lecture_id);
    (videosByChapter[key] ||= []).push(l.lecture_id);
  });

  const pctByStudentLecture = {};
  db.prepare(
    `SELECT student_userid, lecture_id, MAX(position) as maxpos, MAX(duration) as dur
     FROM events WHERE event_type IN ('heartbeat', 'pause', 'ended', 'seek') AND position IS NOT NULL
     GROUP BY student_userid, lecture_id`
  ).all().forEach((r) => {
    if (!r.dur) return;
    pctByStudentLecture[`${r.student_userid}:${r.lecture_id}`] = Math.min(100, Math.round((r.maxpos / r.dur) * 100));
  });
  function watchedPercentFor(studentId, chapterKey) {
    const videoIds = videosByChapter[chapterKey] || [];
    return videoIds.length
      ? Math.round(videoIds.reduce((sum, id) => sum + (pctByStudentLecture[`${studentId}:${id}`] || 0), 0) / videoIds.length)
      : 0;
  }

  const responseRows = db.prepare("SELECT student_userid, popup_question_id, status FROM popup_responses WHERE status != 'dropped'").all();

  const allStudents = db.prepare("SELECT * FROM students WHERE role = 'student'").all();
  const sections = [...new Set(allStudents.map((s) => s.section || 'Unassigned'))].sort();
  const students = sectionFilter ? allStudents.filter((s) => (s.section || 'Unassigned') === sectionFilter) : allStudents;

  const rows = students.map((s) => {
    const chapterCells = chapters.map((c) => ({ key: c.key, watchedPercent: watchedPercentFor(s.userid, c.key) }));
    const overallPercent = chapterCells.length
      ? Math.round(chapterCells.reduce((sum, c) => sum + c.watchedPercent, 0) / chapterCells.length)
      : 0;
    const myResponses = responseRows.filter((r) => r.student_userid === s.userid);
    const quizAttempted = myResponses.length;
    const quizCorrect = myResponses.filter((r) => r.status === 'answered_correct').length;
    const quizAccuracyPercent = quizAttempted ? Math.round((quizCorrect / quizAttempted) * 100) : null;
    const completedChapters = chapterCells.filter((c) => c.watchedPercent >= 90).length;
    return {
      userid: s.userid, fullname: s.fullname, username: s.username,
      section: s.section || 'Unassigned',
      chapterCells, overallPercent, quizAttempted, quizCorrect, quizAccuracyPercent, completedChapters,
    };
  }).sort((a, b) => a.fullname.localeCompare(b.fullname));

  return { chapters, sections, rows };
}

function renderReportsTab(data, currentSectionFilter) {
  const { chapters, sections, rows } = data;
  const avgOverall = rows.length ? Math.round(rows.reduce((sum, r) => sum + r.overallPercent, 0) / rows.length) : 0;
  const fullyCompleted = rows.filter((r) => r.completedChapters === chapters.length && chapters.length > 0).length;

  return `
    <div class="section-block">
      <h2>Activity Completion Report</h2>
      <p class="desc">Per-student completion across every chapter, plus quiz accuracy. A chapter counts as complete at 90%+ average watch time across its videos.
        ${rows.length ? `<a href="/reports/activity-completion/export.csv${currentSectionFilter ? '?section=' + encodeURIComponent(currentSectionFilter) : ''}" class="btn-mini dismiss" style="text-decoration:none; margin-left:8px;">Export CSV</a>` : ''}</p>

      <div class="stat-grid" style="margin-bottom:14px;">
        <div class="stat-card"><div class="val">${rows.length}</div><div class="lbl">Students${currentSectionFilter ? ' in ' + escapeHtml(currentSectionFilter) : ''}</div></div>
        <div class="stat-card"><div class="val">${avgOverall}%</div><div class="lbl">Avg. overall completion</div></div>
        <div class="stat-card"><div class="val">${fullyCompleted}</div><div class="lbl">Completed every chapter</div></div>
      </div>

      <select onchange="location.href='/app/instructor?tab=reports' + (this.value ? '&section=' + encodeURIComponent(this.value) : '')" style="padding:7px 10px; border:1px solid #e2e8f0; border-radius:8px; font-size:12px; margin-bottom:12px;">
        <option value="">All sections</option>
        ${sections.map((s) => `<option value="${escapeHtml(s)}" ${currentSectionFilter === s ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
      </select>

      <div class="app-card" style="padding:0; overflow-x:auto;">
        <table class="perf-table">
          <thead><tr>
            <th>Student</th><th>Section</th>
            ${chapters.map((c) => `<th>${escapeHtml(c.title.length > 18 ? c.key : c.title)}</th>`).join('')}
            <th>Overall</th><th>Quiz accuracy</th>
          </tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td><a href="/instructor/student?id=${r.userid}" style="color:inherit;">${escapeHtml(r.fullname)}</a></td>
                <td>${escapeHtml(r.section)}</td>
                ${r.chapterCells.map((c) => `<td style="color:${c.watchedPercent >= 90 ? '#1f9d55' : c.watchedPercent > 0 ? '#946200' : '#8a94a6'};">${c.watchedPercent}%</td>`).join('')}
                <td style="font-weight:700;">${r.overallPercent}%</td>
                <td>${r.quizAccuracyPercent !== null ? r.quizAccuracyPercent + '% (' + r.quizCorrect + '/' + r.quizAttempted + ')' : '—'}</td>
              </tr>`).join('') || `<tr><td colspan="${chapters.length + 4}" class="empty" style="padding:14px;">No students${currentSectionFilter ? ' in this section' : ''} yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

app.get('/reports/activity-completion/export.csv', requireInstructor, (req, res) => {
  const { chapters, rows } = buildActivityCompletionData(req.query.section || null);
  const header = ['Name', 'Username', 'Section', ...chapters.map((c) => c.title), 'Overall %', 'Quiz Correct', 'Quiz Attempted', 'Quiz Accuracy %'];
  const lines = [header.join(',')];
  rows.forEach((r) => {
    const line = [
      r.fullname, r.username, r.section,
      ...r.chapterCells.map((c) => c.watchedPercent),
      r.overallPercent, r.quizCorrect, r.quizAttempted, r.quizAccuracyPercent ?? '',
    ].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
    lines.push(line);
  });
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', 'attachment; filename="activity-completion-report.csv"');
  res.send(lines.join('\n'));
});

// Scoped deletion of a single AI-interaction log entry (chat_message event, or a
// formative-bot escalation) -- an instructor removing one bad/test/privacy-flagged
// entry without wiping the whole log.
app.post('/analytics/interaction/:id/delete', requireInstructor, express.urlencoded({ extended: true }), (req, res) => {
  if (req.body.category === 'formative') {
    db.prepare('DELETE FROM formative_escalations WHERE id = ?').run(req.params.id);
  } else {
    db.prepare("DELETE FROM events WHERE id = ? AND event_type = 'chat_message'").run(req.params.id);
  }
  res.redirect('/app/instructor?tab=analytics#ai-questions');
});

app.get('/app/instructor', (req, res) => {
  // This is a direct embed target from Moodle's bare iframe src (no ?student=
  // or ?t= on first load) -- unlike every other instructor route, it has to
  // run the identify handshake itself before any role check can apply, since
  // there's no earlier page in the flow that could have already set the
  // session cookie. Once identified (verifiedUserId set, via the reload this
  // triggers), the role check below runs like every other instructor route.
  //
  // A bare embed (no ?tab=) always forces a fresh handshake instead of
  // trusting an already-set identity cookie -- otherwise a stale cookie left
  // over from a different account earlier in the same browser (still valid
  // for up to 8h) gets trusted over the Moodle user who just loaded the
  // dashboard, and that other account's role gets checked instead of theirs
  // (confirmed live: an instructor's own dashboard embed was rejected because
  // a leftover student session took precedence). Tab navigation within the
  // app (?tab=...) still relies on the cookie as before.
  const isBareEmbed = !req.query.tab;
  if (!req.verifiedUserId || (isBareEmbed && !req.query.t)) {
    return res.set('Content-Type', 'text/html').send(`<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
  ${APP_IDENTIFY_SCRIPT}
  function onIdentified(userId, token) {
    if (!token) return;
    location.href = '/app/instructor?t=' + encodeURIComponent(token) + '${req.query.tab ? '&tab=' + encodeURIComponent(req.query.tab) : ''}';
  }
</script>
</body></html>`);
  }
  const viewerRole = db.prepare('SELECT role FROM students WHERE userid = ?').get(req.verifiedUserId);
  if (!viewerRole || !hasCapability(viewerRole.role, 'view_dashboard')) {
    return res.status(403).send('Instructor access only. Open this from your Moodle course as a course instructor.');
  }

  const teacherRow = db.prepare("SELECT userid FROM students WHERE username = 'teacher1'").get();
  // A launch through the standalone "Rennix Analytics" LTI product only ever
  // bought analytics/attendance -- not the chat/quiz-authoring tools that
  // live under Content, which belong to the separate "Rennix Tutor Bot"
  // product. req.ltiProduct is null for the legacy Moodle-native path (and
  // for the bundled "tutor_bot" product), which keeps full access exactly
  // as it's always worked -- this restriction only ever narrows, never
  // widens, what a given login already sees.
  const isAnalyticsOnly = req.ltiProduct === 'analytics';
  // Verification (assignment/quiz QA) is analytics-tier oversight, not content
  // authoring -- unlike Content, it stays available on an analytics-only launch.
  const showVerification = hasCapability(viewerRole.role, 'verify_content');
  const availableTabs = [
    'overview',
    ...(isAnalyticsOnly ? [] : ['content']),
    'analytics',
    'attendance',
    'reports',
    ...(showVerification ? ['verification'] : []),
  ];
  const tab = availableTabs.includes(req.query.tab) ? req.query.tab : 'overview';
  const branding = getBranding();

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Instructor Analytics — Criterio</title>
<style>
  ${APP_SHELL_STYLES}
  .instr-nav { display:flex; align-items:center; gap:16px; padding:14px 32px; background:#fff; border-bottom:1px solid #e2e8f0; }
  .instr-nav .brand { display:flex; align-items:center; gap:8px; font-weight:700; font-size:16px; }
  .instr-nav .brand .htu { color:#d41128; font-weight:800; }
  .instr-nav .badge { background:#1f2937; color:#fff; font-size:11px; font-weight:700; padding:3px 10px; border-radius:20px; }
  .section-block { margin-top:32px; }
  .section-block h2 { font-size:16px; font-weight:800; margin-bottom:2px; }
  .section-block p.desc { color:#57606a; font-size:13px; margin:0 0 14px; }
  .perf-row { display:flex; align-items:center; gap:12px; padding:12px 14px; }
  .perf-row + .perf-row { border-top:1px solid #eef1f4; }
  .perf-rank { width:26px; font-weight:800; color:#8a94a6; text-align:center; }
  .perf-rank.top1 { color:#d41128; }
  .perf-name { flex:1; font-weight:700; font-size:14px; }
  .perf-name a { color:inherit; }
  .perf-sub { color:#57606a; font-size:12px; margin-top:2px; font-weight:400; }
  .perf-score { background:#fdecee; color:#a10f22; font-weight:800; font-size:13px; padding:5px 12px; border-radius:8px; min-width:34px; text-align:center; }
  .bar-track { flex:0 0 90px; height:6px; background:#eef1f4; border-radius:3px; overflow:hidden; }
  .bar-fill { height:100%; background:#d41128; }
  table.perf-table { width:100%; border-collapse:collapse; font-size:13px; }
  table.perf-table th { text-align:left; color:#8a94a6; font-weight:700; font-size:11px; text-transform:uppercase; padding:8px 12px; border-bottom:1px solid #eef1f4; }
  table.perf-table td { padding:10px 12px; border-bottom:1px solid #f2f4f7; }
  table.perf-table tr:last-child td { border-bottom:none; }
  .tag { display:inline-block; background:#eef1f4; color:#57606a; border-radius:6px; padding:2px 8px; font-size:11px; font-weight:600; }
  .tag.warn { background:#fdecee; color:#a10f22; }
  .asked-row { display:flex; align-items:center; gap:12px; padding:10px 0; }
  .asked-row + .asked-row { border-top:1px solid #eef1f4; }
  .asked-rank { width:22px; color:#8a94a6; font-weight:800; font-size:12px; }
  .asked-q { flex:1; font-size:13px; font-weight:600; }
  .asked-meta { color:#8a94a6; font-size:11px; margin-top:2px; }
  .asked-count { background:#eef1f4; border-radius:8px; padding:4px 10px; font-size:12px; font-weight:700; color:#333; }
  .stat-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; }
  .stat-card { background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:14px 16px; }
  .stat-card .val { font-size:22px; font-weight:800; color:#1a1a1a; }
  .stat-card .lbl { font-size:12px; color:#57606a; margin-top:2px; }
  .breakdown-row { display:flex; justify-content:space-between; font-size:13px; padding:6px 0; }
  .breakdown-row + .breakdown-row { border-top:1px solid #f2f4f7; }
  .tab-bar { display:flex; flex-wrap:wrap; row-gap:8px; gap:24px; border-bottom:1px solid #e2e8f0; margin:12px 0 20px; }
  .tab-link { color:#57606a; font-weight:700; font-size:13px; text-decoration:none; padding:0 0 12px; border-bottom:2px solid transparent; }
  .tab-link.active { color:#d41128; border-bottom-color:#d41128; }
  .analytics-pills { display:flex; gap:8px; flex-wrap:wrap; margin:14px 0 20px; }
  .analytics-pills a { background:#eef1f4; color:#333; font-size:12px; font-weight:700; padding:7px 14px; border-radius:20px; text-decoration:none; }
  .attn-card { border-left:3px solid #d41128; background:#fff; border:1px solid #e2e8f0; border-radius:8px; padding:10px 14px; margin-bottom:8px; display:flex; justify-content:space-between; gap:12px; align-items:center; }
  .attn-card .nm { font-weight:700; font-size:13px; }
  .attn-card .sec { color:#8a94a6; font-size:11px; }
  .attn-card .reason { color:#57606a; font-size:12px; text-align:right; max-width:340px; }
  .revisit-card { background:#fff; border:1px solid #e2e8f0; border-radius:8px; padding:12px 14px; margin-bottom:10px; }
  .revisit-card .q-top { display:flex; justify-content:space-between; gap:10px; align-items:flex-start; }
  .revisit-card .q-title { font-weight:700; font-size:14px; }
  .revisit-card .q-meta { color:#8a94a6; font-size:12px; margin-top:2px; }
  .revisit-card .q-msg { background:#f7f8fa; border-radius:6px; padding:8px 10px; font-size:12px; color:#57606a; margin:8px 0; }
  .badge-pct { background:#fdf6e3; color:#946200; font-weight:700; font-size:11px; padding:3px 10px; border-radius:20px; white-space:nowrap; }
  .btn-mini { border:none; border-radius:6px; padding:6px 12px; font-size:12px; font-weight:700; cursor:pointer; display:inline-block; }
  .btn-mini.address { background:#1f9d55; color:#fff; }
  .btn-mini.dismiss { background:#eef1f4; color:#57606a; margin-left:6px; }
  .search-box { width:100%; padding:8px 12px; border:1px solid #e2e8f0; border-radius:8px; font-size:13px; margin-bottom:10px; box-sizing:border-box; }
  .roster-row { display:flex; justify-content:space-between; padding:8px 4px; font-size:13px; }
  .roster-row + .roster-row { border-top:1px solid #f2f4f7; }
  .roster-row .em { color:#8a94a6; font-size:11px; }
  .chapter-row { display:flex; align-items:center; justify-content:space-between; padding:12px 14px; }
  .chapter-row + .chapter-row { border-top:1px solid #eef1f4; }
  .chapter-row .ct { font-weight:700; font-size:13px; }
  .chapter-row .cm { color:#8a94a6; font-size:12px; }
  .bot-tabs { display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap; }
  .bot-tabs button { border:none; background:#eef1f4; color:#333; font-weight:700; font-size:12px; padding:8px 14px; border-radius:20px; cursor:pointer; }
  .bot-tabs button.active { background:#d41128; color:#fff; }
  .bot-panel { display:none; }
  .bot-panel.active { display:block; }
  .bot-stat-row { display:flex; gap:12px; margin-bottom:14px; }
  .bot-stat-row .bs { background:#f7f8fa; border-radius:8px; padding:10px 16px; text-align:center; flex:1; }
  .bot-stat-row .bs .n { font-size:18px; font-weight:800; }
  .bot-stat-row .bs .l { font-size:11px; color:#8a94a6; }
  .ai-grid { display:grid; grid-template-columns:2fr 1fr; gap:16px; }
  .qa-item { border-bottom:1px solid #f2f4f7; padding:10px 0; }
  .qa-item .who { font-weight:700; font-size:12px; }
  .qa-item .when { color:#8a94a6; font-size:11px; }
  .qa-item .qtext { color:#a10f22; font-size:13px; margin-top:4px; }
  .qa-item .atext { font-size:12px; color:#57606a; margin-top:4px; }
  .side-list-row { display:flex; justify-content:space-between; font-size:12px; padding:6px 0; }
  .side-list-row + .side-list-row { border-top:1px solid #f2f4f7; }
  .lb-row { display:flex; align-items:center; gap:10px; padding:9px 0; }
  .lb-row + .lb-row { border-top:1px solid #f2f4f7; }
  .lb-rank { width:24px; font-weight:800; color:#8a94a6; }
  .lb-name { flex:1; font-weight:700; font-size:13px; }
  .lb-sec { color:#8a94a6; font-size:11px; }
  .lb-pts { font-weight:800; color:#d41128; }
  .ov-pills { display:flex; gap:6px; flex-wrap:wrap; margin:10px 0 14px; }
  .ov-pills button { border:none; background:#eef1f4; color:#333; font-weight:700; font-size:12px; padding:7px 14px; border-radius:20px; cursor:pointer; }
  .ov-pills button.active { background:#d41128; color:#fff; }
  .ov-section-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:14px; }
  .ov-section-card { background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:16px; }
  .ov-section-top { display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .ov-section-name { font-weight:800; font-size:14px; }
  .ov-badge { font-size:10px; font-weight:700; padding:3px 9px; border-radius:20px; white-space:nowrap; }
  .ov-badge.success { background:#e3f6ea; color:#1f9d55; }
  .ov-badge.warn { background:#fdf6e3; color:#946200; }
  .ov-section-instructor { color:#8a94a6; font-size:12px; margin-top:2px; }
  .ov-section-stats { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:14px; }
  .ov-stat-lbl { color:#8a94a6; font-size:11px; }
  .ov-stat-val { font-weight:700; font-size:13px; margin-top:1px; }
  .content-chapter { padding:14px; }
  .content-chapter + .content-chapter { border-top:1px solid #eef1f4; }
  .content-chapter-head { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
  .content-chapter-videos { margin-top:10px; }
  .content-video-row { display:flex; justify-content:space-between; align-items:center; padding:6px 0; font-size:12px; }
  .content-video-row + .content-video-row { border-top:1px solid #f7f8fa; }
  .risk-critical { background:#fdecee; color:#a10f22; font-weight:700; font-size:11px; padding:3px 10px; border-radius:20px; white-space:nowrap; }
</style></head>
<body>
  ${FRAMED_EMBED_SCRIPT}
  <div class="app-topbar"></div>
  <div class="instr-nav">
    <div class="brand" title="${escapeHtml(branding.schoolName)}"><span class="htu">${escapeHtml(branding.schoolShort)}</span> | Criterio</div>
    <div style="flex:1;"></div>
    <span class="instr-badge tag">${escapeHtml(branding.courseFull)}</span>
    <span class="instr-nav badge" style="padding:6px 0;">Instructor</span>
  </div>
  <div class="app-main">
    <div class="app-h1">${escapeHtml(branding.courseFull)}</div>
    <div class="tab-bar">
      <a class="tab-link ${tab === 'overview' ? 'active' : ''}" href="/app/instructor?tab=overview">Overview</a>
      ${isAnalyticsOnly ? '' : `<a class="tab-link ${tab === 'content' ? 'active' : ''}" href="/app/instructor?tab=content">Content</a>`}
      <a class="tab-link ${tab === 'analytics' ? 'active' : ''}" href="/app/instructor?tab=analytics">Analytics</a>
      <a class="tab-link ${tab === 'attendance' ? 'active' : ''}" href="/app/instructor?tab=attendance">Attendance</a>
      <a class="tab-link ${tab === 'reports' ? 'active' : ''}" href="/app/instructor?tab=reports">Reports</a>
      ${showVerification ? `<a class="tab-link ${tab === 'verification' ? 'active' : ''}" href="/app/instructor?tab=verification">Verification</a>` : ''}
    </div>

    ${tab === 'overview' ? `
    <p class="app-sub">Overview across all sections — switch sections below to drill into one.</p>
    ${teacherRow ? `<p><a href="/sessions?as=${teacherRow.userid}" style="color:#d41128; font-weight:700; font-size:13px;">Manage Formative Sessions &amp; Smart Invite &rarr;</a></p>` : ''}

    ${renderCourseOverviewSection(buildCourseSupervisorOverview())}
    ` : ''}

    ${tab === 'content' ? renderContentTab(buildContentTabData()) : ''}

    ${tab === 'analytics' ? renderAnalyticsTab(buildAnalyticsTabData()) : ''}

    ${tab === 'attendance' ? renderAttendanceTab(buildAttendanceData(req.query.section || null), req.query.section || null) : ''}

    ${tab === 'reports' ? renderReportsTab(buildActivityCompletionData(req.query.section || null), req.query.section || null) : ''}

    ${tab === 'verification' && showVerification ? renderVerificationTab(buildVerificationTabData()) : ''}
  </div>
</body></html>`);
});

// Bulk roster import, adapted from the real Criterio product's "Import
// students" admin feature (bulkImportStudents.ts): pick a section, paste or
// upload a roster as `identifier,Full Name` per line, one row per student.
// Real Criterio also creates brand-new Supabase accounts with a generated
// temp password for rows that don't exist yet -- that doesn't map onto this
// system, since tutor-service doesn't own student auth (Moodle does), and
// generating/displaying credentials isn't something to automate silently.
// This version only assigns EXISTING students (already synced from Moodle
// via /students/sync) to the chosen section; unmatched rows are reported so
// the instructor knows who still needs to be synced first.
app.post('/content/import-students', requireInstructor, express.urlencoded({ extended: true, limit: '2mb' }), (req, res) => {
  const sectionKey = req.body.section;
  const section = db.prepare('SELECT * FROM course_sections WHERE key = ?').get(sectionKey);
  if (!section) return res.status(400).send('Unknown section.');

  const raw = req.body.roster || '';
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const results = lines.map((line) => {
    const parts = line.split(',').map((p) => p.trim());
    const rawIdentifier = parts[0] || '';
    const identifier = rawIdentifier.split('@')[0].toLowerCase();
    if (!identifier) return null;
    const student = db.prepare("SELECT * FROM students WHERE role = 'student' AND LOWER(username) = ?").get(identifier);
    if (!student) return { identifier: rawIdentifier, fullName: parts[1] || '', status: 'not_found' };
    const alreadyInSection = student.section === sectionKey;
    db.prepare('UPDATE students SET section = ? WHERE userid = ?').run(sectionKey, student.userid);
    return { identifier: rawIdentifier, fullName: student.fullname, status: alreadyInSection ? 'already_in_section' : 'assigned' };
  }).filter(Boolean);

  const assignedCount = results.filter((r) => r.status === 'assigned').length;
  const alreadyCount = results.filter((r) => r.status === 'already_in_section').length;
  const notFound = results.filter((r) => r.status === 'not_found');

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Import Students — ${escapeHtml(section.title)}</title>
<style>
  ${APP_SHELL_STYLES}
  .back { display:inline-block; margin-bottom:14px; color:#d41128; font-weight:700; font-size:13px; text-decoration:none; }
  .section-block { margin-top:32px; }
  .section-block h2 { font-size:16px; font-weight:800; margin-bottom:2px; }
  table.perf-table { width:100%; border-collapse:collapse; font-size:13px; }
  table.perf-table th { text-align:left; color:#8a94a6; font-weight:700; font-size:11px; text-transform:uppercase; padding:8px 12px; border-bottom:1px solid #eef1f4; }
  table.perf-table td { padding:10px 12px; border-bottom:1px solid #f2f4f7; }
  table.perf-table tr:last-child td { border-bottom:none; }
  .tag { display:inline-block; background:#eef1f4; color:#57606a; border-radius:6px; padding:2px 8px; font-size:11px; font-weight:600; }
  .tag.warn { background:#fdecee; color:#a10f22; }
  .tag.ok { background:#e3f6ea; color:#1f9d55; }
</style></head>
<body>
  <div class="app-main">
    <a class="back" href="/app/instructor?tab=content">&larr; Back to Content</a>
    <div class="app-h1">Import results — ${escapeHtml(section.title)}</div>
    <p class="app-sub">${assignedCount} assigned &middot; ${alreadyCount} already in this section &middot; ${notFound.length} not found</p>

    ${notFound.length ? `
    <div class="section-block">
      <h2>Not found</h2>
      <p class="desc">These usernames don't exist yet in tutor-service. Sync them from Moodle first, then re-run this import.</p>
      <div class="app-card" style="padding:0;">
        <table class="perf-table">
          <thead><tr><th>Identifier</th><th>Full name (from file)</th></tr></thead>
          <tbody>
            ${notFound.map((r) => `<tr><td>${escapeHtml(r.identifier)}</td><td>${escapeHtml(r.fullName)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}

    <div class="section-block">
      <h2>All rows</h2>
      <div class="app-card" style="padding:0;">
        <table class="perf-table">
          <thead><tr><th>Identifier</th><th>Name</th><th>Result</th></tr></thead>
          <tbody>
            ${results.map((r) => `
              <tr>
                <td>${escapeHtml(r.identifier)}</td>
                <td>${escapeHtml(r.fullName)}</td>
                <td><span class="tag ${r.status === 'not_found' ? 'warn' : 'ok'}">${r.status.replace(/_/g, ' ')}</span></td>
              </tr>`).join('') || '<tr><td colspan="3" class="empty" style="padding:12px;">No rows parsed.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  </div>
</body></html>`);
});

app.post('/content/guidelines', requireInstructor, express.urlencoded({ extended: true }), (req, res) => {
  setCourseSetting('guidelines_markdown', req.body.guidelines || '');
  res.redirect('/app/instructor?tab=content');
});

app.post('/content/guide-policy', requireInstructor, express.urlencoded({ extended: true }), (req, res) => {
  setCourseSetting('guide_never_direct_answer', req.body.never_direct_answer === '1' ? '1' : '0');
  const attempts = parseInt(req.body.attempts_before_direct, 10);
  setCourseSetting('guide_attempts_before_direct', String(Number.isFinite(attempts) && attempts > 0 ? attempts : GUIDE_MODE_DEFAULTS.attemptsBeforeDirect));
  res.redirect('/app/instructor?tab=content');
});

app.post('/content/tutor-guidance', requireInstructor, express.urlencoded({ extended: true }), (req, res) => {
  setCourseSetting('tutor_bot_guidance', (req.body.guidance || '').slice(0, 4000));
  res.redirect('/app/instructor?tab=content');
});

app.post('/content/tutor-knowledge/add', requireInstructor, express.urlencoded({ extended: true, limit: '6mb' }), (req, res) => {
  const title = (req.body.title || '').trim();
  const contentText = (req.body.content_text || '').trim();
  if (!title || !contentText) return res.status(400).send('title and content_text are required.');
  db.prepare('INSERT INTO tutor_knowledge_sources (title, content_text, created_at) VALUES (?, ?, ?)')
    .run(title.slice(0, 200), contentText.slice(0, 200000), Date.now());
  res.redirect('/app/instructor?tab=content');
});

app.post('/content/tutor-knowledge/:id/delete', requireInstructor, express.urlencoded({ extended: true }), (req, res) => {
  db.prepare('DELETE FROM tutor_knowledge_sources WHERE id = ?').run(req.params.id);
  res.redirect('/app/instructor?tab=content');
});

app.post('/content/escalations/:id/resolve', requireInstructor, express.urlencoded({ extended: true }), (req, res) => {
  const resolved = req.body.resolved === '1' ? 1 : 0;
  db.prepare('UPDATE formative_escalations SET resolved = ? WHERE id = ?').run(resolved, req.params.id);
  res.redirect('/app/instructor?tab=content');
});

app.post('/content/chapter/:key/visibility', requireInstructor, express.urlencoded({ extended: true }), (req, res) => {
  const visible = req.body.visible === '1' ? 1 : 0;
  const existing = getChapterSetting(req.params.key);
  db.prepare(
    'INSERT INTO chapter_settings (key, due_date, visible) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET visible = excluded.visible'
  ).run(req.params.key, existing.due_date, visible);
  res.redirect('/app/instructor?tab=content');
});

app.post('/content/chapter/:key/due-date', requireInstructor, express.urlencoded({ extended: true }), (req, res) => {
  const dueDate = req.body.due_date ? new Date(req.body.due_date + 'T00:00:00Z').getTime() : null;
  const existing = getChapterSetting(req.params.key);
  db.prepare(
    'INSERT INTO chapter_settings (key, due_date, visible) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET due_date = excluded.due_date'
  ).run(req.params.key, dueDate, existing.visible);
  res.redirect('/app/instructor?tab=content');
});

app.get('/instructor/roster', requireInstructor, (req, res) => {
  const key = req.query.section;
  const section = db.prepare('SELECT * FROM course_sections WHERE key = ?').get(key);
  if (!section) return res.status(404).send('Unknown section');
  const students = db.prepare("SELECT * FROM students WHERE role = 'student' AND section = ? ORDER BY fullname").all(key);

  const chatByStudent = {};
  db.prepare("SELECT student_userid, COUNT(*) as cnt FROM events WHERE event_type = 'chat_message' GROUP BY student_userid").all()
    .forEach((r) => { chatByStudent[r.student_userid] = r.cnt; });
  const progressByStudent = {};
  db.prepare(
    `SELECT student_userid, lecture_id, MAX(position) as maxpos, MAX(duration) as dur
     FROM events WHERE event_type IN ('heartbeat', 'pause', 'ended', 'seek') AND position IS NOT NULL
     GROUP BY student_userid, lecture_id`
  ).all().forEach((r) => {
    if (r.dur) (progressByStudent[r.student_userid] ||= []).push(Math.min(100, (r.maxpos / r.dur) * 100));
  });

  const instructor = section.instructor_userid ? db.prepare('SELECT fullname FROM students WHERE userid = ?').get(section.instructor_userid) : null;

  const rows = students.map((s) => {
    const pcts = progressByStudent[s.userid] || [];
    const avgWatch = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : 0;
    const participation = pcts.length === 0 && !chatByStudent[s.userid] ? 'Not started' : avgWatch >= 50 ? 'Active' : 'Low activity';
    return { ...s, avgWatch, chatCount: chatByStudent[s.userid] || 0, participation };
  });

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(section.title)} Roster</title>
<style>
  ${APP_SHELL_STYLES}
  .back { display:inline-block; margin-bottom:14px; color:#d41128; font-weight:700; font-size:13px; text-decoration:none; }
  table.perf-table { width:100%; border-collapse:collapse; font-size:13px; }
  table.perf-table th { text-align:left; color:#8a94a6; font-weight:700; font-size:11px; text-transform:uppercase; padding:8px 12px; border-bottom:1px solid #eef1f4; }
  table.perf-table td { padding:10px 12px; border-bottom:1px solid #f2f4f7; }
  table.perf-table tr:last-child td { border-bottom:none; }
  .tag { display:inline-block; background:#eef1f4; color:#57606a; border-radius:6px; padding:2px 8px; font-size:11px; font-weight:600; }
  .tag.warn { background:#fdecee; color:#a10f22; }
</style></head>
<body>
  <div class="app-main">
    <a class="back" href="/app/instructor?tab=content">&larr; Back to Content</a>
    <div class="app-h1">${escapeHtml(section.title)} — Roster</div>
    <p class="app-sub">${rows.length} enrolled student${rows.length === 1 ? '' : 's'} &middot; ${instructor ? escapeHtml(instructor.fullname) : 'No instructor assigned'}</p>
    <div class="app-card" style="padding:0;">
      <table class="perf-table">
        <thead><tr><th>Student</th><th>Username</th><th>Avg. watched</th><th>Chat msgs</th><th>Participation</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td style="font-weight:700;"><a href="/instructor/student?id=${r.userid}" style="color:inherit;">${escapeHtml(r.fullname)}</a></td>
              <td>${escapeHtml(r.username)}</td>
              <td>${r.avgWatch}%</td>
              <td>${r.chatCount}</td>
              <td><span class="tag ${r.participation === 'Not started' ? 'warn' : ''}">${r.participation}</span></td>
            </tr>`).join('') || '<tr><td colspan="5" class="empty" style="padding:12px;">No students in this section.</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>
</body></html>`);
});

app.post('/attendance/policy', requireInstructor, express.urlencoded({ extended: true }), (req, res) => {
  setCourseSetting('engagement_attendance_enabled', req.body.enabled === '1' ? '1' : '0');
  const threshold = parseInt(req.body.threshold, 10);
  if (!isNaN(threshold)) setCourseSetting('engagement_watch_threshold_percent', String(Math.min(100, Math.max(1, threshold))));
  const maxAbs = parseInt(req.body.max_absences, 10);
  if (!isNaN(maxAbs)) setCourseSetting('max_absences_allowed', String(Math.max(0, maxAbs)));
  res.redirect('/app/instructor?tab=attendance');
});

app.get('/attendance/export.csv', requireInstructor, (req, res) => {
  const data = buildAttendanceData(req.query.section || null);
  const header = ['Student', 'Username', 'Section', 'Absences', 'Max Absences', 'Avg %', 'Risk', ...data.chapters.map((c) => c.title)];
  const lines = [header.join(',')];
  data.rows.forEach((r) => {
    const cells = data.chapters.map((c) => (r.cells[c.key] ? r.cells[c.key].watchedPercent + '%' : 'n/a'));
    const line = [r.fullname, r.username, r.sectionTitle, r.summary.countableAbsences, r.summary.maxAbsencesAllowed, r.summary.avgWatchedPercent ?? '', r.summary.riskLevel, ...cells]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');
    lines.push(line);
  });
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', 'attachment; filename="attendance.csv"');
  res.send(lines.join('\n'));
});

app.get('/analytics/who-needs-you/export.csv', requireInstructor, (req, res) => {
  const { whoNeedsYou } = buildAnalyticsTabData();
  const header = ['Name', 'Section', 'Reason', 'Email'];
  const lines = [header.join(',')];
  whoNeedsYou.forEach((s) => {
    const line = [s.fullname, s.section, s.reason, s.email]
      .map((v) => `"${String(v || '').replace(/"/g, '""')}"`).join(',');
    lines.push(line);
  });
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', 'attachment; filename="students-who-need-attention.csv"');
  res.send(lines.join('\n'));
});

app.get('/instructor/module-analysis', requireInstructor, (req, res) => {
  const key = req.query.section;
  const lectures = db.prepare('SELECT * FROM lectures').all()
    .filter((l) => !l.lecture_id.startsWith('pdf-') && chapterSectionKeyOf(l.lecture_id) === key)
    .sort(compareGlobalLectureOrder);
  if (!lectures.length) return res.status(404).send('Unknown module');
  const title = CHAPTER_SECTION_TITLES[key] || key;
  const lectureIds = new Set(lectures.map((l) => l.lecture_id));

  const students = db.prepare("SELECT * FROM students WHERE role = 'student'").all();

  const progressRows = db.prepare(
    `SELECT student_userid, lecture_id, MAX(position) as maxpos, MAX(duration) as dur
     FROM events WHERE event_type IN ('heartbeat', 'pause', 'ended', 'seek') AND position IS NOT NULL
     GROUP BY student_userid, lecture_id`
  ).all().filter((r) => lectureIds.has(r.lecture_id));

  const progressByStudent = {};
  for (const r of progressRows) {
    if (!r.dur) continue;
    (progressByStudent[r.student_userid] ||= []).push({ lecture_id: r.lecture_id, pct: Math.min(100, (r.maxpos / r.dur) * 100) });
  }

  const popupRows = db.prepare(
    `SELECT pr.status, pq.lecture_id FROM popup_responses pr JOIN popup_questions pq ON pq.id = pr.popup_question_id`
  ).all().filter((r) => lectureIds.has(r.lecture_id));
  const popupAttempts = popupRows.filter((r) => r.status !== 'dropped');
  const avgQuizAccuracy = popupAttempts.length ? Math.round((popupAttempts.filter((r) => r.status === 'answered_correct').length / popupAttempts.length) * 100) : null;

  function statusFor(userid) {
    const rows = progressByStudent[userid] || [];
    if (!rows.length) return 'not_started';
    const allDone = lectures.every((l) => rows.some((r) => r.lecture_id === l.lecture_id && r.pct >= 90));
    return allDone ? 'completed' : 'in_progress';
  }

  const studentStatuses = students.map((s) => ({ ...s, status: statusFor(s.userid) }));
  const completedCount = studentStatuses.filter((s) => s.status === 'completed').length;
  const inProgressCount = studentStatuses.filter((s) => s.status === 'in_progress').length;
  const notStartedCount = studentStatuses.filter((s) => s.status === 'not_started').length;
  const avgCompletionPct = students.length ? Math.round((completedCount / students.length) * 100) : 0;

  const bySectionKeys = [...new Set(students.map((s) => s.section || 'Unassigned'))].sort();
  const bySection = bySectionKeys.map((secKey) => {
    const inSec = studentStatuses.filter((s) => (s.section || 'Unassigned') === secKey);
    const completed = inSec.filter((s) => s.status === 'completed').length;
    return { key: secKey, total: inSec.length, completed, pct: inSec.length ? Math.round((completed / inSec.length) * 100) : 0 };
  });

  const byVideo = lectures.map((l) => {
    const viewers = new Set(progressRows.filter((r) => r.lecture_id === l.lecture_id).map((r) => r.student_userid)).size;
    const completedForVideo = students.filter((s) => (progressByStudent[s.userid] || []).some((r) => r.lecture_id === l.lecture_id && r.pct >= 90)).length;
    const pct = viewers ? Math.round((completedForVideo / viewers) * 100) : 0;
    return { title: l.title, viewers, pct };
  });

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const buckets = [];
  for (let i = 6; i >= 0; i--) {
    const dayEnd = now - i * dayMs;
    const d = new Date(dayEnd);
    buckets.push({ label: dayLabels[d.getDay()], start: dayEnd - dayMs, end: dayEnd });
  }
  const chatTimestamps = db.prepare("SELECT lecture_id, created_at FROM events WHERE event_type = 'chat_message'").all()
    .filter((r) => lectureIds.has(r.lecture_id)).map((r) => r.created_at);
  const interactionCounts = buckets.map((b) => ({ label: b.label, count: chatTimestamps.filter((t) => t >= b.start && t < b.end).length }));
  const maxInteraction = Math.max(1, ...interactionCounts.map((b) => b.count));

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)} — Module Analysis</title>
<style>
  ${APP_SHELL_STYLES}
  .back { display:inline-block; margin-bottom:14px; color:#d41128; font-weight:700; font-size:13px; text-decoration:none; }
  .stat-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; }
  .stat-card { background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:14px 16px; }
  .stat-card .val { font-size:22px; font-weight:800; color:#1a1a1a; }
  .stat-card .lbl { font-size:12px; color:#57606a; margin-top:2px; }
  .section-block { margin-top:32px; }
  .section-block h2 { font-size:16px; font-weight:800; margin-bottom:2px; }
  .chart { display:flex; align-items:flex-end; gap:10px; height:100px; padding:10px 0; }
  .chart .bar-col { flex:1; display:flex; flex-direction:column; align-items:center; gap:6px; }
  .chart .bar { width:100%; background:#d41128; border-radius:3px 3px 0 0; min-height:2px; }
  .chart .bar-lbl { font-size:11px; color:#8a94a6; }
  .suggestion { background:#fdf6e3; border:1px solid #f0e0b0; border-radius:8px; padding:10px 14px; font-size:13px; color:#946200; margin-bottom:16px; }
  .bysec-row, .byvid-row { display:flex; justify-content:space-between; padding:8px 0; font-size:13px; }
  .bysec-row + .bysec-row, .byvid-row + .byvid-row { border-top:1px solid #f2f4f7; }
  .filter-pills { display:flex; gap:8px; margin-bottom:12px; }
  .filter-pills button { border:none; background:#eef1f4; color:#333; font-weight:700; font-size:12px; padding:6px 14px; border-radius:20px; cursor:pointer; }
  .filter-pills button.active { background:#d41128; color:#fff; }
  .student-status-row { display:flex; justify-content:space-between; align-items:center; padding:8px 0; font-size:13px; }
  .student-status-row + .student-status-row { border-top:1px solid #f2f4f7; }
  .status-pill { font-size:11px; font-weight:700; padding:3px 10px; border-radius:20px; }
  .status-pill.completed { background:#e3f6ea; color:#1f9d55; }
  .status-pill.in_progress { background:#fdf6e3; color:#946200; }
  .status-pill.not_started { background:#eef1f4; color:#57606a; }
</style></head>
<body>
  <div class="app-main">
    <a class="back" href="/app/instructor?tab=analytics#lecture-videos">&larr; Back to Analytics</a>
    <div class="app-h1">${escapeHtml(title)}</div>

    <div class="stat-grid">
      <div class="stat-card"><div class="val">${students.length}</div><div class="lbl">Students</div></div>
      <div class="stat-card"><div class="val">${avgCompletionPct}%</div><div class="lbl">Avg. completion (${lectures.length} video${lectures.length === 1 ? '' : 's'})</div></div>
      <div class="stat-card"><div class="val">${avgQuizAccuracy !== null ? avgQuizAccuracy + '%' : '—'}</div><div class="lbl">Avg. in-video quiz accuracy</div></div>
      <div class="stat-card"><div class="val">${completedCount}</div><div class="lbl">Completed module</div></div>
      <div class="stat-card"><div class="val">${inProgressCount}</div><div class="lbl">In progress</div></div>
      <div class="stat-card"><div class="val">${notStartedCount}</div><div class="lbl">Not started</div></div>
    </div>

    <div class="section-block">
      <h2>Interactions this week</h2>
      <div class="app-card">
        <div class="chart">
          ${interactionCounts.map((b) => `<div class="bar-col"><div class="bar" style="height:${(b.count / maxInteraction) * 80}px;"></div><div class="bar-lbl">${b.label}</div></div>`).join('')}
        </div>
      </div>
    </div>

    ${students.length && notStartedCount / students.length > 0.2 ? `<div class="suggestion">⚠ ${notStartedCount} of ${students.length} students (${Math.round((notStartedCount / students.length) * 100)}%) haven't started this module yet — consider a reminder or check-in.</div>` : ''}

    <div class="section-block">
      <h2>By section</h2>
      <div class="app-card">
        ${bySection.map((s) => `<div class="bysec-row"><span>Section ${escapeHtml(s.key)}</span><span>${s.completed}/${s.total} completed &middot; ${s.pct}% avg</span></div>`).join('')}
      </div>
    </div>

    <div class="section-block">
      <h2>By video</h2>
      <div class="app-card">
        ${byVideo.map((v) => `<div class="byvid-row"><span>${escapeHtml(v.title)}</span><span>${v.viewers} viewers &middot; ${v.pct}% completed</span></div>`).join('')}
      </div>
    </div>

    <div class="section-block">
      <h2>Students</h2>
      <div class="filter-pills">
        <button class="active" onclick="filterStudents('all', this)">All</button>
        <button onclick="filterStudents('not_started', this)">Not started</button>
        <button onclick="filterStudents('in_progress', this)">In progress</button>
        <button onclick="filterStudents('completed', this)">Completed</button>
      </div>
      <div class="app-card" id="studentStatusList" style="max-height:400px; overflow-y:auto;">
        ${studentStatuses.map((s) => `
          <div class="student-status-row" data-status="${s.status}">
            <a href="/instructor/student?id=${s.userid}" style="color:inherit; text-decoration:none;">${escapeHtml(s.fullname)}<span style="color:#8a94a6; font-size:11px; margin-left:6px;">Section ${escapeHtml(s.section || 'Unassigned')}</span></a>
            <span class="status-pill ${s.status}">${s.status === 'not_started' ? 'Not started' : s.status === 'in_progress' ? 'In progress' : 'Completed'}</span>
          </div>`).join('')}
      </div>
    </div>
  </div>
  <script>
    function filterStudents(status, btn) {
      document.querySelectorAll('.filter-pills button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('#studentStatusList .student-status-row').forEach((row) => {
        row.style.display = (status === 'all' || row.dataset.status === status) ? '' : 'none';
      });
    }
  </script>
</body></html>`);
});

// Per-video analytics: watch funnel, pause/seek "heatmap" segments, and viewing trends
// by section for a single lecture. Distinct from /instructor/module-analysis (which covers
// a whole chapter/week of videos) -- this drills into one video's engagement in detail,
// matching the real Criterio product's per-material "Analytics" button.
const SEGMENT_BUCKET_SECONDS = 20;

function bucketPositions(positions) {
  // Groups raw timestamps into fixed-width buckets and returns the top few by count,
  // each with the distinct students who triggered an event in that bucket.
  const buckets = new Map(); // bucketStart -> { count, students: Set }
  for (const { position, studentId } of positions) {
    if (position === null || position === undefined) continue;
    const bucketStart = Math.floor(position / SEGMENT_BUCKET_SECONDS) * SEGMENT_BUCKET_SECONDS;
    const entry = buckets.get(bucketStart) || { count: 0, students: new Set() };
    entry.count++;
    entry.students.add(studentId);
    buckets.set(bucketStart, entry);
  }
  return [...buckets.entries()]
    .map(([start, entry]) => ({ start, end: start + SEGMENT_BUCKET_SECONDS, count: entry.count, students: [...entry.students] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

app.get('/instructor/video-analytics', requireInstructor, (req, res) => {
  const lectureId = req.query.lecture_id;
  const lecture = db.prepare('SELECT * FROM lectures WHERE lecture_id = ?').get(lectureId);
  if (!lecture) return res.status(404).send('Unknown lecture_id');

  const students = db.prepare("SELECT * FROM students WHERE role = 'student'").all();
  const studentById = {};
  students.forEach((s) => { studentById[s.userid] = s; });

  const allEvents = db.prepare(
    `SELECT student_userid, event_type, position, duration, created_at FROM events WHERE lecture_id = ?`
  ).all(lectureId);

  const viewerIds = new Set(allEvents.map((e) => e.student_userid));
  const maxPosByStudent = {};
  let duration = null;
  for (const e of allEvents) {
    if (e.duration) duration = e.duration;
    if (e.position === null || e.position === undefined) continue;
    if (!(e.student_userid in maxPosByStudent) || e.position > maxPosByStudent[e.student_userid]) {
      maxPosByStudent[e.student_userid] = e.position;
    }
  }
  const watchedPositions = Object.values(maxPosByStudent);
  const avgWatchSeconds = watchedPositions.length ? watchedPositions.reduce((a, b) => a + b, 0) / watchedPositions.length : 0;

  const pauseEvents = allEvents.filter((e) => e.event_type === 'pause');
  const seekEvents = allEvents.filter((e) => e.event_type === 'seek');
  const seekStudentIds = new Set(seekEvents.map((e) => e.student_userid));

  const endedByStudent = {};
  for (const e of allEvents) {
    if (e.event_type !== 'ended') continue;
    endedByStudent[e.student_userid] = (endedByStudent[e.student_userid] || 0) + 1;
  }

  const requiredQuestions = db.prepare('SELECT id FROM popup_questions WHERE lecture_id = ?').all(lectureId);
  const answeredByStudent = {}; // studentId -> Set of popup_question_id answered (non-dropped)
  if (requiredQuestions.length) {
    const placeholders = requiredQuestions.map(() => '?').join(',');
    const responses = db.prepare(
      `SELECT student_userid, popup_question_id FROM popup_responses WHERE status != 'dropped' AND popup_question_id IN (${placeholders})`
    ).all(...requiredQuestions.map((q) => q.id));
    for (const r of responses) (answeredByStudent[r.student_userid] ||= new Set()).add(r.popup_question_id);
  }

  function statusFor(userid) {
    if (!viewerIds.has(userid)) return 'not_started';
    const reachedEnd = (endedByStudent[userid] || 0) > 0;
    const answeredAll = !requiredQuestions.length || (answeredByStudent[userid] && answeredByStudent[userid].size === requiredQuestions.length);
    return reachedEnd && answeredAll ? 'completed' : 'started';
  }

  const funnel = { notStarted: 0, started: 0, completed: 0, watchedMoreThanOnce: 0 };
  const funnelStudents = { not_started: [], started: [], completed: [], rewatched: [] };
  for (const s of students) {
    const status = statusFor(s.userid);
    if (status === 'not_started') { funnel.notStarted++; funnelStudents.not_started.push(s); }
    else if (status === 'completed') { funnel.completed++; funnelStudents.completed.push(s); }
    else { funnel.started++; funnelStudents.started.push(s); }
    if ((endedByStudent[s.userid] || 0) >= 2) { funnel.watchedMoreThanOnce++; funnelStudents.rewatched.push(s); }
  }

  const mostPaused = bucketPositions(pauseEvents.map((e) => ({ position: e.position, studentId: e.student_userid })));
  const mostJumped = bucketPositions(seekEvents.map((e) => ({ position: e.position, studentId: e.student_userid })));

  const sectionKeys = [...new Set(students.map((s) => s.section || 'Unassigned'))].sort();
  const bySection = sectionKeys.map((key) => {
    const inSection = students.filter((s) => (s.section || 'Unassigned') === key);
    const sectionViewers = inSection.filter((s) => viewerIds.has(s.userid));
    const sectionCompleted = inSection.filter((s) => statusFor(s.userid) === 'completed').length;
    const pcts = sectionViewers.map((s) => (maxPosByStudent[s.userid] && duration ? Math.min(100, (maxPosByStudent[s.userid] / duration) * 100) : 0));
    const avgPct = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : 0;
    return { key, viewers: sectionViewers.length, completed: sectionCompleted, avgPct };
  }).filter((s) => s.viewers > 0);

  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const segmentLabel = (seg) => `${fmtTime(seg.start)}–${fmtTime(seg.end)}`;
  const studentNames = (ids) => ids.map((id) => escapeHtml(studentById[id]?.fullname || `#${id}`)).join(', ');

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(lecture.title)} — Video Analytics</title>
<style>
  ${APP_SHELL_STYLES}
  .back { display:inline-block; margin-bottom:14px; color:#d41128; font-weight:700; font-size:13px; text-decoration:none; }
  .stat-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; }
  .stat-card { background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:14px 16px; }
  .stat-card .val { font-size:22px; font-weight:800; color:#1a1a1a; }
  .stat-card .lbl { font-size:12px; color:#57606a; margin-top:2px; }
  .funnel-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; }
  .funnel-card { background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:14px 16px; }
  .funnel-card .lbl { font-size:11px; color:#8a94a6; text-transform:uppercase; font-weight:700; }
  .funnel-card .val { font-size:22px; font-weight:800; margin-top:4px; }
  .funnel-card .desc { font-size:12px; color:#8a94a6; margin-top:4px; }
  .view-students { color:#d41128; font-size:12px; font-weight:700; cursor:pointer; text-decoration:none; display:inline-block; margin-top:6px; }
  .student-names { display:none; font-size:12px; color:#57606a; margin-top:6px; }
  .segment-row { display:flex; justify-content:space-between; align-items:flex-start; padding:10px 0; }
  .segment-row + .segment-row { border-top:1px solid #f2f4f7; }
  .segment-time { font-weight:700; font-size:14px; }
  .segment-count { color:#57606a; font-size:13px; }
  .bysec-row { display:flex; justify-content:space-between; padding:8px 0; font-size:13px; }
  .bysec-row + .bysec-row { border-top:1px solid #f2f4f7; }
  .bar-track { flex:0 0 90px; height:6px; background:#eef1f4; border-radius:3px; overflow:hidden; margin-left:10px; }
  .bar-fill { height:100%; background:#d41128; }
</style></head>
<body>
  <div class="app-main">
    <a class="back" href="javascript:history.back()">&larr; Back to Content</a>
    <div class="app-h1">${escapeHtml(lecture.title)}</div>
    <p class="desc">Video Analytics</p>

    <div class="stat-grid">
      <div class="stat-card"><div class="val">${fmtTime(avgWatchSeconds)}</div><div class="lbl">Avg. watch time — of ${watchedPositions.length} who watched</div></div>
      <div class="stat-card"><div class="val">${pauseEvents.length}</div><div class="lbl">Total pauses</div></div>
      <div class="stat-card"><div class="val">${seekEvents.length}</div><div class="lbl">Timeline seeks — skips + rewinds, direction not tracked</div></div>
      <div class="stat-card"><div class="val">${seekStudentIds.size}</div><div class="lbl">Students using timeline — of ${watchedPositions.length} who watched</div></div>
    </div>

    <div class="section-block">
      <h2>Watch funnel</h2>
      <p class="desc">Every enrolled student (${students.length} total) falls into exactly one of the first three buckets.</p>
      <div class="funnel-grid">
        <div class="funnel-card">
          <div class="lbl">Not started</div>
          <div class="val">${funnel.notStarted}</div>
          <a class="view-students" onclick="this.nextElementSibling.style.display='block'; this.style.display='none';">View students</a>
          <div class="student-names">${studentNames(funnelStudents.not_started.map((s) => s.userid)) || 'None'}</div>
        </div>
        <div class="funnel-card">
          <div class="lbl">Started, not completed</div>
          <div class="val">${funnel.started}</div>
          <div class="desc">includes students who watched it all but skipped a required quiz</div>
          <a class="view-students" onclick="this.nextElementSibling.style.display='block'; this.style.display='none';">View students</a>
          <div class="student-names">${studentNames(funnelStudents.started.map((s) => s.userid)) || 'None'}</div>
        </div>
        <div class="funnel-card">
          <div class="lbl">Completed</div>
          <div class="val">${funnel.completed}</div>
          <div class="desc">reached the end and answered every required quiz</div>
          <a class="view-students" onclick="this.nextElementSibling.style.display='block'; this.style.display='none';">View students</a>
          <div class="student-names">${studentNames(funnelStudents.completed.map((s) => s.userid)) || 'None'}</div>
        </div>
        <div class="funnel-card">
          <div class="lbl">Watched more than once</div>
          <div class="val">${funnel.watchedMoreThanOnce}</div>
          <div class="desc">reached the end 2+ separate times — not the same as seeking within one watch</div>
          <a class="view-students" onclick="this.nextElementSibling.style.display='block'; this.style.display='none';">View students</a>
          <div class="student-names">${studentNames(funnelStudents.rewatched.map((s) => s.userid)) || 'None'}</div>
        </div>
      </div>
    </div>

    <div class="section-block">
      <h2>Most paused segments</h2>
      <p class="desc">Where students pause or stop watching most — drop-off points.</p>
      <div class="app-card">
        ${mostPaused.length ? mostPaused.map((seg) => `
          <div class="segment-row">
            <div>
              <div class="segment-time">${segmentLabel(seg)}</div>
              <a class="view-students" onclick="this.nextElementSibling.style.display='block'; this.style.display='none';">View students</a>
              <div class="student-names">${studentNames(seg.students)}</div>
            </div>
            <div class="segment-count">${seg.count} pause(s)</div>
          </div>`).join('') : '<p class="empty">No pauses recorded yet.</p>'}
      </div>
    </div>

    <div class="section-block">
      <h2>Most jumped-to segments</h2>
      <p class="desc">Where students jump the timeline to most — could be rewatching or skipping ahead.</p>
      <div class="app-card">
        ${mostJumped.length ? mostJumped.map((seg) => `
          <div class="segment-row">
            <div>
              <div class="segment-time">${segmentLabel(seg)}</div>
              <a class="view-students" onclick="this.nextElementSibling.style.display='block'; this.style.display='none';">View students</a>
              <div class="student-names">${studentNames(seg.students)}</div>
            </div>
            <div class="segment-count">${seg.count} jump(s)</div>
          </div>`).join('') : '<p class="empty">No timeline seeks recorded yet.</p>'}
      </div>
    </div>

    <div class="section-block">
      <h2>Viewing trends by section</h2>
      <div class="app-card">
        ${bySection.length ? bySection.map((s) => `
          <div class="bysec-row" style="flex-direction:column; align-items:stretch;">
            <div style="display:flex; justify-content:space-between;">
              <span>Section ${escapeHtml(s.key)}</span>
              <span>${s.viewers} viewer${s.viewers === 1 ? '' : 's'} &middot; ${s.completed} completed</span>
            </div>
            <div style="display:flex; align-items:center; justify-content:flex-end; gap:8px; margin-top:4px;">
              <span style="font-size:12px; color:#8a94a6;">Avg. watch %</span>
              <div class="bar-track"><div class="bar-fill" style="width:${s.avgPct}%;"></div></div>
              <span style="font-weight:700; font-size:13px;">${s.avgPct}%</span>
            </div>
          </div>`).join('') : '<p class="empty">No viewers yet.</p>'}
      </div>
    </div>
  </div>
</body></html>`);
});

app.get('/instructor/student', requireInstructor, (req, res) => {
  const id = parseInt(req.query.id, 10);
  const student = db.prepare('SELECT * FROM students WHERE userid = ?').get(id);
  if (!student) return res.status(404).send('Student not found');

  const videoLectures = db.prepare('SELECT * FROM lectures').all()
    .filter((l) => !l.lecture_id.startsWith('pdf-'))
    .sort(compareGlobalLectureOrder);
  const progressRows = db.prepare(
    `SELECT lecture_id, MAX(position) as maxpos, MAX(duration) as dur FROM events
     WHERE student_userid = ? AND event_type IN ('heartbeat', 'pause', 'ended', 'seek') AND position IS NOT NULL
     GROUP BY lecture_id`
  ).all(id);
  const progressByLecture = {};
  progressRows.forEach((r) => { if (r.dur) progressByLecture[r.lecture_id] = { pct: Math.min(100, Math.round((r.maxpos / r.dur) * 100)) }; });

  const grade = db.prepare('SELECT * FROM grades WHERE userid = ?').get(id);
  const popupRows = db.prepare(
    `SELECT pr.status FROM popup_responses pr JOIN popup_questions pq ON pq.id = pr.popup_question_id WHERE pr.student_userid = ?`
  ).all(id);
  const popupTotal = popupRows.filter((r) => r.status !== 'dropped').length;
  const popupCorrect = popupRows.filter((r) => r.status === 'answered_correct').length;
  const popupAccuracy = popupTotal ? Math.round((popupCorrect / popupTotal) * 100) : null;

  const chatByCategory = { course: 0, video: 0, pdf: 0, assistant: 0 };
  db.prepare("SELECT lecture_id, COUNT(*) as cnt FROM events WHERE student_userid = ? AND event_type = 'chat_message' GROUP BY lecture_id").all(id)
    .forEach((r) => {
      if (r.lecture_id === 'course') chatByCategory.course += r.cnt;
      else if (r.lecture_id.startsWith('pdf-')) chatByCategory.pdf += r.cnt;
      else if (r.lecture_id.startsWith('assignment-')) chatByCategory.assistant += r.cnt;
      else chatByCategory.video += r.cnt;
    });
  const formativeCount = db.prepare('SELECT COUNT(*) as c FROM formative_escalations WHERE student_userid = ?').get(id).c;

  const lectureRows = videoLectures.map((l) => ({
    title: l.title, pct: progressByLecture[l.lecture_id] ? progressByLecture[l.lecture_id].pct : 0,
  }));

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(student.fullname)} — Student Insight</title>
<style>
  ${APP_SHELL_STYLES}
  .back { display:inline-block; margin-bottom:14px; color:#d41128; font-weight:700; font-size:13px; text-decoration:none; }
  .stat-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; }
  .stat-card { background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:14px 16px; }
  .stat-card .val { font-size:22px; font-weight:800; color:#1a1a1a; }
  .stat-card .lbl { font-size:12px; color:#57606a; margin-top:2px; }
  .section-block { margin-top:32px; }
  .section-block h2 { font-size:16px; font-weight:800; margin-bottom:2px; }
  .prog-row { display:flex; align-items:center; justify-content:space-between; padding:8px 0; font-size:13px; }
  .prog-row + .prog-row { border-top:1px solid #f2f4f7; }
  .prog-bar { flex:1; height:6px; background:#eef1f4; border-radius:3px; margin:0 12px; overflow:hidden; }
  .prog-fill { height:100%; background:#d41128; }
</style></head>
<body>
  <div class="app-main">
    <a class="back" href="/app/instructor?tab=analytics">&larr; Back to Analytics</a>
    <div class="app-h1">${escapeHtml(student.fullname)}</div>
    <p class="app-sub">${escapeHtml(student.username)} &middot; Section ${escapeHtml(student.section || 'Unassigned')}</p>

    <div class="stat-grid">
      <div class="stat-card"><div class="val">${grade && grade.quiz_percent !== null && grade.quiz_percent !== undefined ? Math.round(grade.quiz_percent) + '%' : '—'}</div><div class="lbl">Quiz score</div></div>
      <div class="stat-card"><div class="val">${popupAccuracy !== null ? popupAccuracy + '%' : '—'}</div><div class="lbl">In-video check accuracy (n=${popupTotal})</div></div>
      <div class="stat-card"><div class="val">${chatByCategory.course + chatByCategory.video + chatByCategory.pdf + chatByCategory.assistant + formativeCount}</div><div class="lbl">Total AI interactions</div></div>
    </div>

    <div class="section-block">
      <h2>AI interactions by bot</h2>
      <div class="app-card">
        <div class="prog-row"><span>Course Tutor</span><span style="font-weight:700;">${chatByCategory.course}</span></div>
        <div class="prog-row"><span>Video Ask AI</span><span style="font-weight:700;">${chatByCategory.video}</span></div>
        <div class="prog-row"><span>PDF Ask AI</span><span style="font-weight:700;">${chatByCategory.pdf}</span></div>
        <div class="prog-row"><span>Formative Bot</span><span style="font-weight:700;">${formativeCount}</span></div>
        <div class="prog-row"><span>Assignment Assistant</span><span style="font-weight:700;">${chatByCategory.assistant}</span></div>
      </div>
    </div>

    <div class="section-block">
      <h2>Lecture progress</h2>
      <div class="app-card">
        ${lectureRows.map((l) => `
          <div class="prog-row"><span style="flex:0 0 220px;">${escapeHtml(l.title)}</span><div class="prog-bar"><div class="prog-fill" style="width:${l.pct}%;"></div></div><span>${l.pct}%</span></div>`).join('') || '<p class="empty">No lectures yet.</p>'}
      </div>
    </div>
  </div>
</body></html>`);
});

app.post('/analytics/question/:id/address', requireInstructor, express.urlencoded({ extended: true }), (req, res) => {
  db.prepare(
    "INSERT INTO question_review_status (popup_question_id, status, updated_at) VALUES (?, 'addressed', ?) " +
    "ON CONFLICT(popup_question_id) DO UPDATE SET status = 'addressed', updated_at = excluded.updated_at"
  ).run(req.params.id, Date.now());
  res.redirect('/app/instructor?tab=analytics#worth-revisiting');
});

app.post('/analytics/question/:id/dismiss', requireInstructor, express.urlencoded({ extended: true }), (req, res) => {
  db.prepare(
    "INSERT INTO question_review_status (popup_question_id, status, updated_at) VALUES (?, 'dismissed', ?) " +
    "ON CONFLICT(popup_question_id) DO UPDATE SET status = 'dismissed', updated_at = excluded.updated_at"
  ).run(req.params.id, Date.now());
  res.redirect('/app/instructor?tab=analytics#worth-revisiting');
});

app.get('/widget/:lectureId', (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'widget.html'), 'utf8');
  res.set('Content-Type', 'text/html').send(
    html.replace(/__LECTURE_ID__/g, req.params.lectureId)
  );
});

app.get('/widget/course/chat', (req, res) => {
  res.set('Content-Type', 'text/html').send(
    fs.readFileSync(path.join(__dirname, 'course-widget.html'), 'utf8')
      .replace(/__COURSE_TITLE__/g, escapeHtml(getBranding().courseTitle))
  );
});

// ---- Notes (used by widget.html's Notes tab) ----

app.post('/notes', (req, res) => {
  const { student_userid, lecture_id, position, text } = req.body;
  if (!student_userid || !lecture_id || !text || !text.trim()) {
    return res.status(400).json({ error: 'student_userid, lecture_id and text are required' });
  }
  db.prepare(
    'INSERT INTO notes (student_userid, lecture_id, position, text, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(student_userid, lecture_id, position ?? null, text.trim(), Date.now());
  res.json({ ok: true });
});

app.get('/notes/lecture', (req, res) => {
  const { student, lecture } = req.query;
  if (!student || !lecture) return res.status(400).json({ error: 'student and lecture are required' });
  const notes = db.prepare(
    'SELECT id, position, text, created_at FROM notes WHERE student_userid = ? AND lecture_id = ? ORDER BY created_at DESC'
  ).all(student, lecture);
  res.json({ notes });
});

// ---- Lecture Q&A: a threaded question board per lecture, visible to every
// student and instructor (unlike Notes/Ask AI, which are private per-student). ----

app.post('/qa/ask', (req, res) => {
  const { lecture_id, student_userid, question, position } = req.body;
  if (!lecture_id || !student_userid || !question || !question.trim()) {
    return res.status(400).json({ error: 'lecture_id, student_userid and question are required' });
  }
  const result = db.prepare(
    'INSERT INTO lecture_questions (lecture_id, student_userid, question, position, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(lecture_id, student_userid, question.trim(), position ?? null, Date.now());
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.get('/qa/lecture', (req, res) => {
  const { lecture } = req.query;
  if (!lecture) return res.status(400).json({ error: 'lecture is required' });
  const questions = db.prepare(
    `SELECT lq.*, s.fullname FROM lecture_questions lq LEFT JOIN students s ON s.userid = lq.student_userid
     WHERE lq.lecture_id = ? ORDER BY lq.created_at DESC`
  ).all(lecture);
  const replies = db.prepare(
    `SELECT r.*, s.fullname FROM lecture_question_replies r LEFT JOIN students s ON s.userid = r.author_userid
     WHERE r.question_id IN (${questions.map(() => '?').join(',') || 'NULL'}) ORDER BY r.created_at ASC`
  ).all(...questions.map((q) => q.id));
  const repliesByQuestion = {};
  for (const r of replies) (repliesByQuestion[r.question_id] ||= []).push(r);
  res.json({ questions: questions.map((q) => ({ ...q, replies: repliesByQuestion[q.id] || [] })) });
});

app.post('/qa/:id/reply', (req, res) => {
  const { author_userid, reply } = req.body;
  if (!author_userid || !reply || !reply.trim()) return res.status(400).json({ error: 'author_userid and reply are required' });
  db.prepare('INSERT INTO lecture_question_replies (question_id, author_userid, reply, created_at) VALUES (?, ?, ?, ?)')
    .run(req.params.id, author_userid, reply.trim(), Date.now());
  res.json({ ok: true });
});

app.get('/notes', (req, res) => {
  const studentId = req.query.student;
  const students = db.prepare('SELECT * FROM students ORDER BY fullname').all();
  const s = studentId ? db.prepare('SELECT * FROM students WHERE userid = ?').get(studentId) : null;

  let notesHtml = '<p class="sub">Select your name above to see your notes.</p>';
  if (s) {
    const rows = db.prepare(
      `SELECT notes.*, lectures.title as lecture_title FROM notes
       JOIN lectures ON lectures.lecture_id = notes.lecture_id
       WHERE student_userid = ? ORDER BY notes.created_at DESC`
    ).all(studentId);
    notesHtml = rows.length
      ? rows.map((n) => `
        <div class="turn">
          <div class="q">${escapeHtml(n.lecture_title)}${n.position !== null ? ` · ${formatTimestamp(n.position)}` : ''}</div>
          <div class="a">${escapeHtml(n.text)}</div>
        </div>`).join('')
      : '<p class="sub">No notes yet.</p>';
  }

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>My Notes</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; background:#0f1012; color:#e9e9ea; margin:0; padding:24px; max-width:720px; }
  h1 { font-size:20px; }
  select { background:#18191c; color:#e9e9ea; border:1px solid #333; border-radius:6px; padding:6px 10px; margin-bottom:16px; }
  .turn { background:#18191c; border:1px solid #26272b; border-radius:8px; padding:10px 12px; margin-bottom:10px; }
  .turn .q { color:#d6293e; font-weight:600; margin-bottom:4px; font-size:13px; }
  .turn .a { white-space:pre-wrap; }
  .sub { color:#999; }
</style></head>
<body>
  <h1>My Notes</h1>
  <form method="get" action="/notes">
    <select name="student" onchange="this.form.submit()">
      <option value="">Select your name...</option>
      ${students.map((st) => `<option value="${st.userid}" ${String(st.userid) === String(studentId) ? 'selected' : ''}>${escapeHtml(st.fullname)}</option>`).join('')}
    </select>
  </form>
  ${notesHtml}
</body></html>`);
});

// ---- Leaderboard ----

app.post('/grades/sync', (req, res) => {
  const { grades } = req.body;
  if (!Array.isArray(grades)) return res.status(400).json({ error: 'grades array is required' });
  const upsert = db.prepare(
    'INSERT INTO grades (userid, quiz_percent, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(userid) DO UPDATE SET quiz_percent = excluded.quiz_percent, updated_at = excluded.updated_at'
  );
  const tx = db.transaction(() => {
    for (const g of grades) upsert.run(g.userid, g.percent, Date.now());
  });
  tx();
  res.json({ ok: true, count: grades.length });
});

// ---- Student app shell: Criterio-matching Home/Courses/Course-detail pages ----
// Shared chrome (nav + design tokens pulled from the real Criterio repo) reused
// across every /app/* page so they read as one app, not a pile of separate tools.

const APP_SHELL_STYLES = `
  :root { color-scheme: light; }
  .att-row { display:flex; align-items:center; gap:16px; padding:12px 16px; flex-wrap:wrap; }
  .att-row + .att-row { border-top:1px solid #f2f4f7; }
  .att-heatmap { display:flex; gap:3px; flex-wrap:wrap; max-width:220px; }
  .att-square { width:12px; height:12px; border-radius:2px; display:inline-block; }
  .att-square.engaged { background:#1f9d55; }
  .att-square.not-engaged { background:#d41128; }
  .att-square.not-due { background:transparent; border:1px solid #d7dce2; }
  .guidelines-card { font-size:13px; line-height:1.6; color:#333; }
  .markdown-body h1 { font-size:18px; margin:0 0 12px; }
  .markdown-body h2 { font-size:15px; margin:18px 0 8px; border-top:1px solid #eef1f4; padding-top:14px; }
  .markdown-body h2:first-child { border-top:none; padding-top:0; }
  .markdown-body p { margin:0 0 10px; }
  .markdown-body ul, .markdown-body ol { margin:0 0 10px; padding-left:22px; }
  .markdown-body li { margin-bottom:4px; }
  .markdown-body li > ul, .markdown-body li > ol { margin-top:4px; }
  .markdown-body code { background:#f2f4f7; padding:1px 5px; border-radius:4px; font-size:12px; }
  .markdown-body hr { border:none; border-top:1px solid #eef1f4; margin:16px 0; }
  * { box-sizing: border-box; }
  html, body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Segoe UI",system-ui,sans-serif; background:#f3f5f7; color:#0b1220; }
  a { color:inherit; text-decoration:none; }
  .app-topbar { height:3px; background:#d41128; }
  .app-nav { display:flex; align-items:center; gap:28px; padding:14px 32px; background:#fff; border-bottom:1px solid #e2e8f0; }
  .app-nav .brand { display:flex; align-items:center; gap:8px; font-weight:700; font-size:16px; margin-right:12px; }
  .app-nav .brand .htu { color:#d41128; font-weight:800; }
  .app-nav .links { display:flex; gap:22px; flex:1; }
  .app-nav .links a { font-size:14px; font-weight:600; color:#57606a; padding-bottom:18px; margin-bottom:-18px; border-bottom:2px solid transparent; }
  .app-nav .links a.active { color:#0b1220; border-bottom-color:#d41128; }
  .app-nav .right { display:flex; align-items:center; gap:16px; }
  .app-nav .avatar { width:34px; height:34px; border-radius:50%; background:#d41128; color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:13px; }
  .app-nav .who { font-size:13px; line-height:1.3; }
  .app-nav .who .name { font-weight:700; }
  .app-nav .who .role { color:#57606a; font-size:12px; }
  .app-main { max-width:1180px; margin:0 auto; padding:28px 32px 60px; }
  .app-card { background:#fff; border:1px solid #e2e8f0; border-radius:14px; padding:16px; }
  .app-h1 { font-size:26px; font-weight:800; margin:0 0 4px; }
  .app-sub { color:#57606a; font-size:14px; margin:0 0 22px; }
`;

// Framed inside the LMS (the Rennix dashboard at the top of a course page, see
// local_rennixtutorbot), the app's own top bar and nav duplicate the LMS's --
// hide them, and report the page height to the parent so it can size the
// iframe without an inner scrollbar. Only the parent can use the height; it
// matches messages to its own iframe, so nothing sensitive is posted.
const FRAMED_EMBED_SCRIPT = `<script>
(function () {
  if (window.self === window.top) return;
  document.documentElement.classList.add('framed');
  var st = document.createElement('style');
  st.textContent = '.framed .app-topbar, .framed .app-nav, .framed .instr-nav { display: none !important; }' +
    '.framed body { background: transparent; } .framed .app-main { padding-top: 12px; }';
  document.head.appendChild(st);
  function report() {
    window.parent.postMessage({ type: 'rennix-embed-height', height: document.documentElement.scrollHeight }, '*');
  }
  window.addEventListener('load', report);
  window.addEventListener('resize', report);
  if (window.ResizeObserver) new ResizeObserver(report).observe(document.documentElement);
})();
</script>`;

function renderAppNav(active, studentParam) {
  const items = [
    ['Home', '/app/home'],
    ['My Courses', '/app/courses'],
    ['Assignments', '/assignments/mine'],
    ['Sessions', '/sessions'],
    ['Notes', '/notes'],
    ['About Us', '#'],
  ];
  return `${FRAMED_EMBED_SCRIPT}
  <div class="app-topbar"></div>
  <div class="app-nav">
    <div class="brand" title="${escapeHtml(getBranding().schoolName)}"><span class="htu">${escapeHtml(getBranding().schoolShort)}</span> | Criterio</div>
    <div class="links">
      ${items.map(([label, href]) => `<a href="${href === '#' ? '#' : href + (studentParam ? '?student=' + studentParam : '')}" class="${label === active ? 'active' : ''}">${label}</a>`).join('')}
    </div>
    <div class="right">
      <div class="avatar" id="navAvatar">?</div>
      <div class="who"><div class="name" id="navName">Loading...</div><div class="role">Student</div></div>
    </div>
  </div>`;
}

// Shared boilerplate every /app/* page needs: identify via postMessage (embedded)
// or ?student= (direct/testing), then fill in the nav avatar/name once known.
const APP_IDENTIFY_SCRIPT = `
  const params = new URLSearchParams(location.search);
  let studentUserId = params.get('student') ? Number(params.get('student')) : null;
  function applyIdentity(userId, fullname) {
    studentUserId = userId;
    const initials = (fullname || 'S').split(/\\s+/).filter(Boolean).slice(0,2).map(s=>s[0]).join('').toUpperCase();
    const avatarEl = document.getElementById('navAvatar');
    const nameEl = document.getElementById('navName');
    if (avatarEl) avatarEl.textContent = initials || 'S';
    if (nameEl) nameEl.textContent = fullname || ('Student #' + userId);
  }
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'identify' && event.data.userId) {
      const tok = event.data.token ? '&t=' + encodeURIComponent(event.data.token) : '';
      fetch('/students/lookup?userid=' + event.data.userId + tok).then(r=>r.json()).then(d => applyIdentity(event.data.userId, d.fullname)).catch(()=>applyIdentity(event.data.userId, null));
      if (typeof onIdentified === 'function') onIdentified(event.data.userId, event.data.token);
    }
  });
  if (studentUserId) {
    const tok = params.get('t') ? '&t=' + encodeURIComponent(params.get('t')) : '';
    fetch('/students/lookup?userid=' + studentUserId + tok).then(r=>r.json()).then(d => applyIdentity(studentUserId, d.fullname)).catch(()=>applyIdentity(studentUserId, null));
  }
`;

app.get('/students/lookup', (req, res) => {
  // Fires the instant the identify postMessage/redirect arrives, before the
  // session cookie exists yet -- so it accepts a fresh ?t= token directly,
  // same as the global identity middleware, rather than only trusting the
  // cookie. Only reveals a name if the (verified) viewer is looking up
  // themselves or is an instructor -- not an open-to-anyone id lookup.
  let viewerId = req.verifiedUserId;
  if (!viewerId && req.query.t) {
    const verified = verifyIdentityToken(String(req.query.t));
    if (verified) viewerId = verified.userid;
  }
  const requested = Number(req.query.userid);
  const viewerRow = viewerId ? db.prepare('SELECT role FROM students WHERE userid = ?').get(viewerId) : null;
  const isInstructor = viewerRow && hasCapability(viewerRow.role, 'view_dashboard');
  if (!viewerId || (viewerId !== requested && !isInstructor)) {
    return res.json({ fullname: null });
  }
  const row = db.prepare('SELECT userid, fullname FROM students WHERE userid = ?').get(requested);
  res.json({ fullname: row ? row.fullname : null });
});

app.get('/app/home', (req, res) => {
  // Mirrors the fix /app/instructor already got: this page was reading
  // identity from req.query.student, a URL parameter that neither
  // block_criterio's bare iframe src nor an LTI bridge redirect ever
  // actually include -- both only ever send ?t=<token>. The global identity
  // middleware only rewrites req.query.student when that key is *already*
  // present in the URL, so on a bare load it silently stays undefined even
  // though req.verifiedUserId was correctly set from the token. Confirmed
  // live: an LTI launch landed here and was permanently stuck on "Waiting
  // for identity..." -- nothing was ever going to send it a postMessage on
  // a bare top-level page load. Use the verified id directly instead, with
  // the same identify-then-redirect stub /app/instructor uses for the
  // still-unauthenticated first hit.
  if (!req.verifiedUserId) {
    return res.set('Content-Type', 'text/html').send(`<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
  ${APP_IDENTIFY_SCRIPT}
  function onIdentified(userId, token) {
    if (!token) return;
    location.href = '/app/home?t=' + encodeURIComponent(token);
  }
</script>
</body></html>`);
  }
  const studentParam = req.verifiedUserId;
  const student = db.prepare('SELECT * FROM students WHERE userid = ?').get(studentParam);
  const data = buildHomeDashboardData(studentParam);

  const maxWeekCount = data ? Math.max(1, ...data.weekBuckets.map((b) => b.count)) : 1;

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Home — Criterio</title>
<style>
  ${APP_SHELL_STYLES}
  .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; margin-bottom:20px; }
  .stat-icon { width:34px; height:34px; border-radius:8px; background:#fdecee; color:#d41128; display:flex; align-items:center; justify-content:center; font-size:16px; margin-bottom:10px; }
  .stat-value { font-size:22px; font-weight:800; }
  .stat-label { color:#57606a; font-size:12px; }
  .row2 { display:grid; grid-template-columns:2fr 1fr; gap:16px; margin-bottom:16px; }
  .section-label { font-size:11px; letter-spacing:0.04em; color:#8a94a6; font-weight:700; text-transform:uppercase; margin-bottom:8px; }
  .focus-item { display:flex; align-items:center; gap:12px; padding:10px 0; border-top:1px solid #eef1f4; }
  .focus-item:first-of-type { border-top:none; }
  .focus-icon { width:36px; height:36px; border-radius:8px; background:#d41128; color:#fff; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
  .focus-title { font-weight:700; font-size:14px; }
  .focus-sub { color:#57606a; font-size:12px; }
  .lb-row { display:flex; align-items:center; gap:10px; padding:8px 0; }
  .lb-rank { width:20px; color:#8a94a6; font-weight:700; font-size:13px; }
  .lb-rank.top1 { color:#d41128; }
  .lb-avatar { width:26px; height:26px; border-radius:50%; background:#eef1f4; display:flex; align-items:center; justify-content:center; font-size:11px; }
  .lb-name { flex:1; font-size:13px; font-weight:600; }
  .lb-sub { color:#8a94a6; font-size:11px; }
  .lb-pts { background:#fdecee; color:#d41128; font-weight:700; font-size:12px; padding:2px 8px; border-radius:8px; }
  .chart { display:flex; align-items:flex-end; gap:8px; height:120px; margin-top:12px; }
  .chart .bar-wrap { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; height:100%; }
  .chart .bar { width:60%; background:#d41128; border-radius:4px 4px 0 0; min-height:2px; }
  .chart .bar-label { font-size:10px; color:#8a94a6; margin-top:4px; }
  .row3 { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin-top:16px; }
  .quick-card { display:flex; justify-content:space-between; align-items:center; }
  .quick-card .qt { font-weight:700; font-size:14px; }
  .quick-card .qs { color:#57606a; font-size:12px; }
  .empty { color:#8a94a6; font-size:13px; padding:8px 0; }
</style></head>
<body>
${renderAppNav('Home', studentParam)}
<div class="app-main">
  ${!studentParam ? `<p class="empty">Waiting for identity...</p>` : `
  <div class="app-h1">Welcome back, ${escapeHtml((student && student.fullname) || 'Student').split(' ')[0]}</div>
  <p class="app-sub">Here's what's happening across your courses.</p>

  <div class="stats">
    <div class="app-card"><div class="stat-icon">&#128218;</div><div class="stat-value">${data.courseCount}</div><div class="stat-label">Courses enrolled</div></div>
    <div class="app-card"><div class="stat-icon">&#128203;</div><div class="stat-value">${data.assignmentsDueSoon}</div><div class="stat-label">Assignments due soon</div></div>
    <div class="app-card"><div class="stat-icon">&#128200;</div><div class="stat-value">${data.overallProgress}%</div><div class="stat-label">Overall learning progress</div></div>
    <div class="app-card"><div class="stat-icon">&#128197;</div><div class="stat-value">${data.upcomingSessionsCount}</div><div class="stat-label">Upcoming sessions</div></div>
  </div>

  <div class="row2">
    <div class="app-card">
      <div class="section-label">Today's Focus</div>
      ${data.continueWatching ? `
        <div class="focus-item">
          <div class="focus-icon">&#9654;</div>
          <div style="flex:1;">
            <div class="focus-sub">CONTINUE WHERE YOU LEFT OFF</div>
            <div class="focus-title">${escapeHtml(data.continueWatching.title)}</div>
            <div class="focus-sub">${data.continueWatchingPct}% watched</div>
          </div>
          <a href="/lecture/${data.continueWatching.lecture_id}?student=${studentParam}">&rarr;</a>
        </div>` : ''}
      ${data.nextUp ? `
        <div class="focus-item">
          <div class="focus-icon" style="background:#eef1f4;color:#57606a;">&#128197;</div>
          <div style="flex:1;">
            <div class="focus-sub">NEXT UP</div>
            <div class="focus-title">${escapeHtml(data.nextUp.title)}</div>
          </div>
          <a href="/lecture/${data.nextUp.lecture_id}?student=${studentParam}">&rarr;</a>
        </div>` : ''}
      ${!data.continueWatching && !data.nextUp ? '<p class="empty">All caught up.</p>' : ''}
    </div>
    <div class="app-card">
      <div class="section-label">Leaderboard</div>
      <p class="focus-sub" style="margin:-4px 0 10px;">Top peers by completion, quizzes, and Q&amp;A.</p>
      ${data.leaderboard.map((s, i) => `
        <div class="lb-row">
          <div class="lb-rank ${i === 0 ? 'top1' : ''}">${i === 0 ? '#1' : '#' + (i + 1)}</div>
          <div class="lb-avatar">${escapeHtml(s.fullname.slice(0, 1))}</div>
          <div><div class="lb-name">${escapeHtml(s.fullname)}</div></div>
          <div style="flex:1;"></div>
          <div class="lb-pts">${s.score} pts</div>
        </div>`).join('') || '<p class="empty">No data yet.</p>'}
      <p class="focus-sub" style="margin-top:8px;">You're ranked #${data.myRank || '-'} of ${data.totalStudents}.</p>
    </div>
  </div>

  <div class="row2">
    <div class="app-card">
      <div class="section-label">My Progress</div>
      <p class="focus-sub" style="margin:-4px 0 0;">Tutor &amp; Formative Bot activity over time</p>
      <div class="chart">
        ${data.weekBuckets.map((b) => `
          <div class="bar-wrap">
            <div class="bar" style="height:${Math.max(2, (b.count / maxWeekCount) * 100)}%;"></div>
            <div class="bar-label">${b.label}</div>
          </div>`).join('')}
      </div>
    </div>
    <div class="app-card">
      <div class="section-label">My Schedule</div>
      <p class="focus-sub" style="margin:-4px 0 10px;">Sessions and deadlines this week</p>
      ${data.thisWeekSessions.length
        ? data.thisWeekSessions.map((s) => `<div class="focus-item"><div style="flex:1;"><div class="focus-title">${escapeHtml(s.title)}</div><div class="focus-sub">${new Date(s.starts_at).toLocaleString()}</div></div></div>`).join('')
        : '<p class="empty">Nothing on your schedule right now.</p>'}
    </div>
  </div>

  <div class="row3">
    <a href="/app/courses?student=${studentParam}" class="app-card quick-card"><div><div class="qt">My Courses</div><div class="qs">${data.courseCount} enrolled</div></div><div>&rarr;</div></a>
    <a href="/assignments/mine?student=${studentParam}" class="app-card quick-card"><div><div class="qt">Assignments</div><div class="qs">${data.assignmentsTotal} published</div></div><div>&rarr;</div></a>
    <a href="/sessions?as=${studentParam}" class="app-card quick-card"><div><div class="qt">Formative Sessions</div><div class="qs">${data.upcomingSessionsCount} upcoming</div></div><div>&rarr;</div></a>
  </div>
  `}
</div>
<script>
  ${APP_IDENTIFY_SCRIPT}
  function onIdentified(userId, token) {
    // Bug fix: the old check was location.search.includes('student='), which is true even
    // when the URL carries an EMPTY ?student= (the server blanks it when unverified) -- that
    // silently skipped upgrading to a verified &t= token forever, leaving every server-
    // rendered link on the page permanently built from an unverified/blank identity. Only
    // skip if we already have a real token in the URL.
    if (!userId || params.get('t')) return;
    location.href = '/app/home?student=' + userId + (token ? '&t=' + encodeURIComponent(token) : '');
  }
</script>
</body></html>`);
});

app.get('/app/courses', (req, res) => {
  const studentParam = req.query.student ? Number(req.query.student) : null;
  const assignmentsTotal = db.prepare('SELECT COUNT(*) as c FROM assignments').get().c;

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>My Courses — Criterio</title>
<style>
  ${APP_SHELL_STYLES}
  .tabs { display:flex; gap:8px; margin-bottom:18px; }
  .tabs button { border:1px solid #e2e8f0; background:#fff; border-radius:8px; padding:6px 14px; font-size:13px; font-weight:600; cursor:pointer; color:#57606a; }
  .tabs button.active { background:#d41128; border-color:#d41128; color:#fff; }
  .courses { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:16px; }
  .course-card { border-top:3px solid #d41128; }
  .course-title { font-weight:700; font-size:16px; margin-bottom:2px; }
  .course-code { color:#8a94a6; font-size:12px; margin-bottom:12px; }
  .course-meta { color:#57606a; font-size:12px; margin-bottom:4px; }
</style></head>
<body>
${renderAppNav('My Courses', studentParam)}
<div class="app-main">
  <div class="app-h1">My Courses</div>
  <p class="app-sub">Open a course to see its chapters, materials, and tutor bot.</p>
  <div class="tabs">
    <button class="active">All</button>
    <button>Active</button>
    <button>Completed</button>
  </div>
  <div class="courses">
    <a href="/app/course/cs101?student=${studentParam || ''}" class="app-card course-card">
      <div class="course-title">${escapeHtml(getBranding().courseTitle)}</div>
      <div class="course-code">${escapeHtml(getBranding().courseCode)}</div>
      <div class="course-meta">${assignmentsTotal ? assignmentsTotal + ' assignment(s) published' : 'No assignments published yet'}</div>
      <div class="course-meta">No upcoming deadline</div>
    </a>
  </div>
</div>
<script>${APP_IDENTIFY_SCRIPT}</script>
</body></html>`);
});

app.get('/assignments/mine', (req, res) => {
  const studentParam = req.query.student ? Number(req.query.student) : null;
  const assignments = db.prepare("SELECT * FROM assignments WHERE status = 'published' ORDER BY created_at DESC").all();
  const draftedIds = studentParam
    ? new Set(db.prepare('SELECT assignment_id FROM assignment_drafts WHERE student_userid = ?').all(studentParam).map((d) => d.assignment_id))
    : new Set();

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Assignments — Criterio</title>
<style>
  ${APP_SHELL_STYLES}
  .assignments { display:flex; flex-direction:column; gap:12px; }
  .assignment-card { display:flex; align-items:center; justify-content:space-between; gap:16px; }
  .assignment-title { font-weight:700; font-size:15px; margin-bottom:2px; }
  .assignment-meta { color:#8a94a6; font-size:12px; }
  .assignment-status { font-size:12px; font-weight:700; padding:4px 10px; border-radius:20px; background:#eef1f4; color:#57606a; white-space:nowrap; }
  .assignment-status.drafted { background:#fdecee; color:#a10f22; }
</style></head>
<body>
${renderAppNav('Assignments', studentParam)}
<div class="app-main">
  <div class="app-h1">Assignments</div>
  <p class="app-sub">Open an assignment to read the brief, draft your submission, and use the Assignment Assistant.</p>
  <div class="assignments">
    ${assignments.map((a) => `
      <a href="/workspace/${a.id}?student=${studentParam || ''}" class="app-card assignment-card">
        <div>
          <div class="assignment-title">${escapeHtml(a.title)}</div>
          <div class="assignment-meta">Published ${new Date(a.created_at).toLocaleDateString()}</div>
        </div>
        <div class="assignment-status ${draftedIds.has(a.id) ? 'drafted' : ''}">${draftedIds.has(a.id) ? 'Draft in progress' : 'Not started'}</div>
      </a>`).join('') || '<p class="empty">No assignments published yet.</p>'}
  </div>
</div>
<script>${APP_IDENTIFY_SCRIPT}</script>
</body></html>`);
});

app.get('/app/course/cs101', (req, res) => {
  const studentParam = req.query.student ? Number(req.query.student) : null;
  const { chapters, overallPct } = studentParam ? buildCourseChapters(studentParam) : { chapters: [], overallPct: 0 };

  // Same "Videos" quick-nav sidebar as the lecture page, so jumping between
  // videos doesn't require going back through the full Chapters accordion
  // below -- independently scrollable, closeable, matching /lecture/:id.
  const allLectures = db.prepare('SELECT * FROM lectures').all().sort(compareGlobalLectureOrder);
  const sidebarSections = {};
  for (const l of allLectures) {
    const key = chapterSectionKeyOf(l.lecture_id);
    (sidebarSections[key] ||= []).push(l);
  }
  const sidebarKeys = Object.keys(sidebarSections).sort((a, b) => (parseInt(a.replace('week', ''), 10) || 0) - (parseInt(b.replace('week', ''), 10) || 0));

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(getBranding().courseTitle)} — Criterio</title>
<style>
  ${APP_SHELL_STYLES}
  .crumb { font-size:13px; color:#8a94a6; margin-bottom:4px; }
  .crumb a { color:#57606a; }
  .course-code { color:#d41128; font-weight:700; font-size:13px; margin-bottom:2px; }
  .course-header { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; }
  .course-header-left { display:flex; align-items:center; gap:12px; min-width:0; }
  .sidebar-toggle { flex-shrink:0; border:1px solid #e2e8f0; background:#fff; border-radius:8px; width:36px; height:36px; font-size:15px; cursor:pointer; color:#333; }
  .sidebar-toggle:hover { background:#f7f8fa; }
  .course-layout { display:flex; gap:20px; align-items:flex-start; margin-top:16px; }
  #videosSidebar { width:280px; flex-shrink:0; background:#fff; border:1px solid #e2e8f0; border-radius:12px; max-height:80vh; overflow-y:auto; }
  .course-layout.sidebar-collapsed #videosSidebar { display:none; }
  #videosSidebar .sb-head { padding:14px 16px; border-bottom:1px solid #eef1f4; }
  #videosSidebar .sb-head .t { font-weight:700; font-size:14px; }
  #videosSidebar .sb-head .s { color:#8a94a6; font-size:12px; }
  #videosSidebar .sb-section { padding:10px 16px 4px; font-size:11px; font-weight:700; color:#8a94a6; text-transform:uppercase; }
  #videosSidebar .sb-item { display:block; padding:8px 16px; font-size:13px; color:#333; border-left:3px solid transparent; }
  #videosSidebar .sb-item:hover { background:#f7f8fa; }
  #courseMain { flex:1; min-width:0; }
  .askai-bar { display:flex; align-items:center; gap:12px; padding:14px 16px; background:#fdecee; border-radius:12px; margin:18px 0; cursor:pointer; }
  .askai-icon { width:34px; height:34px; border-radius:8px; background:#d41128; color:#fff; display:flex; align-items:center; justify-content:center; }
  .askai-title { font-weight:700; color:#a10f22; font-size:14px; }
  .askai-sub { color:#b23a4c; font-size:12px; }
  #askaiFrame { display:none; width:100%; height:480px; border:1px solid #e2e8f0; border-radius:12px; margin-bottom:18px; }
  h3 { font-size:15px; margin:22px 0 10px; }
  .guidelines-card { font-size:13px; line-height:1.6; color:#333; }
  .markdown-body h1 { font-size:20px; margin:0 0 12px; }
  .markdown-body h2 { font-size:16px; margin:20px 0 8px; border-top:1px solid #eef1f4; padding-top:16px; }
  .markdown-body h2:first-child { border-top:none; padding-top:0; }
  .markdown-body p { margin:0 0 10px; }
  .markdown-body ul, .markdown-body ol { margin:0 0 10px; padding-left:22px; }
  .markdown-body li { margin-bottom:4px; }
  .markdown-body li > ul, .markdown-body li > ol { margin-top:4px; }
  .markdown-body code { background:#f2f4f7; padding:1px 5px; border-radius:4px; font-size:12px; }
  .markdown-body hr { border:none; border-top:1px solid #eef1f4; margin:16px 0; }
  .progress-bar-outer { background:#eef1f4; border-radius:6px; height:8px; flex:1; overflow:hidden; }
  .progress-bar-inner { background:#d41128; height:100%; }
  .progress-row { display:flex; align-items:center; gap:10px; margin:14px 0 18px; }
  .progress-pct { font-size:12px; font-weight:700; color:#d41128; white-space:nowrap; }
  .section { border:1px solid #e2e8f0; border-radius:12px; margin-bottom:10px; background:#fff; overflow:hidden; }
  .section-head { display:flex; justify-content:space-between; align-items:center; padding:12px 16px; cursor:pointer; font-weight:700; font-size:14px; }
  .section-meta { color:#8a94a6; font-weight:600; font-size:12px; }
  .section-items { border-top:1px solid #eef1f4; display:none; }
  .section.open .section-items { display:block; }
  .item-row { display:flex; align-items:center; gap:12px; padding:10px 16px; border-top:1px solid #f2f4f7; }
  .item-row:first-child { border-top:none; }
  .item-check { width:20px; height:20px; border-radius:50%; border:2px solid #d1d9e0; flex-shrink:0; display:flex; align-items:center; justify-content:center; font-size:11px; }
  .item-check.done { background:#d41128; border-color:#d41128; color:#fff; }
  .item-type { width:22px; text-align:center; }
  .item-title { flex:1; font-size:13px; font-weight:600; }
  .item-sub { color:#8a94a6; font-size:11px; }
  .item-open { border:1px solid #d1d9e0; background:#fff; border-radius:8px; padding:5px 14px; font-size:12px; font-weight:600; cursor:pointer; }
</style></head>
<body>
${renderAppNav('My Courses', studentParam)}
<div class="app-main">
  <div class="crumb"><a href="/app/courses?student=${studentParam || ''}">&larr; My Courses</a></div>
  <div class="course-header">
    <div class="course-header-left">
      <button class="sidebar-toggle" id="sidebarToggle" type="button" title="Show/hide videos">&#9776;</button>
      <div>
        <div class="course-code">${escapeHtml(getBranding().courseCode)}</div>
        <div class="app-h1" style="margin-bottom:0;">${escapeHtml(getBranding().courseTitle)}</div>
      </div>
    </div>
  </div>

  <div class="course-layout" id="courseLayout">
    <div id="videosSidebar">
      <div class="sb-head"><div class="t">Videos</div><div class="s">${allLectures.length} lectures</div></div>
      ${sidebarKeys.map((key) => `
        <div class="sb-section">${escapeHtml((CHAPTER_SECTION_TITLES[key] || key).toUpperCase())}</div>
        ${sidebarSections[key].map((l) => `<a class="sb-item" href="${l.lecture_id.startsWith('pdf-') ? `/pdf/${l.lecture_id.split('-')[1]}?student=${studentParam || ''}` : `/lecture/${l.lecture_id}?student=${studentParam || ''}`}">${escapeHtml(l.title)}</a>`).join('')}
      `).join('')}
    </div>

    <div id="courseMain">
      <div class="askai-bar" onclick="document.getElementById('askaiFrame').style.display='block';this.style.display='none';">
        <div class="askai-icon">&#10024;</div>
        <div><div class="askai-title">Ask AI</div><div class="askai-sub">Ask anything about this course...</div></div>
      </div>
      <iframe id="askaiFrame" src="/widget/course/chat" onload="if (studentUserId) this.contentWindow.postMessage({type:'identify', userId: studentUserId}, '*');"></iframe>

      <h3>Instructor Instructions</h3>
      <div class="app-card">
        <h3 style="margin-top:0;">Course Guidelines</h3>
        <div class="guidelines-card markdown-body">${marked.parse(getCourseGuidelines() || '')}</div>
      </div>

      <h3>Chapters</h3>
      <p class="app-sub" style="margin-bottom:0;">Materials your instructor has uploaded for this course.</p>
      <div class="progress-row">
        <span style="font-size:12px;color:#57606a;">Course progress</span>
        <div class="progress-bar-outer"><div class="progress-bar-inner" style="width:${overallPct}%;"></div></div>
        <span class="progress-pct">${overallPct}% complete</span>
      </div>

      ${chapters.map((c, ci) => `
        <div class="section ${ci === 0 ? 'open' : ''}" id="sec-${c.key}">
          <div class="section-head" onclick="document.getElementById('sec-${c.key}').classList.toggle('open')">
            <span>${escapeHtml(c.title)}</span>
            <span class="section-meta">${c.completedCount}/${c.total} &middot; ${c.pct}%</span>
          </div>
          <div class="section-items">
            ${c.items.map((it) => `
              <div class="item-row">
                <div class="item-check ${it.completed ? 'done' : ''}">${it.completed ? '&#10003;' : ''}</div>
                <div class="item-type">${it.isSlide ? '&#128196;' : '&#127909;'}</div>
                <div>
                  <div class="item-title">${escapeHtml(it.title)}</div>
                  <div class="item-sub">${it.isSlide ? 'Slides' : 'Video'}</div>
                </div>
                <div style="flex:1;"></div>
                <a href="${it.isSlide ? `/pdf/${it.lecture_id.split('-')[1]}?student=${studentParam || ''}` : `/lecture/${it.lecture_id}?student=${studentParam || ''}`}"><button class="item-open" type="button">Open</button></a>
              </div>`).join('')}
          </div>
        </div>`).join('') || '<p class="empty">Waiting for identity...</p>'}
    </div>
  </div>
</div>
<script>
  ${APP_IDENTIFY_SCRIPT}
  function onIdentified(userId, token) {
    // Same fix as /app/home: only skip re-verifying if the URL already carries a real
    // token, not merely a (possibly server-blanked) ?student= value.
    if (!userId || params.get('t')) return;
    location.href = '/app/course/cs101?student=' + userId + (token ? '&t=' + encodeURIComponent(token) : '');
  }
  document.getElementById('sidebarToggle').addEventListener('click', () => {
    document.getElementById('courseLayout').classList.toggle('sidebar-collapsed');
  });
</script>
</body></html>`);
});

app.get('/lecture/:id', (req, res) => {
  const lectureId = req.params.id;
  const lecture = db.prepare('SELECT * FROM lectures WHERE lecture_id = ?').get(lectureId);
  if (!lecture) return res.status(404).send('Lecture not found');
  const studentParam = req.query.student ? Number(req.query.student) : null;

  const allLectures = db.prepare('SELECT * FROM lectures').all().sort(compareGlobalLectureOrder);
  const sidebarSections = {};
  for (const l of allLectures) {
    const key = chapterSectionKeyOf(l.lecture_id);
    (sidebarSections[key] ||= []).push(l);
  }
  const sidebarKeys = Object.keys(sidebarSections).sort((a, b) => (parseInt(a.replace('week', ''), 10) || 0) - (parseInt(b.replace('week', ''), 10) || 0));

  const videoLectures = allLectures.filter((l) => !l.lecture_id.startsWith('pdf-'));
  const currentVideoIndex = videoLectures.findIndex((l) => l.lecture_id === lectureId);
  const prevLecture = currentVideoIndex > 0 ? videoLectures[currentVideoIndex - 1] : null;
  const nextLecture = currentVideoIndex >= 0 && currentVideoIndex < videoLectures.length - 1 ? videoLectures[currentVideoIndex + 1] : null;

  const isVimeo = lecture.video_provider === 'vimeo';

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(lecture.title)} — Criterio</title>
${isVimeo ? '<script src="https://player.vimeo.com/api/player.js"></script>' : ''}
<style>
  ${APP_SHELL_STYLES}
  .lecture-root { display:flex; gap:20px; align-items:flex-start; }
  #sidebar { width:280px; flex-shrink:0; background:#fff; border:1px solid #e2e8f0; border-radius:12px; max-height:80vh; overflow-y:auto; }
  .lecture-root.sidebar-collapsed #sidebar { display:none; }
  #sidebar .sb-head { padding:14px 16px; border-bottom:1px solid #eef1f4; }
  #sidebar .sb-head .t { font-weight:700; font-size:14px; }
  #sidebar .sb-head .s { color:#8a94a6; font-size:12px; }
  #sidebar .sb-section { padding:10px 16px 4px; font-size:11px; font-weight:700; color:#8a94a6; text-transform:uppercase; }
  #sidebar .sb-item { display:block; padding:8px 16px; font-size:13px; color:#333; border-left:3px solid transparent; }
  #sidebar .sb-item.active { border-left-color:#d41128; background:#fdecee; color:#a10f22; font-weight:700; }
  #main { flex:1; min-width:0; }
  .crumb { font-size:13px; color:#8a94a6; margin-bottom:8px; }
  .crumb a { color:#57606a; }
  .lecture-header { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:14px; }
  .lecture-header-left { display:flex; align-items:center; gap:12px; min-width:0; }
  .lecture-title { font-size:20px; font-weight:800; }
  .sidebar-toggle { flex-shrink:0; border:1px solid #e2e8f0; background:#fff; border-radius:8px; width:36px; height:36px; font-size:15px; cursor:pointer; color:#333; }
  .sidebar-toggle:hover { background:#f7f8fa; }
  .lecture-nav { display:flex; justify-content:space-between; gap:8px; margin-top:12px; }
  .lecture-nav a, .lecture-nav span { border:1px solid #e2e8f0; background:#fff; border-radius:8px; padding:8px 14px; font-size:13px; font-weight:700; color:#333; text-decoration:none; }
  .lecture-nav a:hover { background:#f7f8fa; }
  .lecture-nav .disabled { opacity:0.4; pointer-events:none; }
  .top-row { display:flex; gap:16px; align-items:stretch; }
  .video-col { flex:2.2; min-width:0; }
  .video-col video { width:100%; border-radius:12px; background:#000; }
  .video-col .vimeo-wrap { position:relative; width:100%; padding-top:56.25%; border-radius:12px; overflow:hidden; background:#000; }
  .video-col .vimeo-wrap iframe { position:absolute; top:0; left:0; width:100%; height:100%; border:none; }
  .askai-col { flex:1; min-width:280px; max-width:380px; display:flex; flex-direction:column; background:#fff; border:1px solid #e2e8f0; border-radius:12px; overflow:hidden; }
  .askai-col .askai-head { padding:10px 14px; border-bottom:1px solid #eef1f4; font-weight:700; font-size:13px; }
  .askai-col iframe { flex:1; border:none; min-height:420px; }
  .kc-card { margin-top:14px; }
  .kc-title { font-weight:700; font-size:14px; margin-bottom:2px; }
  .kc-sub { color:#57606a; font-size:12px; margin-bottom:10px; }
  .btn-primary { background:#d41128; color:#fff; border:none; border-radius:8px; padding:8px 16px; font-size:13px; font-weight:700; cursor:pointer; }
  .bottom-row { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:16px; }
  .panel-title { font-weight:700; font-size:14px; margin-bottom:10px; }
  .note-item, .q-item { padding:10px 0; border-top:1px solid #eef1f4; font-size:13px; }
  .note-item:first-child, .q-item:first-child { border-top:none; }
  .q-who { font-weight:700; }
  .q-meta { color:#8a94a6; font-size:11px; }
  .q-reply { margin:6px 0 0 12px; padding:6px 10px; background:#f7f8fa; border-radius:8px; font-size:12px; }
  .inline-form { display:flex; gap:8px; margin-top:10px; }
  .inline-form input { flex:1; border:1px solid #e2e8f0; border-radius:8px; padding:8px 10px; font-size:13px; }
  .inline-form button { border:none; background:#d41128; color:#fff; border-radius:8px; padding:0 14px; font-weight:700; cursor:pointer; }
  .kc-question { border-top:1px solid #eef1f4; padding:10px 0; font-size:13px; }
  .kc-question .opt { display:block; margin:4px 0; cursor:pointer; }
  .kc-question .opt.correct { color:#166534; font-weight:700; }
  .kc-question .opt.incorrect { color:#b91c1c; }
</style></head>
<body>
${renderAppNav('My Courses', studentParam)}
<div class="app-main">
  <div class="crumb"><a href="/app/course/cs101?student=${studentParam || ''}">&larr; Lecture Videos</a></div>
  <div class="lecture-header">
    <div class="lecture-header-left">
      <button class="sidebar-toggle" id="sidebarToggle" type="button" title="Show/hide course content">&#9776;</button>
      <div class="lecture-title">${escapeHtml(lecture.title)}</div>
    </div>
  </div>
  <div class="lecture-root" id="lectureRoot">
    <div id="sidebar">
      <div class="sb-head"><div class="t">Course content</div><div class="s">${allLectures.length} lectures</div></div>
      ${sidebarKeys.map((key) => `
        <div class="sb-section">${escapeHtml((CHAPTER_SECTION_TITLES[key] || key).toUpperCase())}</div>
        ${sidebarSections[key].map((l) => `<a class="sb-item ${l.lecture_id === lectureId ? 'active' : ''}" href="${l.lecture_id.startsWith('pdf-') ? `/pdf/${l.lecture_id.split('-')[1]}?student=${studentParam || ''}` : `/lecture/${l.lecture_id}?student=${studentParam || ''}`}">${escapeHtml(l.title)}</a>`).join('')}
      `).join('')}
    </div>
    <div id="main">
      <div class="top-row">
        <div class="video-col">
          ${lecture.video_url
            ? (lecture.video_provider === 'vimeo'
                ? `<div class="vimeo-wrap"><div id="vimeoPlayer" style="position:absolute;inset:0;"></div></div>`
                : `<video id="lectureVideo" controls src="${lecture.video_url}"></video>`)
            : '<p class="empty">No video attached to this lecture yet.</p>'}
          <div class="lecture-nav">
            ${prevLecture ? `<a href="/lecture/${prevLecture.lecture_id}?student=${studentParam || ''}">&lsaquo; Previous Video</a>` : `<span class="disabled">&lsaquo; Previous Video</span>`}
            ${nextLecture ? `<a href="/lecture/${nextLecture.lecture_id}?student=${studentParam || ''}">Next Video &rsaquo;</a>` : `<span class="disabled">Next Video &rsaquo;</span>`}
          </div>
          <div class="app-card kc-card">
            <div class="kc-title">Knowledge check</div>
            <div class="kc-sub" id="kcSub">Loading...</div>
            <button class="btn-primary" id="kcStart" style="display:none;">Start knowledge check</button>
            <div id="kcQuestions"></div>
          </div>
        </div>
        <div class="askai-col">
          <div class="askai-head">Ask AI</div>
          <iframe id="askaiFrame" src="/widget/${lectureId}"></iframe>
        </div>
      </div>

      <div class="bottom-row">
        <div class="app-card">
          <div class="panel-title">Notes</div>
          <div id="notesList"><p class="empty">Loading...</p></div>
          <div class="inline-form">
            <input id="noteInput" placeholder="Add a note at the current point in the video...">
            <button id="noteSend">Add</button>
          </div>
        </div>
        <div class="app-card">
          <div class="panel-title">Q&amp;A</div>
          <p class="focus-sub" style="margin:-6px 0 6px;">Visible to students and instructors across all sections</p>
          <div id="qaList"><p class="empty">Loading...</p></div>
          <div class="inline-form">
            <input id="qaInput" placeholder="Ask a question about this lecture...">
            <button id="qaSend">Ask</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
  ${APP_IDENTIFY_SCRIPT}
  const LECTURE_ID = ${JSON.stringify(lectureId)};
  const IS_VIMEO = ${isVimeo ? 'true' : 'false'};
  const VIMEO_ID = ${JSON.stringify(isVimeo ? lecture.video_url : null)};

  document.getElementById('sidebarToggle').addEventListener('click', () => {
    document.getElementById('lectureRoot').classList.toggle('sidebar-collapsed');
  });

  function onIdentified(userId, token) {
    // Bug fix: this handler used to only drive client-side AJAX (notes/Q&A/knowledge-check)
    // and the Ask AI iframe -- it never upgraded the URL with a verified &t= token like the
    // other app pages do. That left every server-rendered link on this page (sidebar videos,
    // Previous/Next Video) permanently built from whatever (possibly blank) ?student= the
    // server saw on the initial load, even after a legitimate identify arrived. Redirect once
    // to pick up the verified token, same pattern as /app/home and /app/course/cs101.
    if (userId && token && !params.get('t')) {
      location.href = '/lecture/' + encodeURIComponent(LECTURE_ID) + '?student=' + userId + '&t=' + encodeURIComponent(token);
      return;
    }
    loadNotes();
    loadQA();
    loadKnowledgeCheck();
    const frame = document.getElementById('askaiFrame');
    if (frame.contentWindow) frame.contentWindow.postMessage({type:'identify', userId}, '*');
  }
  if (studentUserId) setTimeout(() => onIdentified(studentUserId), 300);

  document.getElementById('askaiFrame').addEventListener('load', () => {
    if (studentUserId) document.getElementById('askaiFrame').contentWindow.postMessage({type:'identify', userId: studentUserId}, '*');
  });

  // ---- Video tracking: same play/pause/ended/heartbeat pattern regardless of whether
  // the source is a native <video> tag or the Vimeo Player SDK. Both paths just keep
  // currentPosition/currentDuration updated and call the same track()/fetch('/track')
  // -- nothing downstream (analytics, chat position, notes, Q&A) needs to know which
  // provider is playing. Vimeo's SDK is promise-based (getCurrentTime() returns a
  // Promise), so rather than awaiting it everywhere position is needed, we just track
  // it from the 'timeupdate' event payload, which already carries seconds/duration.
  let currentPosition = 0;
  let currentDuration = null;
  let lastHeartbeat = 0;

  function track(type) {
    if (!studentUserId) return;
    fetch('/track', { method:'POST', headers:{'Content-Type':'application/json'}, keepalive:true,
      body: JSON.stringify({ lecture_id: LECTURE_ID, student_userid: studentUserId, event_type: type, position: currentPosition, duration: currentDuration }) }).catch(()=>{});
    // Keep the Ask AI widget's notion of "where the learner is" fresh too, not just at
    // page load -- this is what makes Contextual Ask work without the student having to
    // type an explicit timestamp ("what does THIS mean" should just work).
    const frame = document.getElementById('askaiFrame');
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: 'identify', userId: studentUserId, position: currentPosition }, '*');
    }
  }

  if (IS_VIMEO) {
    var vimeoPlayer = new Vimeo.Player('vimeoPlayer', { id: Number(VIMEO_ID), responsive: true });
    vimeoPlayer.on('play', () => track('play'));
    vimeoPlayer.on('pause', () => track('pause'));
    vimeoPlayer.on('ended', () => track('ended'));
    vimeoPlayer.on('seeked', (data) => { currentPosition = data.seconds; track('seek'); });
    vimeoPlayer.on('timeupdate', (data) => {
      currentPosition = data.seconds;
      currentDuration = (data.duration && isFinite(data.duration)) ? data.duration : null;
      if (currentPosition - lastHeartbeat >= 5) { lastHeartbeat = currentPosition; track('heartbeat'); }
    });
  } else {
    const video = document.getElementById('lectureVideo');
    if (video) {
      video.addEventListener('play', () => track('play'));
      video.addEventListener('pause', () => track('pause'));
      video.addEventListener('ended', () => track('ended'));
      video.addEventListener('seeked', () => { currentPosition = video.currentTime; track('seek'); });
      video.addEventListener('timeupdate', () => {
        currentPosition = video.currentTime;
        currentDuration = (video.duration && isFinite(video.duration)) ? video.duration : null;
        if (currentPosition - lastHeartbeat >= 5) { lastHeartbeat = currentPosition; track('heartbeat'); }
      });
    }
  }

  // ---- Citation jump: clicking a timestamp chip in the Ask AI widget posts this up
  // from the iframe; seek whichever player is actually active to that exact moment. ----
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'seekTo' && typeof event.data.position === 'number') {
      if (IS_VIMEO && typeof vimeoPlayer !== 'undefined') {
        vimeoPlayer.setCurrentTime(event.data.position).then(() => vimeoPlayer.play());
      } else {
        const v = document.getElementById('lectureVideo');
        if (v) { v.currentTime = event.data.position; v.play(); }
      }
    }
  });

  // ---- Notes ----
  function formatNoteTs(seconds) {
    if (seconds === null || seconds === undefined) return null;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ':' + String(s).padStart(2, '0');
  }
  function loadNotes() {
    fetch('/notes/lecture?student=' + studentUserId + '&lecture=' + LECTURE_ID).then(r=>r.json()).then(data => {
      const list = document.getElementById('notesList');
      list.innerHTML = '';
      if (!data.notes || !data.notes.length) { list.innerHTML = '<p class="empty">No notes yet — add one at the current point in the video.</p>'; return; }
      data.notes.forEach(n => {
        const div = document.createElement('div');
        div.className = 'note-item';
        const ts = formatNoteTs(n.position);
        if (ts !== null) {
          const tsEl = document.createElement('span');
          tsEl.style.cssText = 'font-weight:700; color:#d41128; margin-right:8px;';
          tsEl.textContent = ts;
          div.appendChild(tsEl);
        }
        const textEl = document.createElement('span');
        textEl.textContent = n.text;
        div.appendChild(textEl);
        list.appendChild(div);
      });
    });
  }
  document.getElementById('noteSend').addEventListener('click', () => {
    const text = document.getElementById('noteInput').value.trim();
    if (!text || !studentUserId) return;
    fetch('/notes', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ student_userid: studentUserId, lecture_id: LECTURE_ID, position: currentPosition, text }) })
      .then(() => { document.getElementById('noteInput').value = ''; loadNotes(); });
  });

  // ---- Q&A ----
  function loadQA() {
    fetch('/qa/lecture?lecture=' + LECTURE_ID).then(r=>r.json()).then(data => {
      const list = document.getElementById('qaList');
      list.innerHTML = '';
      if (!data.questions || !data.questions.length) { list.innerHTML = '<p class="empty">No questions yet — be the first to ask something about this lecture.</p>'; return; }
      data.questions.forEach(q => {
        const div = document.createElement('div');
        div.className = 'q-item';
        div.innerHTML = '<span class="q-who"></span> <span class="q-meta"></span><div></div>';
        div.querySelector('.q-who').textContent = q.fullname || 'Student';
        div.querySelector('.q-meta').textContent = new Date(q.created_at).toLocaleString();
        div.querySelectorAll('div')[0].textContent = q.question;
        (q.replies || []).forEach(r => {
          const rd = document.createElement('div');
          rd.className = 'q-reply';
          rd.textContent = (r.fullname || 'Instructor') + ': ' + r.reply;
          div.appendChild(rd);
        });
        list.appendChild(div);
      });
    });
  }
  document.getElementById('qaSend').addEventListener('click', () => {
    const question = document.getElementById('qaInput').value.trim();
    if (!question || !studentUserId) return;
    fetch('/qa/ask', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ lecture_id: LECTURE_ID, student_userid: studentUserId, question, position: currentPosition }) })
      .then(() => { document.getElementById('qaInput').value = ''; loadQA(); });
  });

  // ---- Knowledge check ----
  let kcData = null;
  function loadKnowledgeCheck() {
    fetch('/popups/lecture?lecture_id=' + LECTURE_ID).then(r=>r.json()).then(data => {
      kcData = data;
      const total = (data.popups || []).length + (data.endOfVideo || []).length;
      document.getElementById('kcSub').textContent = total
        ? total + ' question' + (total === 1 ? '' : 's') + ' covering this video — see your score and what to revisit.'
        : 'No knowledge-check questions for this video yet.';
      if (total) document.getElementById('kcStart').style.display = 'inline-block';
    });
  }
  document.getElementById('kcStart').addEventListener('click', () => {
    document.getElementById('kcStart').style.display = 'none';
    const all = [...(kcData.popups || []), ...(kcData.endOfVideo || [])];
    const container = document.getElementById('kcQuestions');
    container.innerHTML = '';
    all.forEach(q => {
      const div = document.createElement('div');
      div.className = 'kc-question';
      const qd = document.createElement('div');
      qd.textContent = q.question;
      qd.style.fontWeight = '700';
      div.appendChild(qd);
      q.options.forEach((opt, i) => {
        const optEl = document.createElement('a');
        optEl.className = 'opt';
        optEl.textContent = opt;
        optEl.href = '#';
        optEl.addEventListener('click', (e) => {
          e.preventDefault();
          if (optEl.dataset.answered) return;
          fetch('/popups/respond', { method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ popup_question_id: q.id, student_userid: studentUserId, selected_index: i }) })
            .then(r=>r.json()).then(res => {
              div.querySelectorAll('.opt').forEach(o => o.dataset.answered = '1');
              optEl.classList.add(res.correct ? 'correct' : 'incorrect');
            });
        });
        div.appendChild(optEl);
      });
      container.appendChild(div);
    });
  });
</script>
</body></html>`);
});

// Compact, light-themed leaderboard made to embed in a small block/iframe
// (e.g. the Moodle block_criterio course-page widget) -- same scoring as
// /leaderboard and the Home dashboard's leaderboard card, just laid out for
// a narrow, short container instead of a full page.
app.get('/leaderboard/embed', (req, res) => {
  const students = db.prepare('SELECT * FROM students').all();
  const progressRows = db.prepare(
    `SELECT student_userid, MAX(position) as maxpos, MAX(duration) as dur, lecture_id
     FROM events WHERE event_type IN ('heartbeat','pause','ended','seek') AND position IS NOT NULL
     GROUP BY student_userid, lecture_id`
  ).all();
  const chatRows = db.prepare(
    `SELECT student_userid, COUNT(*) as cnt FROM events WHERE event_type = 'chat_message' GROUP BY student_userid`
  ).all();
  const chatByStudent = {};
  for (const r of chatRows) chatByStudent[r.student_userid] = r.cnt;

  const pctByStudent = {};
  for (const r of progressRows) {
    if (!r.dur) continue;
    (pctByStudent[r.student_userid] ||= []).push(Math.min(100, (r.maxpos / r.dur) * 100));
  }

  const grades = db.prepare('SELECT * FROM grades').all();
  const gradeByStudent = {};
  for (const g of grades) gradeByStudent[g.userid] = g.quiz_percent;

  const ranked = students
    .filter((s) => s.username !== 'teacher1')
    .map((s) => {
      const pcts = pctByStudent[s.userid] || [];
      const avgWatch = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : 0;
      const quizPct = gradeByStudent[s.userid] ?? 0;
      const chatCount = chatByStudent[s.userid] || 0;
      const score = Math.round(avgWatch * 0.4 + quizPct * 0.4 + Math.min(chatCount * 5, 20));
      return { ...s, score };
    })
    .sort((a, b) => b.score - a.score);

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Leaderboard</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Segoe UI",system-ui,sans-serif; background:#fff; color:#0b1220; }
  #wrap { padding:14px 16px; }
  h1 { font-size:13px; font-weight:800; margin:0 0 2px; text-transform:uppercase; letter-spacing:0.04em; color:#8a94a6; }
  p.sub { color:#57606a; font-size:12px; margin:0 0 10px; }
  .lb-row { display:flex; align-items:center; gap:10px; padding:7px 0; border-top:1px solid #eef1f4; }
  .lb-row:first-of-type { border-top:none; }
  .lb-rank { width:20px; color:#8a94a6; font-weight:700; font-size:13px; }
  .lb-rank.top1 { color:#d41128; }
  .lb-avatar { width:24px; height:24px; border-radius:50%; background:#eef1f4; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; flex-shrink:0; }
  .lb-name { flex:1; font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .lb-pts { background:#fdecee; color:#d41128; font-weight:700; font-size:11px; padding:2px 8px; border-radius:8px; white-space:nowrap; }
  .empty { color:#8a94a6; font-size:12px; }
</style></head>
<body>
  <div id="wrap">
    <h1>Leaderboard</h1>
    <p class="sub">Points = 40% avg. video completion + 40% quiz score + up to 20 bonus for AI tutor use.</p>
    ${ranked.map((s, i) => `
      <div class="lb-row">
        <div class="lb-rank ${i === 0 ? 'top1' : ''}">#${i + 1}</div>
        <div class="lb-avatar">${escapeHtml(s.fullname.slice(0, 1))}</div>
        <div class="lb-name">${escapeHtml(s.fullname)}</div>
        <div class="lb-pts">${s.score} pts</div>
      </div>`).join('') || '<p class="empty">No data yet.</p>'}
  </div>
</body></html>`);
});

app.get('/leaderboard', (req, res) => {
  const students = db.prepare('SELECT * FROM students').all();
  const progressRows = db.prepare(
    `SELECT student_userid, MAX(position) as maxpos, MAX(duration) as dur, lecture_id
     FROM events WHERE event_type IN ('heartbeat','pause','ended','seek') AND position IS NOT NULL
     GROUP BY student_userid, lecture_id`
  ).all();
  const chatRows = db.prepare(
    `SELECT student_userid, COUNT(*) as cnt FROM events WHERE event_type = 'chat_message' GROUP BY student_userid`
  ).all();
  const chatByStudent = {};
  for (const r of chatRows) chatByStudent[r.student_userid] = r.cnt;

  const pctByStudent = {};
  for (const r of progressRows) {
    if (!r.dur) continue;
    const pct = Math.min(100, (r.maxpos / r.dur) * 100);
    (pctByStudent[r.student_userid] ||= []).push(pct);
  }

  const grades = db.prepare('SELECT * FROM grades').all();
  const gradeByStudent = {};
  for (const g of grades) gradeByStudent[g.userid] = g.quiz_percent;

  const ranked = students
    .filter((s) => s.username !== 'teacher1')
    .map((s) => {
      const pcts = pctByStudent[s.userid] || [];
      const avgWatch = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : 0;
      const quizPct = gradeByStudent[s.userid] ?? 0;
      const chatCount = chatByStudent[s.userid] || 0;
      const chatBonus = Math.min(chatCount * 5, 20);
      const score = Math.round(avgWatch * 0.4 + quizPct * 0.4 + chatBonus);
      return { ...s, avgWatch: Math.round(avgWatch), quizPct: Math.round(quizPct), chatCount, score };
    })
    .sort((a, b) => b.score - a.score);

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Leaderboard</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; background:#0f1012; color:#e9e9ea; margin:0; padding:24px; max-width:640px; }
  h1 { font-size:20px; }
  p.sub { color:#999; margin-top:0; }
  .row { display:flex; align-items:center; gap:12px; padding:10px 12px; border-radius:8px; margin-bottom:8px; background:#18191c; border:1px solid #26272b; }
  .rank { width:28px; font-weight:700; color:#999; text-align:center; }
  .rank.top1 { color:#d6293e; }
  .name { flex:1; font-weight:600; }
  .breakdown { color:#999; font-size:12px; }
  .score { font-weight:700; background:#d6293e; padding:4px 10px; border-radius:6px; min-width:36px; text-align:center; }
</style></head>
<body>
  <h1>Leaderboard</h1>
  <p class="sub">Score = 40% avg. video completion + 40% quiz score + up to 20 bonus points for chatbot Q&amp;A.</p>
  ${ranked.map((s, i) => `
    <div class="row">
      <div class="rank ${i === 0 ? 'top1' : ''}">#${i + 1}</div>
      <div class="name">${escapeHtml(s.fullname)}<div class="breakdown">${s.avgWatch}% watched · ${s.quizPct}% quiz · ${s.chatCount} chat msgs</div></div>
      <div class="score">${s.score}</div>
    </div>
  `).join('')}
</body></html>`);
});

// ---- Bookable formative sessions ----

app.post('/sessions/create', express.urlencoded({ extended: true }), (req, res) => {
  const { title, starts_at, duration_minutes, capacity } = req.body;
  if (!title || !starts_at) return res.status(400).send('title and starts_at required');
  db.prepare(
    'INSERT INTO sessions (title, starts_at, duration_minutes, capacity, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(title, new Date(starts_at).getTime(), parseInt(duration_minutes, 10) || 30, parseInt(capacity, 10) || 1, Date.now());
  res.redirect('/sessions');
});

app.post('/sessions/:id/book', express.urlencoded({ extended: true }), (req, res) => {
  const { as } = req.body;
  if (!as) return res.status(400).send('missing student');
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).send('session not found');
  const bookedCount = db.prepare('SELECT COUNT(*) as c FROM session_bookings WHERE session_id = ?').get(req.params.id).c;
  if (bookedCount >= session.capacity) return res.status(400).send('session is full');
  try {
    db.prepare('INSERT INTO session_bookings (session_id, student_userid, created_at) VALUES (?, ?, ?)')
      .run(req.params.id, as, Date.now());
  } catch (e) { /* already booked, ignore */ }
  res.redirect(`/sessions?as=${as}`);
});

app.get('/sessions', (req, res) => {
  const asId = req.query.as || req.query.student || '';
  const viewer = asId ? db.prepare('SELECT username FROM students WHERE userid = ?').get(asId) : null;
  const isInstructorView = Boolean(viewer && viewer.username === 'teacher1');
  const students = db.prepare('SELECT * FROM students ORDER BY fullname').all();
  const now = Date.now();
  const upcoming = db.prepare('SELECT * FROM sessions WHERE starts_at > ? ORDER BY starts_at ASC').all(now);

  const rowsHtml = upcoming.map((s) => {
    const bookings = db.prepare(
      `SELECT sb.*, st.fullname FROM session_bookings sb JOIN students st ON st.userid = sb.student_userid WHERE session_id = ?`
    ).all(s.id);
    const isFull = bookings.length >= s.capacity;
    const iBooked = asId && bookings.some((b) => String(b.student_userid) === String(asId));
    const dt = new Date(s.starts_at);
    return `
      <div class="row">
        <div class="info">
          <div class="title">${escapeHtml(s.title)}</div>
          <div class="sub">${dt.toLocaleString()} · ${s.duration_minutes} min · ${bookings.length}/${s.capacity} booked</div>
          ${bookings.length ? `<div class="sub">${bookings.map((b) => `${escapeHtml(b.fullname)} (<a href="/sessions/${s.id}/summary?student=${b.student_userid}" style="color:#d6293e;">pre-session summary</a>)`).join(', ')}</div>` : ''}
        </div>
        ${asId
          ? (iBooked
            ? '<span class="badge">Booked</span>'
            : (isFull ? '<span class="badge full">Full</span>' : `<form method="post" action="/sessions/${s.id}/book"><input type="hidden" name="as" value="${asId}"><button>Book</button></form>`))
          : ''}
      </div>`;
  }).join('') || '<p class="sub">No upcoming sessions.</p>';

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Formative Sessions</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; background:#0f1012; color:#e9e9ea; margin:0; padding:24px; max-width:720px; }
  h1 { font-size:20px; margin-bottom:2px; }
  h2 { font-size:15px; margin-top:32px; border-bottom:1px solid #333; padding-bottom:6px; }
  p.sub { color:#999; margin-top:0; }
  select, input, button { background:#18191c; color:#e9e9ea; border:1px solid #333; border-radius:6px; padding:6px 10px; }
  button { background:#d6293e; border:none; cursor:pointer; }
  .row { display:flex; align-items:center; gap:12px; padding:10px 12px; border-radius:8px; margin-bottom:8px; background:#18191c; border:1px solid #26272b; }
  .row .info { flex:1; }
  .title { font-weight:600; }
  .sub { color:#999; font-size:12px; margin:2px 0 0; }
  .badge { background:#26272b; padding:4px 10px; border-radius:6px; font-size:12px; }
  .badge.full { color:#d6293e; }
  form.create { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:12px; }
</style></head>
<body>
  <h1>Formative Sessions</h1>
  <form method="get" action="/sessions">
    <select name="as" onchange="this.form.submit()">
      <option value="">Select your name to book...</option>
      ${students.map((st) => `<option value="${st.userid}" ${String(st.userid) === String(asId) ? 'selected' : ''}>${escapeHtml(st.fullname)}</option>`).join('')}
    </select>
  </form>

  <h2>Upcoming Sessions</h2>
  ${rowsHtml}

  ${isInstructorView ? `
  <h2>Create a Session (instructor)</h2>
  <form class="create" method="post" action="/sessions/create">
    <input name="title" placeholder="Title" required>
    <input name="starts_at" type="datetime-local" required>
    <input name="duration_minutes" type="number" placeholder="Minutes" value="30" style="width:80px">
    <input name="capacity" type="number" placeholder="Capacity" value="1" style="width:80px">
    <button type="submit">Create</button>
  </form>

  <p><a href="/sessions/smart-invite?as=${asId}" style="color:#d6293e;">Smart Invite: who should be invited to a session? &rarr;</a></p>
  ` : ''}
</body></html>`);
});

// ---- Smart Invite: rules-based (no LLM) flagging of which students need a formative
// session, based on gaps already visible in engagement/quiz/rubric-coverage data. ----

app.get('/sessions/smart-invite', (req, res) => {
  const viewerId = req.query.as || req.query.student || '';
  const viewer = viewerId ? db.prepare('SELECT username FROM students WHERE userid = ?').get(viewerId) : null;
  if (!viewer || viewer.username !== 'teacher1') {
    return res.status(403).send('Smart Invite is only available to instructors.');
  }
  const students = db.prepare("SELECT * FROM students WHERE username != 'teacher1'").all();
  const now = Date.now();
  const upcoming = db.prepare('SELECT * FROM sessions WHERE starts_at > ? ORDER BY starts_at ASC').all(now);

  const progressRows = db.prepare(
    `SELECT student_userid, lecture_id, MAX(position) as maxpos, MAX(duration) as dur
     FROM events WHERE event_type IN ('heartbeat', 'pause', 'ended', 'seek') AND position IS NOT NULL
     GROUP BY student_userid, lecture_id`
  ).all();
  const chatCountByStudent = {};
  for (const r of db.prepare("SELECT student_userid, COUNT(*) as cnt FROM events WHERE event_type = 'chat_message' GROUP BY student_userid").all()) {
    chatCountByStudent[r.student_userid] = r.cnt;
  }
  const grades = db.prepare('SELECT * FROM grades').all();
  const gradeByStudent = {};
  for (const g of grades) gradeByStudent[g.userid] = g.quiz_percent;
  const popupByStudent = {};
  for (const r of db.prepare("SELECT student_userid, status, COUNT(*) as cnt FROM popup_responses GROUP BY student_userid, status").all()) {
    (popupByStudent[r.student_userid] ||= {})[r.status] = r.cnt;
  }

  const progressByStudent = {};
  for (const r of progressRows) {
    if (!r.dur) continue;
    (progressByStudent[r.student_userid] ||= []).push({ lecture_id: r.lecture_id, pct: Math.min(100, (r.maxpos / r.dur) * 100) });
  }

  const WATCH_THRESHOLD = 50;
  const QUIZ_THRESHOLD = 50;

  const suggestions = students.map((s) => {
    const pcts = (progressByStudent[s.userid] || []).map((p) => p.pct);
    const avgWatch = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : 0;
    const quizPct = gradeByStudent[s.userid];
    const chatCount = chatCountByStudent[s.userid] || 0;
    const popups = popupByStudent[s.userid] || {};
    const popupWrong = (popups.answered_incorrect || 0) + (popups.dropped || 0);
    const popupTotal = (popups.answered_correct || 0) + (popups.answered_incorrect || 0) + (popups.dropped || 0);

    const reasons = [];
    if (pcts.length === 0) reasons.push('has not started watching any lecture');
    else if (avgWatch < WATCH_THRESHOLD) reasons.push(`low video completion (${Math.round(avgWatch)}% avg)`);
    if (quizPct === null || quizPct === undefined) reasons.push('has not attempted the quiz');
    else if (quizPct < QUIZ_THRESHOLD) reasons.push(`low quiz score (${Math.round(quizPct)}%)`);
    if (popupTotal > 0 && popupWrong / popupTotal > 0.5) reasons.push(`missed most in-video checks (${popupWrong}/${popupTotal})`);
    if (chatCount === 0) reasons.push('never used the AI tutor');

    return { ...s, reasons, priority: reasons.length };
  })
  .filter((s) => s.reasons.length > 0)
  .sort((a, b) => b.priority - a.priority);

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Smart Invite</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; background:#0f1012; color:#e9e9ea; margin:0; padding:24px; max-width:720px; }
  a.back { color:#d6293e; text-decoration:none; font-size:13px; }
  h1 { font-size:20px; }
  p.sub { color:#999; }
  select, button { background:#18191c; color:#e9e9ea; border:1px solid #333; border-radius:6px; padding:6px 10px; }
  button { background:#d6293e; border:none; cursor:pointer; color:#fff; }
  .card { background:#18191c; border:1px solid #26272b; border-radius:8px; padding:12px; margin-bottom:10px; display:flex; align-items:center; gap:12px; }
  .card .info { flex:1; }
  .card .name { font-weight:600; }
  .card .reasons { font-size:12px; color:#999; margin-top:2px; }
  .priority { background:#d6293e; border-radius:12px; padding:2px 8px; font-size:11px; font-weight:700; }
</style></head>
<body>
  <a class="back" href="/sessions">&larr; Back to sessions</a>
  <h1>Smart Invite</h1>
  <p class="sub">Rules-based (no AI) -- students ranked by how many coverage gaps they have, using data already on record: video completion, quiz score, in-video check accuracy, and AI tutor usage.</p>
  ${suggestions.map((s) => `
    <div class="card">
      <span class="priority">${s.priority}</span>
      <div class="info">
        <div class="name">${escapeHtml(s.fullname)}</div>
        <div class="reasons">${s.reasons.join(' · ')}</div>
      </div>
      ${upcoming.length ? `
        <form method="post" action="/sessions/${upcoming[0].id}/invite">
          <input type="hidden" name="student_userid" value="${s.userid}">
          <button type="submit">Invite to "${escapeHtml(upcoming[0].title)}"</button>
        </form>` : ''}
    </div>`).join('') || '<p class="sub">No students currently show a coverage gap.</p>'}
</body></html>`);
});

app.post('/sessions/:id/invite', express.urlencoded({ extended: true }), (req, res) => {
  const { student_userid } = req.body;
  if (!student_userid) return res.status(400).send('missing student_userid');
  try {
    db.prepare('INSERT INTO session_bookings (session_id, student_userid, created_at) VALUES (?, ?, ?)')
      .run(req.params.id, student_userid, Date.now());
  } catch (e) { /* already booked, ignore */ }
  res.redirect('/sessions/smart-invite');
});

// ---- AI pre-session summaries: grounded ONLY in the student's recorded coverage data,
// never fabricated. Generated on demand, cached per (session, student). ----

function buildCoverageDigest(studentUserid) {
  const lectures = db.prepare("SELECT * FROM lectures WHERE lecture_id NOT LIKE 'pdf-%'").all();
  const progress = db.prepare(
    `SELECT lecture_id, MAX(position) as maxpos, MAX(duration) as dur FROM events
     WHERE student_userid = ? AND event_type IN ('heartbeat','pause','ended','seek') AND position IS NOT NULL
     GROUP BY lecture_id`
  ).all(studentUserid);
  const progressByLecture = {};
  for (const r of progress) progressByLecture[r.lecture_id] = r.dur ? Math.round((r.maxpos / r.dur) * 100) : null;

  const watchedLines = lectures.map((l) => {
    const pct = progressByLecture[l.lecture_id];
    return `- ${l.title}: ${pct === null || pct === undefined ? 'not started' : pct + '% watched'}`;
  });

  const grade = db.prepare('SELECT * FROM grades WHERE userid = ?').get(studentUserid);
  const quizLine = grade && grade.quiz_percent !== null ? `Quiz score: ${Math.round(grade.quiz_percent)}%` : 'Quiz: not attempted';

  const popupRows = db.prepare('SELECT status, COUNT(*) as cnt FROM popup_responses WHERE student_userid = ? GROUP BY status').all(studentUserid);
  const popupLine = popupRows.length
    ? 'In-video check responses: ' + popupRows.map((r) => `${r.status}=${r.cnt}`).join(', ')
    : 'In-video checks: none attempted';

  const chatRows = db.prepare(
    "SELECT lecture_id, payload FROM events WHERE student_userid = ? AND event_type = 'chat_message' ORDER BY created_at DESC LIMIT 8"
  ).all(studentUserid);
  const chatLines = chatRows.map((r) => {
    try { return `- Asked (in ${r.lecture_id}): "${JSON.parse(r.payload).question}"`; } catch (e) { return null; }
  }).filter(Boolean);

  return {
    watched: watchedLines.join('\n') || 'No lectures started.',
    quiz: quizLine,
    popups: popupLine,
    chats: chatLines.length ? chatLines.join('\n') : 'No AI tutor questions asked.',
  };
}

app.post('/sessions/:id/generate-summary', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { student_userid } = req.body;
    if (!student_userid) return res.status(400).send('missing student_userid');
    const student = db.prepare('SELECT * FROM students WHERE userid = ?').get(student_userid);
    const digest = buildCoverageDigest(student_userid);

    const prompt = `You are preparing a short briefing for an instructor ahead of a one-on-one formative session with a student. Use ONLY the data below -- do not infer, guess, or add anything not directly supported by it. If the data is sparse, say so plainly rather than padding the summary.

Student: ${student.fullname}

Video coverage:
${digest.watched}

${digest.quiz}

${digest.popups}

Recent AI tutor questions:
${digest.chats}

Write a 3-5 sentence briefing covering: what they've engaged with, where the gaps are, and one concrete thing the instructor should check in on during the session.`;

    const completion = await chatCompletionWithResilience({
      model: CHAT_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    });
    const summary = completion.choices[0].message.content;

    db.prepare(
      'INSERT INTO session_summaries (session_id, student_userid, summary, created_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(session_id, student_userid) DO UPDATE SET summary = excluded.summary, created_at = excluded.created_at, ' +
      'verifier_reviewed = 0, verifier_reviewed_at = NULL'
    ).run(req.params.id, student_userid, summary, Date.now());

    res.redirect(`/sessions/${req.params.id}/summary?student=${student_userid}`);
  } catch (err) {
    console.error(err);
    const msg = err.name === 'AbortError' ? 'The AI provider took too long to respond.' : 'The AI provider is temporarily unavailable.';
    res.status(502).send('Failed to generate summary: ' + msg + ' Please try again.');
  }
});

app.get('/sessions/:id/summary', (req, res) => {
  const studentId = req.query.student;
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  const student = db.prepare('SELECT * FROM students WHERE userid = ?').get(studentId);
  if (!session || !student) return res.status(404).send('Not found');
  const existing = db.prepare('SELECT * FROM session_summaries WHERE session_id = ? AND student_userid = ?').get(req.params.id, studentId);
  const digest = buildCoverageDigest(studentId);

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Pre-Session Summary</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; background:#0f1012; color:#e9e9ea; margin:0; padding:24px; max-width:640px; }
  a.back { color:#d6293e; text-decoration:none; font-size:13px; }
  h1 { font-size:20px; }
  h2 { font-size:14px; margin-top:24px; color:#999; }
  .summary { background:#18191c; border:1px solid #26272b; border-radius:8px; padding:14px; white-space:pre-wrap; line-height:1.5; }
  .digest { font-size:12px; color:#999; white-space:pre-wrap; background:#141518; border-radius:8px; padding:10px; margin-top:8px; }
  button { background:#d6293e; border:none; color:#fff; border-radius:6px; padding:8px 14px; cursor:pointer; margin-top:12px; }
</style></head>
<body>
  <a class="back" href="/sessions">&larr; Back to sessions</a>
  <h1>${escapeHtml(student.fullname)} &mdash; ${escapeHtml(session.title)}</h1>

  ${existing ? `<div class="summary">${escapeHtml(existing.summary)}</div>
  <p style="color:${existing.verifier_reviewed ? '#2e7d32' : '#999'};font-size:13px;">${existing.verifier_reviewed ? '✓ Reviewed by verifier' : 'Not yet reviewed by a verifier'}</p>` : '<p style="color:#999;">No summary generated yet.</p>'}

  <form method="post" action="/sessions/${session.id}/generate-summary">
    <input type="hidden" name="student_userid" value="${studentId}">
    <button type="submit">${existing ? 'Regenerate' : 'Generate'} summary</button>
  </form>
  ${existing && !existing.verifier_reviewed ? `
  <form method="post" action="/sessions/${session.id}/summary/review">
    <input type="hidden" name="student_userid" value="${studentId}">
    <button type="submit" style="background:#2e7d32;">Mark reviewed</button>
  </form>` : ''}

  <h2>Raw data this summary is grounded in (nothing else)</h2>
  <div class="digest">${escapeHtml(digest.watched)}\n\n${escapeHtml(digest.quiz)}\n${escapeHtml(digest.popups)}\n\n${escapeHtml(digest.chats)}</div>
</body></html>`);
});

app.post('/sessions/:id/summary/review', express.urlencoded({ extended: true }), (req, res) => {
  const { student_userid } = req.body;
  db.prepare(
    'UPDATE session_summaries SET verifier_reviewed = 1, verifier_reviewed_at = ? WHERE session_id = ? AND student_userid = ?'
  ).run(Date.now(), req.params.id, student_userid);
  res.redirect(`/sessions/${req.params.id}/summary?student=${student_userid}`);
});

// ---- In-video pop-up questions ----

// ---- Auto-generated quiz questions, faculty-reviewed before going live ----
// Matches Criterio's generator: writes one MCQ per transcript anchor, in_video popups
// check one just-explained idea, end_of_video questions require broader transfer,
// and drafts sit at status='pending_review' until an instructor approves them.

function buildLectureQuizPrompt(anchors, placement) {
  const anchorBlocks = anchors
    .map((a, i) => `Anchor ${i} — place the quiz right after this point:\n${a.text}`)
    .join('\n\n');

  const roleInstructions = placement === 'end_of_video'
    ? `These questions form the END-OF-VIDEO KNOWLEDGE CHECK.
- Assess transfer after the whole lecture: use a new scenario that asks the student to apply, diagnose, compare, predict, or connect ideas.
- A knowledge-check question must still be useful after the student has already answered every in-video popup correctly.`
    : `These questions are IN-VIDEO POPUP CHECKPOINTS shown immediately after the relevant segment.
- Check one important idea that was just explained in that segment.
- Keep the scenario focused and quick enough to answer before playback resumes.`;

  return `You are writing short university learning checkpoints for a lecture. For EACH anchor below, write ONE multiple-choice question that assesses whether a student can understand or apply the learning in that specific segment — not whether they merely remember what the video mentioned.

The transcript excerpts may be in Arabic or English — regardless of the excerpt's language, always write the question, options, and explanation in ENGLISH.

${roleInstructions}

${anchorBlocks}

Output STRICT JSON only, no markdown fences, no commentary, matching exactly this shape:
{"questions": [{"anchorIndex": number, "questionText": string, "options": [string, string, string, string], "correctOptionIndex": number, "explanation": string}]}

Rules:
- Produce exactly one question per anchor, with matching anchorIndex.
- options must have exactly 4 entries, all plausible, only one correct.
- correctOptionIndex is 0-based (0-3).
- explanation: 1 sentence, grounded in the excerpt, explaining why the correct answer is right.
- Prefer an application, prediction, debugging, comparison, or reasoning scenario over rote recall.
- Do not ask about presentation trivia (editor brand, button clicks, video length).`;
}

app.post('/quiz/generate/:lectureId', async (req, res) => {
  try {
    const lectureId = req.params.lectureId;
    const placement = req.query.placement === 'end_of_video' ? 'end_of_video' : 'in_video';
    const lecture = db.prepare('SELECT * FROM lectures WHERE lecture_id = ?').get(lectureId);
    if (!lecture) return res.status(404).json({ error: 'Unknown lecture_id' });

    const chunkRows = db.prepare('SELECT * FROM chunks WHERE lecture_id = ? ORDER BY chunk_index ASC').all(lectureId);
    if (!chunkRows.length) return res.status(400).json({ error: 'No transcript chunks ingested for this lecture yet' });

    const anchors = placement === 'end_of_video'
      ? [{ text: chunkRows.map((c) => c.text).join(' '), start: chunkRows[chunkRows.length - 1].end_time ?? 0 }]
      : chunkRows.map((c) => ({ text: c.text, start: c.start_time ?? 0 }));

    const prompt = buildLectureQuizPrompt(anchors, placement);
    const completion = await chatCompletionWithResilience({
      model: CHAT_MODEL,
      messages: [
        { role: 'system', content: 'You are a university learning-assessment writing engine. Respond only with valid JSON, no commentary.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.4,
    });

    const parsed = JSON.parse(completion.choices[0].message.content.replace(/```json|```/g, '').trim());
    const insert = db.prepare(
      'INSERT INTO popup_questions (lecture_id, timestamp, question, options, correct_index, explanation, placement, status, created_at) ' +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_review', ?)"
    );
    let count = 0;
    for (const q of parsed.questions || []) {
      const anchor = anchors[q.anchorIndex];
      if (!anchor) continue;
      insert.run(lectureId, anchor.start, q.questionText, JSON.stringify(q.options), q.correctOptionIndex, q.explanation || '', placement, Date.now());
      count++;
    }

    res.json({ ok: true, generated: count, placement });
  } catch (err) {
    console.error(err);
    const msg = err.name === 'AbortError' ? 'The AI provider took too long to respond.' : 'The AI provider is temporarily unavailable.';
    res.status(502).json({ error: msg + ' Please try again.' });
  }
});

app.get('/quiz/review', (req, res) => {
  const lectureId = req.query.lecture || '';
  const lectures = db.prepare('SELECT * FROM lectures').all().sort((a, b) => lectureSortKey(a.lecture_id) - lectureSortKey(b.lecture_id));
  const pending = lectureId
    ? db.prepare("SELECT * FROM popup_questions WHERE lecture_id = ? AND status = 'pending_review' ORDER BY placement, timestamp").all(lectureId)
    : [];

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Quiz Review</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; background:#0f1012; color:#e9e9ea; margin:0; padding:24px; max-width:720px; }
  h1 { font-size:20px; }
  select, button { background:#18191c; color:#e9e9ea; border:1px solid #333; border-radius:6px; padding:6px 10px; }
  button.approve { background:#2e7d32; border:none; cursor:pointer; color:#fff; }
  button.reject { background:#d6293e; border:none; cursor:pointer; color:#fff; margin-left:6px; }
  .card { background:#18191c; border:1px solid #26272b; border-radius:8px; padding:12px; margin-bottom:10px; }
  .card .meta { color:#999; font-size:12px; margin-bottom:6px; }
  .card .opts { margin:8px 0; padding-left:18px; font-size:13px; }
  .card .opts li.correct { color:#2e7d32; font-weight:600; }
  .card .explain { font-size:12px; color:#999; }
  form.inline { display:inline; }
</style></head>
<body>
  <h1>Quiz Review (instructor)</h1>
  <form method="get" action="/quiz/review">
    <select name="lecture" onchange="this.form.submit()">
      <option value="">Select a lecture...</option>
      ${lectures.map((l) => `<option value="${l.lecture_id}" ${l.lecture_id === lectureId ? 'selected' : ''}>${escapeHtml(l.title)}</option>`).join('')}
    </select>
  </form>
  ${lectureId ? `
    <p>
      <form class="inline" method="post" action="/quiz/generate/${lectureId}?placement=in_video" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Generating...';">
        <button type="submit">Generate in-video popups</button>
      </form>
      <form class="inline" method="post" action="/quiz/generate/${lectureId}?placement=end_of_video" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Generating...';">
        <button type="submit">Generate end-of-video check</button>
      </form>
    </p>
    ${pending.map((q) => {
      const opts = JSON.parse(q.options);
      return `<div class="card">
        <div class="meta">${q.placement} · ${formatTimestamp(q.timestamp)}</div>
        <div>${escapeHtml(q.question)}</div>
        <ol class="opts">${opts.map((o, i) => `<li class="${i === q.correct_index ? 'correct' : ''}">${escapeHtml(o)}</li>`).join('')}</ol>
        <div class="explain">${escapeHtml(q.explanation || '')}</div>
        <form class="inline" method="post" action="/quiz/review/${q.id}/approve"><button class="approve" type="submit">Approve</button></form>
        <form class="inline" method="post" action="/quiz/review/${q.id}/reject"><button class="reject" type="submit">Reject</button></form>
      </div>`;
    }).join('') || '<p>No pending drafts. Generate some above.</p>'}
  ` : ''}
</body></html>`);
});

app.post('/quiz/review/:id/approve', express.urlencoded({ extended: true }), (req, res) => {
  const q = db.prepare('SELECT * FROM popup_questions WHERE id = ?').get(req.params.id);
  db.prepare("UPDATE popup_questions SET status = 'approved' WHERE id = ?").run(req.params.id);
  res.redirect(`/quiz/review?lecture=${encodeURIComponent(q?.lecture_id || '')}`);
});

app.post('/quiz/review/:id/reject', express.urlencoded({ extended: true }), (req, res) => {
  const q = db.prepare('SELECT * FROM popup_questions WHERE id = ?').get(req.params.id);
  db.prepare("UPDATE popup_questions SET status = 'rejected' WHERE id = ?").run(req.params.id);
  res.redirect(`/quiz/review?lecture=${encodeURIComponent(q?.lecture_id || '')}`);
});

app.post('/popups/create', express.urlencoded({ extended: true }), (req, res) => {
  const { lecture_id, timestamp, question, options, correct_index, placement } = req.body;
  if (!lecture_id || timestamp === undefined || !question || !options) {
    return res.status(400).send('lecture_id, timestamp, question and options are required');
  }
  const optArray = Array.isArray(options) ? options : String(options).split('\n').map((s) => s.trim()).filter(Boolean);
  db.prepare(
    'INSERT INTO popup_questions (lecture_id, timestamp, question, options, correct_index, placement, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(lecture_id, parseFloat(timestamp), question, JSON.stringify(optArray), parseInt(correct_index, 10) || 0, placement || 'in_video', 'approved', Date.now());
  res.redirect(`/popups?lecture=${encodeURIComponent(lecture_id)}`);
});

app.get('/popups/lecture', (req, res) => {
  const { lecture_id } = req.query;
  if (!lecture_id) return res.status(400).json({ error: 'lecture_id is required' });
  const rows = db.prepare(
    "SELECT * FROM popup_questions WHERE lecture_id = ? AND status = 'approved' ORDER BY timestamp ASC"
  ).all(lecture_id);
  res.json({
    popups: rows
      .filter((r) => r.placement === 'in_video')
      .map((r) => ({ id: r.id, timestamp: r.timestamp, question: r.question, options: JSON.parse(r.options) })),
    endOfVideo: rows
      .filter((r) => r.placement === 'end_of_video')
      .map((r) => ({ id: r.id, question: r.question, options: JSON.parse(r.options) })),
  });
});

app.post('/popups/respond', (req, res) => {
  const { popup_question_id, student_userid, selected_index, status } = req.body;
  if (!popup_question_id || !student_userid) {
    return res.status(400).json({ error: 'popup_question_id and student_userid are required' });
  }

  let finalStatus = status || 'dropped';
  let correct = null;
  let feedback = {};
  if (selected_index !== undefined && selected_index !== null) {
    const q = db.prepare('SELECT correct_index, explanation FROM popup_questions WHERE id = ?').get(popup_question_id);
    correct = !!q && parseInt(selected_index, 10) === q.correct_index;
    finalStatus = correct ? 'answered_correct' : 'answered_incorrect';
    // Only once the student has committed an answer -- lets the knowledge
    // check show the right option and why.
    if (q) feedback = { correct_index: q.correct_index, explanation: q.explanation || null };
  }

  db.prepare(
    'INSERT INTO popup_responses (popup_question_id, student_userid, status, created_at) VALUES (?, ?, ?, ?)'
  ).run(popup_question_id, student_userid, finalStatus, Date.now());
  res.json({ ok: true, correct, ...feedback });

  // An actual answer (not a skipped/dropped pop-up) changes the student's
  // quick-check score -- push it to their LMS gradebook when this session
  // came through an LTI launch that can receive grades.
  if (correct !== null && req.ltiResourceLinkId && req.verifiedUserId) {
    pushQuickCheckGrade(req.verifiedUserId, req.ltiResourceLinkId);
  }
});

// ---- Grades back to the LMS gradebook (LTI Assignment and Grade Services) ----
// rennix-lti owns the LMS side (line items, service tokens, POST /ags/score);
// this is the "a graded event happened" half its README leaves to us. The
// score is the student's quick-check result across the course: distinct
// pop-up questions whose latest answer is correct, out of all pop-up questions
// available, as a percentage. It's pushed to the gradebook column of the
// Tutor Bot activity the student launched from (the session's resource link).
const RENNIX_LTI_URL = process.env.RENNIX_LTI_URL || null;

function quickCheckScore(userid) {
  // Approved questions only -- AI-generated ones waiting in /quiz/review aren't shown to students yet.
  const total = db.prepare("SELECT COUNT(*) AS n FROM popup_questions WHERE status = 'approved'").get().n;
  if (!total) return null;
  const correct = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT r.popup_question_id, r.status FROM popup_responses r
      JOIN popup_questions q ON q.id = r.popup_question_id AND q.status = 'approved'
      WHERE r.student_userid = ? AND r.status IN ('answered_correct', 'answered_incorrect')
        AND r.id = (SELECT MAX(r2.id) FROM popup_responses r2
                    WHERE r2.popup_question_id = r.popup_question_id AND r2.student_userid = r.student_userid
                      AND r2.status IN ('answered_correct', 'answered_incorrect'))
    ) latest WHERE latest.status = 'answered_correct'
  `).get(userid).n;
  const answered = db.prepare(`
    SELECT COUNT(DISTINCT r.popup_question_id) AS n FROM popup_responses r
    JOIN popup_questions q ON q.id = r.popup_question_id AND q.status = 'approved'
    WHERE r.student_userid = ? AND r.status IN ('answered_correct', 'answered_incorrect')
  `).get(userid).n;
  return { score: Math.round((correct / total) * 1000) / 10, scoreMaximum: 100, complete: answered >= total };
}

function pushQuickCheckGrade(userid, resourceLinkId) {
  if (!RENNIX_LTI_URL || !TENANT_ADMIN_SECRET) return;
  const tenant = tenantContext.getStore()?.tenant || DEFAULT_TENANT;
  let result;
  try { result = quickCheckScore(userid); } catch (e) { console.error('[AGS] scoring failed:', e.message); return; }
  if (!result) return;
  fetch(new URL('/ags/score', RENNIX_LTI_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tenant-admin-secret': TENANT_ADMIN_SECRET },
    body: JSON.stringify({
      tenant, userid, resourceLinkId,
      score: result.score, scoreMaximum: result.scoreMaximum,
      label: 'Rennix quick checks',
      activityProgress: result.complete ? 'Completed' : 'InProgress',
      gradingProgress: 'FullyGraded',
    }),
  }).then(async (resp) => {
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.error(`[AGS] score push for user ${userid} failed (${resp.status}): ${detail.slice(0, 200)}`);
      logAuditEvent('ags_push_failed', `status=${resp.status} resource_link=${resourceLinkId}`, null, tenant);
    }
  }).catch((e) => console.error('[AGS] score push failed:', e.message));
}

app.get('/popups', (req, res) => {
  const lectureId = req.query.lecture || '';
  const lectures = db.prepare('SELECT * FROM lectures').all().sort((a, b) => lectureSortKey(a.lecture_id) - lectureSortKey(b.lecture_id));
  const existing = lectureId
    ? db.prepare('SELECT * FROM popup_questions WHERE lecture_id = ? ORDER BY timestamp ASC').all(lectureId)
    : [];

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Pop-up Questions</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; background:#0f1012; color:#e9e9ea; margin:0; padding:24px; max-width:640px; }
  h1 { font-size:20px; }
  h2 { font-size:15px; margin-top:28px; }
  select, input, textarea, button { background:#18191c; color:#e9e9ea; border:1px solid #333; border-radius:6px; padding:6px 10px; font-family:inherit; }
  button { background:#d6293e; border:none; cursor:pointer; }
  form.create { display:flex; flex-direction:column; gap:8px; margin-top:12px; max-width:400px; }
  .row { background:#18191c; border:1px solid #26272b; border-radius:8px; padding:10px 12px; margin-bottom:8px; }
  .row .ts { color:#d6293e; font-weight:600; font-size:12px; }
</style></head>
<body>
  <h1>Pop-up Questions (instructor)</h1>
  <form method="get" action="/popups">
    <select name="lecture" onchange="this.form.submit()">
      <option value="">Select a lecture...</option>
      ${lectures.map((l) => `<option value="${l.lecture_id}" ${l.lecture_id === lectureId ? 'selected' : ''}>${escapeHtml(l.title)}</option>`).join('')}
    </select>
  </form>

  ${lectureId ? `
    <h2>Existing pop-ups for this lecture</h2>
    ${existing.map((q) => `<div class="row"><div class="ts">${formatTimestamp(q.timestamp)}</div>${escapeHtml(q.question)}</div>`).join('') || '<p>None yet.</p>'}

    <h2>Add a pop-up question</h2>
    <form class="create" method="post" action="/popups/create">
      <input type="hidden" name="lecture_id" value="${lectureId}">
      <input name="timestamp" type="number" step="0.1" placeholder="Timestamp (seconds)" required>
      <input name="question" placeholder="Question" required>
      <textarea name="options" placeholder="One option per line" rows="4" required></textarea>
      <input name="correct_index" type="number" placeholder="Correct option index (0-based)" value="0">
      <button type="submit">Add</button>
    </form>
  ` : ''}
</body></html>`);
});

// ---- Assignment workspace (Formative Bot + Assignment Assistant + draft + rubric) ----

app.post('/assignments/create', express.urlencoded({ extended: true }), (req, res) => {
  const { title, brief_markdown, rubric_json, due_date } = req.body;
  if (!title || !brief_markdown) return res.status(400).send('title and brief_markdown are required');
  const dueMs = due_date ? new Date(due_date).getTime() : null;
  const result = db.prepare(
    "INSERT INTO assignments (title, brief_markdown, rubric_json, due_date, status, created_at) VALUES (?, ?, ?, ?, 'draft', ?)"
  ).run(title, brief_markdown, rubric_json || null, dueMs, Date.now());
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.post('/assignments/:id/approve', requireInstructor, (req, res) => {
  db.prepare("UPDATE assignments SET status = 'published' WHERE id = ?").run(req.params.id);
  res.redirect('/app/instructor?tab=verification');
});

app.post('/assignments/:id/due-date', requireInstructor, express.urlencoded({ extended: true }), (req, res) => {
  const dueMs = req.body.due_date ? new Date(req.body.due_date).getTime() : null;
  db.prepare('UPDATE assignments SET due_date = ? WHERE id = ?').run(dueMs, req.params.id);
  res.redirect('/app/instructor?tab=content');
});

// Turns a rough, informal instructor note into a structured title + brief + rubric --
// the instructor reviews/edits the AI's draft before it's actually created.
app.post('/assignments/parse-brief', async (req, res) => {
  try {
    const { raw_text } = req.body;
    if (!raw_text || !raw_text.trim()) return res.status(400).json({ error: 'raw_text is required' });

    const prompt = `An instructor gave a rough, informal description of a university assignment. Turn it into a clean, structured assignment.

Rough description:
${raw_text}

Output STRICT JSON only, no markdown fences, no commentary, matching exactly this shape:
{"title": string, "brief_markdown": string, "rubric": [{"criterion": string, "levels": [string, string, string, string]}]}

Rules:
- "title": a short, clear assignment title.
- "brief_markdown": a well-organized, complete brief reflecting the instructor's intent -- expand on unclear shorthand but do not invent requirements the instructor didn't imply.
- "rubric": 3-5 criteria that reflect what's actually being assessed based on the description. For each criterion, write exactly 4 levels ordered from lowest to highest performance, each a short phrase describing what that level of work looks like.`;

    const completion = await chatCompletionWithResilience({
      model: CHAT_MODEL,
      messages: [
        { role: 'system', content: 'You write structured university assignment briefs and rubrics from rough instructor notes. Respond only with valid JSON, no commentary.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
    });

    const parsed = JSON.parse(completion.choices[0].message.content.replace(/```json|```/g, '').trim());
    res.json({ title: parsed.title || '', brief_markdown: parsed.brief_markdown || '', rubric: Array.isArray(parsed.rubric) ? parsed.rubric : [] });
  } catch (err) {
    console.error(err);
    const msg = err.name === 'AbortError'
      ? 'The AI provider took too long to respond. Please try again.'
      : (err instanceof SyntaxError ? 'The AI returned an unexpected format. Please try again.' : 'The AI provider is temporarily unavailable. Please try again shortly.');
    res.status(502).json({ error: msg });
  }
});

app.get('/assignments/new', (req, res) => {
  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>New Assignment</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; background:#0f1012; color:#e9e9ea; margin:0; padding:24px; max-width:720px; }
  h1 { font-size:20px; }
  h3 { font-size:14px; color:#999; margin-top:20px; }
  label { display:block; font-size:13px; color:#999; margin:14px 0 4px; }
  input[type=text], textarea { width:100%; background:#18191c; color:#e9e9ea; border:1px solid #333; border-radius:8px; padding:8px 10px; font-family:inherit; font-size:14px; }
  textarea { min-height:120px; resize:vertical; }
  button { background:#d6293e; border:none; color:#fff; border-radius:6px; padding:8px 16px; cursor:pointer; font-size:14px; margin-top:12px; }
  button.secondary { background:#333; }
  button:disabled { opacity:0.5; cursor:default; }
  .criterion { background:#18191c; border:1px solid #26272b; border-radius:8px; padding:10px; margin-top:10px; }
  .criterion .levels { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-top:8px; }
  .criterion input[type=text] { font-size:13px; }
  .remove { background:none; color:#d6293e; border:none; font-size:12px; cursor:pointer; padding:0; margin-top:0; float:right; }
  .err { color:#d6293e; font-size:13px; margin-top:8px; }
</style></head>
<body>
  <h1>New Assignment</h1>
  <div id="step1">
    <p style="color:#999;font-size:13px;">Paste a rough description -- bullet points, a messy paragraph, whatever you have. The AI will turn it into a title, a clean brief, and a rubric you can edit before creating it.</p>
    <textarea id="rawBrief" placeholder="e.g. essay on climate policy, 1500 words, needs a clear argument and evidence, due end of term..."></textarea>
    <div id="parseErr" class="err"></div>
    <button id="parseBtn">Parse with AI</button>
  </div>
  <div id="step2" style="display:none;">
    <label>Title</label>
    <input type="text" id="titleInput">
    <label>Brief</label>
    <textarea id="briefInput" style="min-height:180px;"></textarea>
    <h3>Rubric</h3>
    <div id="rubricRows"></div>
    <button class="secondary" id="addCriterionBtn" type="button">+ Add criterion</button>
    <div id="createErr" class="err"></div>
    <button id="createBtn">Create assignment</button>
  </div>
<script>
  let rubricData = [];

  function renderRubricRows() {
    const wrap = document.getElementById('rubricRows');
    wrap.innerHTML = '';
    rubricData.forEach((c, ci) => {
      const div = document.createElement('div');
      div.className = 'criterion';
      const head = document.createElement('div');
      const nameInput = document.createElement('input');
      nameInput.type = 'text'; nameInput.value = c.criterion || ''; nameInput.placeholder = 'Criterion name';
      nameInput.addEventListener('input', () => { rubricData[ci].criterion = nameInput.value; });
      const rm = document.createElement('button');
      rm.className = 'remove'; rm.textContent = 'Remove'; rm.type = 'button';
      rm.addEventListener('click', () => { rubricData.splice(ci, 1); renderRubricRows(); });
      head.appendChild(nameInput); head.appendChild(rm);
      div.appendChild(head);
      const levelsWrap = document.createElement('div');
      levelsWrap.className = 'levels';
      (c.levels || []).forEach((lvl, li) => {
        const li_input = document.createElement('input');
        li_input.type = 'text'; li_input.value = lvl; li_input.placeholder = 'Level ' + (li + 1);
        li_input.addEventListener('input', () => { rubricData[ci].levels[li] = li_input.value; });
        levelsWrap.appendChild(li_input);
      });
      div.appendChild(levelsWrap);
      wrap.appendChild(div);
    });
  }

  document.getElementById('addCriterionBtn').addEventListener('click', () => {
    rubricData.push({ criterion: '', levels: ['', '', '', ''] });
    renderRubricRows();
  });

  document.getElementById('parseBtn').addEventListener('click', async () => {
    const raw = document.getElementById('rawBrief').value.trim();
    const errEl = document.getElementById('parseErr');
    errEl.textContent = '';
    if (!raw) { errEl.textContent = 'Paste a rough description first.'; return; }
    const btn = document.getElementById('parseBtn');
    btn.disabled = true; btn.textContent = 'Parsing...';
    try {
      const res = await fetch('/assignments/parse-brief', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw_text: raw }),
      });
      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.error || 'Failed to parse.'; return; }
      document.getElementById('titleInput').value = data.title || '';
      document.getElementById('briefInput').value = data.brief_markdown || '';
      rubricData = (data.rubric || []).map((r) => ({ criterion: r.criterion || '', levels: (r.levels && r.levels.length ? r.levels : ['', '', '', '']) }));
      renderRubricRows();
      document.getElementById('step1').style.display = 'none';
      document.getElementById('step2').style.display = 'block';
    } catch (e) {
      errEl.textContent = 'Network error -- please try again.';
    } finally {
      btn.disabled = false; btn.textContent = 'Parse with AI';
    }
  });

  document.getElementById('createBtn').addEventListener('click', async () => {
    const errEl = document.getElementById('createErr');
    errEl.textContent = '';
    const title = document.getElementById('titleInput').value.trim();
    const brief_markdown = document.getElementById('briefInput').value.trim();
    if (!title || !brief_markdown) { errEl.textContent = 'Title and brief are required.'; return; }
    const rubric = rubricData.filter((c) => c.criterion.trim());
    const btn = document.getElementById('createBtn');
    btn.disabled = true; btn.textContent = 'Creating...';
    try {
      const res = await fetch('/assignments/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, brief_markdown, rubric_json: JSON.stringify(rubric) }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) { errEl.textContent = 'Failed to create assignment.'; return; }
      window.location.href = '/workspace/' + data.id;
    } catch (e) {
      errEl.textContent = 'Network error -- please try again.';
    } finally {
      btn.disabled = false; btn.textContent = 'Create assignment';
    }
  });
</script>
</body></html>`);
});

app.get('/assignments', (req, res) => {
  const rows = db.prepare('SELECT * FROM assignments').all();
  res.json({ assignments: rows });
});

app.post('/drafts/save', (req, res) => {
  const { assignment_id, student_userid, content } = req.body;
  if (!assignment_id || !student_userid) return res.status(400).json({ error: 'assignment_id and student_userid are required' });
  db.prepare(
    'INSERT INTO assignment_drafts (assignment_id, student_userid, content, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(assignment_id, student_userid) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at'
  ).run(assignment_id, student_userid, content || '', Date.now());
  res.json({ ok: true });
});

app.get('/drafts', (req, res) => {
  const { assignment_id, student } = req.query;
  const row = db.prepare('SELECT * FROM assignment_drafts WHERE assignment_id = ? AND student_userid = ?').get(assignment_id, student);
  res.json({ content: row?.content || '' });
});

// ---- Internal Verifier: a QC layer, separate from the instructor, that signs off on
// AI-generated output (draft quiz questions, stuck-student escalation reports, pre-session
// summaries) before it's treated as final. ----

app.get('/verifier', (req, res) => {
  // Same identify-handshake pattern as /app/instructor's bare embed: this is the Course
  // Supervisor's landing page, reachable before any course-specific dashboard has run its
  // own handshake yet.
  if (!req.verifiedUserId) {
    return res.set('Content-Type', 'text/html').send(`<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
  ${APP_IDENTIFY_SCRIPT}
  function onIdentified(userId, token) {
    if (!token) return;
    location.href = '/verifier?t=' + encodeURIComponent(token);
  }
</script>
</body></html>`);
  }
  const viewerRole = db.prepare('SELECT role FROM students WHERE userid = ?').get(req.verifiedUserId);
  if (!viewerRole || !hasCapability(viewerRole.role, 'verify_content')) {
    return res.status(403).send('Course Supervisor access only.');
  }

  // Verification now lives inline as a tab in the instructor dashboard (next to
  // Content/Analytics/Attendance) instead of a separate dark-themed page reached
  // only by a forced redirect -- this route stays only so old links keep working.
  res.redirect('/app/instructor?tab=verification');
});

app.get('/formative/escalations', (req, res) => {
  const rows = db.prepare(
    `SELECT fe.*, s.fullname, a.title as assignment_title FROM formative_escalations fe
     LEFT JOIN students s ON s.userid = fe.student_userid
     LEFT JOIN assignments a ON a.id = fe.assignment_id
     WHERE fe.resolved = 0 AND fe.verifier_reviewed = 0 ORDER BY fe.created_at DESC`
  ).all();
  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Formative Bot Escalations</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; background:#0f1012; color:#e9e9ea; margin:0; padding:24px; max-width:720px; }
  h1 { font-size:20px; }
  a.back { color:#d6293e; text-decoration:none; font-size:13px; }
  .card { background:#18191c; border:1px solid #d6293e; border-radius:8px; padding:12px; margin-bottom:10px; }
  .card .who { font-weight:600; margin-bottom:4px; }
  .card .q { color:#d6293e; font-size:13px; margin-bottom:4px; }
  .card .report { font-size:13px; color:#ccc; margin-bottom:8px; }
  .sub { color:#999; }
  input[type=text] { background:#0f1012; color:#e9e9ea; border:1px solid #333; border-radius:6px; padding:6px 8px; width:100%; box-sizing:border-box; margin-bottom:6px; }
  button { background:#2e7d32; border:none; color:#fff; border-radius:6px; padding:6px 12px; cursor:pointer; }
</style></head>
<body>
  <a class="back" href="/app/instructor?tab=verification">&larr; Verifier hub</a>
  <h1>Students who may still be stuck</h1>
  <p class="sub">Flagged by the Formative Bot's automatic resolution check. Reviewing here signs off the report as seen by a human.</p>
  ${rows.map((r) => `
    <div class="card">
      <div class="who">${escapeHtml(r.fullname || 'Unknown')} — ${escapeHtml(r.assignment_title || '')}</div>
      <div class="q">Asked: ${escapeHtml(r.question)}</div>
      <div class="report">${escapeHtml(r.report || '')}</div>
      <form method="post" action="/formative/escalations/${r.id}/review">
        <input type="text" name="note" placeholder="Optional verifier note...">
        <button type="submit">Mark reviewed</button>
      </form>
    </div>`).join('') || '<p class="sub">No open escalations.</p>'}
</body></html>`);
});

app.post('/formative/escalations/:id/review', express.urlencoded({ extended: true }), (req, res) => {
  db.prepare(
    'UPDATE formative_escalations SET verifier_reviewed = 1, verifier_note = ?, verifier_reviewed_at = ? WHERE id = ?'
  ).run(req.body.note || '', Date.now(), req.params.id);
  res.redirect('/formative/escalations');
});

// Instructor-only kanban-style view of the rubric criteria for an assignment (hidden from
// students -- there is no student-facing link to this route anywhere in the built pages).
app.get('/assignments/:id/rubric', (req, res) => {
  const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(req.params.id);
  if (!assignment) return res.status(404).send('Assignment not found');
  let criteria = [];
  try { criteria = JSON.parse(assignment.rubric_json || '[]'); } catch (e) { /* leave empty */ }

  const draftCounts = db.prepare('SELECT COUNT(*) as c FROM assignment_drafts WHERE assignment_id = ?').get(req.params.id).c;

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(assignment.title)} — Rubric Map</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; background:#0f1012; color:#e9e9ea; margin:0; padding:24px; }
  h1 { font-size:20px; }
  p.sub { color:#999; }
  .board { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:16px; margin-top:16px; }
  .column { background:#18191c; border:1px solid #26272b; border-radius:8px; padding:12px; }
  .column h3 { margin:0 0 10px; font-size:14px; color:#d6293e; }
  .card { background:#1f2023; border-radius:6px; padding:8px 10px; margin-bottom:8px; font-size:13px; }
</style></head>
<body>
  <a href="/workspace/${assignment.id}" style="color:#d6293e;font-size:13px;text-decoration:none;">&larr; Back to workspace (student view)</a>
  <h1>${escapeHtml(assignment.title)} — Rubric Map</h1>
  <p class="sub">Instructor-only. ${draftCounts} student draft(s) in progress. This view is not linked from any student-facing page.</p>
  <div class="board">
    ${criteria.map((c) => `
      <div class="column">
        <h3>${escapeHtml(c.criterion)}</h3>
        ${(c.levels || []).map((l) => `<div class="card">${escapeHtml(l)}</div>`).join('')}
      </div>`).join('') || '<p class="sub">No rubric defined for this assignment.</p>'}
  </div>
</body></html>`);
});

app.get('/workspace/:assignmentId', (req, res) => {
  const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(req.params.assignmentId);
  if (!assignment) return res.status(404).send('Assignment not found');
  const studentParam = req.query.student ? Number(req.query.student) : null;

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(assignment.title)}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/quill/1.3.7/quill.snow.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/quill/1.3.7/quill.min.js"></script>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { margin:0; height:100%; font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif; background:#16171a; color:#e9e9ea; }
  #root { display:flex; height:100%; }
  #left { flex:1.2; padding:16px; overflow-y:auto; border-right:1px solid #26272b; }
  #right { flex:1; display:flex; flex-direction:column; min-width:320px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .brief { white-space:pre-wrap; font-size:14px; line-height:1.5; background:#1c1d20; border-radius:8px; padding:12px; margin-top:10px; }
  #draftEditor { margin-top:10px; background:#1c1d20; }
  #draftEditor .ql-toolbar { background:#232427; border-color:#333; border-radius:8px 8px 0 0; }
  #draftEditor .ql-container { border-color:#333; border-radius:0 0 8px 8px; min-height:220px; font-size:14px; }
  #draftEditor .ql-editor { color:#e9e9ea; min-height:220px; }
  #draftEditor .ql-stroke { stroke:#ccc; }
  #draftEditor .ql-fill { fill:#ccc; }
  #draftEditor .ql-picker { color:#ccc; }
  #saveStatus { font-size:12px; color:#999; margin-top:4px; }
  #tabs { display:flex; border-bottom:1px solid #26272b; }
  #tabs button { flex:1; background:none; border:none; padding:10px; font-weight:600; font-size:13px; color:inherit; opacity:0.55; cursor:pointer; border-bottom:2px solid transparent; }
  #tabs button.active { opacity:1; border-bottom-color:#d6293e; }
  .pane { display:none; flex:1; min-height:0; flex-direction:column; }
  .pane.active { display:flex; }
  #messages, #messages2 { flex:1; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:10px; }
  .msg { max-width:90%; padding:8px 12px; border-radius:10px; font-size:14px; line-height:1.45; white-space:pre-wrap; }
  .msg.user { align-self:flex-end; background:#d6293e; color:#fff; }
  .msg.bot { align-self:flex-start; background:rgba(127,127,127,0.15); }
  .inputbar { display:flex; gap:8px; padding:10px; border-top:1px solid #26272b; }
  .inputbar input { flex:1; border:1px solid #333; border-radius:8px; padding:8px 10px; font-size:14px; background:transparent; color:inherit; }
  .inputbar button { border:none; background:#d6293e; color:#fff; border-radius:8px; padding:0 14px; font-size:14px; cursor:pointer; }
</style></head>
<body>
<div id="root">
  <div id="left">
    <h1>${escapeHtml(assignment.title)}</h1>
    <div class="brief">${escapeHtml(assignment.brief_markdown)}</div>
    <h3>My Draft</h3>
    <div id="draftEditor"></div>
    <div id="saveStatus">Not signed in yet.</div>
  </div>
  <div id="right">
    <div id="tabs">
      <button id="tab-formative" class="active">Formative Bot</button>
      <button id="tab-assistant">Assignment Assistant</button>
    </div>
    <div id="pane-formative" class="pane active">
      <div id="messages"><div class="sub" style="padding:8px;color:#999;">Ask about what this assignment expects.</div></div>
      <div class="inputbar"><input id="input1" placeholder="Ask the Formative Bot..."><button id="send1">Send</button></div>
    </div>
    <div id="pane-assistant" class="pane">
      <div id="messages2"><div class="sub" style="padding:8px;color:#999;">Get feedback on your draft against the rubric.</div></div>
      <div class="inputbar"><input id="input2" placeholder="Ask the Assignment Assistant..."><button id="send2">Send</button></div>
    </div>
  </div>
</div>
<script>
  const ASSIGNMENT_ID = ${assignment.id};
  const TUTOR_BASE = '';
  let studentUserId = ${studentParam ? studentParam : 'null'};
  const historyFormative = [];
  const historyAssistant = [];

  const quill = new Quill('#draftEditor', {
    theme: 'snow',
    placeholder: 'Write your submission draft here — the Assignment Assistant can see this and give feedback against the rubric.',
    modules: {
      toolbar: [
        [{ header: [false, 1, 2] }],
        ['bold', 'italic', 'underline'],
        [{ list: 'ordered' }, { list: 'bullet' }],
        ['blockquote', 'code-block'],
        ['clean'],
      ],
    },
  });
  let suppressSave = false;

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'identify' && event.data.userId) {
      studentUserId = event.data.userId;
      document.getElementById('saveStatus').textContent = 'Signed in.';
      loadDraft();
    }
  });
  if (studentUserId) loadDraft();

  function isRTL(text) { return /[\\u0600-\\u06FF]/.test(text); }

  async function loadDraft() {
    if (!studentUserId) return;
    const res = await fetch('/drafts?assignment_id=' + ASSIGNMENT_ID + '&student=' + studentUserId);
    const data = await res.json();
    suppressSave = true;
    quill.root.innerHTML = data.content || '';
    suppressSave = false;
  }

  let saveTimer = null;
  quill.on('text-change', () => {
    if (!studentUserId || suppressSave) return;
    document.getElementById('saveStatus').textContent = 'Saving...';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await fetch('/drafts/save', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ assignment_id: ASSIGNMENT_ID, student_userid: studentUserId, content: quill.root.innerHTML }),
      });
      document.getElementById('saveStatus').textContent = 'Saved.';
    }, 800);
  });

  function addMsg(container, role, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
    div.textContent = text;
    div.dir = isRTL(text) ? 'rtl' : 'ltr';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div;
  }

  async function send(endpoint, inputId, containerId, history) {
    const input = document.getElementById(inputId);
    const text = input.value.trim();
    if (!text || !studentUserId) return;
    input.value = '';
    const container = document.getElementById(containerId);
    addMsg(container, 'user', text);
    history.push({ role: 'user', content: text });
    const pending = addMsg(container, 'bot', '...');
    try {
      const res = await fetch(endpoint, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ assignment_id: ASSIGNMENT_ID, message: text, student_userid: studentUserId, history }),
      });
      const data = await res.json();
      pending.textContent = data.reply || ('Error: ' + data.error);
      pending.dir = isRTL(pending.textContent) ? 'rtl' : 'ltr';
      history.push({ role: 'assistant', content: pending.textContent });
    } catch (e) {
      pending.textContent = 'Error contacting the assistant.';
    }
  }

  document.getElementById('send1').addEventListener('click', () => send('/chat/formative', 'input1', 'messages', historyFormative));
  document.getElementById('input1').addEventListener('keydown', (e) => { if (e.key === 'Enter') send('/chat/formative', 'input1', 'messages', historyFormative); });
  document.getElementById('send2').addEventListener('click', () => send('/chat/assistant', 'input2', 'messages2', historyAssistant));
  document.getElementById('input2').addEventListener('keydown', (e) => { if (e.key === 'Enter') send('/chat/assistant', 'input2', 'messages2', historyAssistant); });

  const tabF = document.getElementById('tab-formative'), tabA = document.getElementById('tab-assistant');
  const paneF = document.getElementById('pane-formative'), paneA = document.getElementById('pane-assistant');
  tabF.addEventListener('click', () => { tabF.classList.add('active'); tabA.classList.remove('active'); paneF.classList.add('active'); paneA.classList.remove('active'); });
  tabA.addEventListener('click', () => { tabA.classList.add('active'); tabF.classList.remove('active'); paneA.classList.add('active'); paneF.classList.remove('active'); });
</script>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`tutor-service listening on ${PORT}`);
});
