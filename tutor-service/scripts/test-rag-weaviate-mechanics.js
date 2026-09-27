// Verifies the Weaviate-facing mechanics of the new RAG pipeline (native multi-tenancy,
// course_id filtering, timestamp-window retrieval, hybrid search) using deterministic
// placeholder vectors -- NOT a test of embedding quality, which needs real BGE-M3.
// Run: WEAVIATE_URL=... WEAVIATE_API_KEY=... node scripts/test-rag-weaviate-mechanics.js

const WEAVIATE_URL = process.env.WEAVIATE_URL || 'http://localhost:8081';
const WEAVIATE_API_KEY = process.env.WEAVIATE_API_KEY;
const CLASS_NAME = 'CourseContent';
const TENANT = 'HTU';
const DIM = 1024;

function seededVector(seed) {
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const v = Array.from({ length: DIM }, () => rand() * 2 - 1);
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  return v.map((x) => x / norm);
}

async function wf(path, options = {}) {
  const res = await fetch(`${WEAVIATE_URL}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${WEAVIATE_API_KEY}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
}
async function graphql(query) {
  const body = await wf('/v1/graphql', { method: 'POST', body: JSON.stringify({ query }) });
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

const FIXTURES = [
  { course_id: 'CS101', source_type: 'video_transcript', source_id: 'lecture_05', source_title: 'Lecture 5', video_id: 'lecture_05', timestamp_start: 1050, timestamp_end: 1115, language: 'en', chunk_index: 0, text: 'The coefficient of performance of a refrigerator increases as the temperature difference decreases.' },
  { course_id: 'CS101', source_type: 'video_transcript', source_id: 'lecture_05', source_title: 'Lecture 5', video_id: 'lecture_05', timestamp_start: 1105, timestamp_end: 1170, language: 'en', chunk_index: 1, text: 'This is why heat pumps are more efficient in mild climates than in extreme cold.' },
  { course_id: 'CS101', source_type: 'video_transcript', source_id: 'lecture_05', source_title: 'Lecture 5', video_id: 'lecture_05', timestamp_start: 3000, timestamp_end: 3060, language: 'en', chunk_index: 2, text: 'Unrelated segment about a totally different topic, far from the timestamp window we will query.' },
  { course_id: 'CS101', source_type: 'pdf', source_id: 'week5-slides', source_title: 'Week 5 Slides', document_id: 'week5-slides', page_number: 17, language: 'en', chunk_index: 0, text: 'Slide summarizing the COP formula and its dependence on evaporator and condenser temperatures.' },
  { course_id: 'CS202', source_type: 'video_transcript', source_id: 'other-lecture', source_title: 'Other Course Lecture', video_id: 'other-lecture', timestamp_start: 1050, timestamp_end: 1115, language: 'en', chunk_index: 0, text: 'The coefficient of performance of a refrigerator increases as the temperature difference decreases.' },
];

async function main() {
  console.log('Inserting fixtures via /v1/batch/objects...');
  const objects = FIXTURES.map((properties, i) => ({ class: CLASS_NAME, tenant: TENANT, properties, vector: seededVector(i + 1) }));
  const insertRes = await wf('/v1/batch/objects', { method: 'POST', body: JSON.stringify({ objects }) });
  const ids = insertRes.map((r) => r.id);
  const errors = insertRes.filter((r) => r.result?.errors);
  console.log(`Inserted ${ids.length} objects, ${errors.length} errors.`);
  if (errors.length) console.log(JSON.stringify(errors, null, 2));

  await new Promise((r) => setTimeout(r, 1000));

  console.log('\n--- Test 1: course_id-filtered hybrid search within tenant HTU, course CS101 ---');
  const qVec = seededVector(1);
  const t1 = await graphql(`{
    Get {
      ${CLASS_NAME}(
        tenant: "${TENANT}"
        hybrid: { query: "coefficient of performance refrigerator", vector: ${JSON.stringify(qVec)}, alpha: 0.5 }
        where: { path: ["course_id"], operator: Equal, valueText: "CS101" }
        limit: 10
      ) { source_id course_id chunk_index }
    }
  }`);
  const r1 = t1.Get[CLASS_NAME];
  console.log(r1);
  console.log(r1.every((x) => x.course_id === 'CS101') ? 'PASS: no cross-course leakage within tenant' : 'FAIL: cross-course leakage');
  console.log(r1.some((x) => x.source_id === 'lecture_05') ? 'PASS: found the matching lecture chunk' : 'FAIL: expected chunk missing');

  console.log('\n--- Test 2: identical text in CS202 must not appear in a CS101-scoped query ---');
  const leaked = r1.some((x) => x.course_id === 'CS202');
  console.log(leaked ? 'FAIL: CS202 content leaked into CS101 query' : 'PASS: course isolation holds despite identical text');

  console.log('\n--- Test 3: timestamp-window retrieval (Contextual Ask local branch), position=1080s, window=120s ---');
  const t3 = await graphql(`{
    Get {
      ${CLASS_NAME}(
        tenant: "${TENANT}"
        where: {
          operator: And
          operands: [
            { path: ["course_id"], operator: Equal, valueText: "CS101" }
            { path: ["video_id"], operator: Equal, valueText: "lecture_05" }
            { path: ["timestamp_start"], operator: LessThanEqual, valueNumber: 1200 }
            { path: ["timestamp_end"], operator: GreaterThanEqual, valueNumber: 960 }
          ]
        }
      ) { chunk_index timestamp_start timestamp_end }
    }
  }`);
  const r3 = t3.Get[CLASS_NAME].sort((a, b) => a.chunk_index - b.chunk_index);
  console.log(r3);
  console.log(
    r3.length === 2 && r3.every((c) => c.chunk_index === 0 || c.chunk_index === 1)
      ? 'PASS: only the two nearby chunks matched, the far-away chunk_index=2 correctly excluded'
      : `FAIL: expected exactly chunks 0 and 1, got ${JSON.stringify(r3)}`,
  );

  console.log('\nCleaning up fixtures...');
  for (const id of ids) {
    await wf(`/v1/objects/${CLASS_NAME}/${id}?tenant=${TENANT}`, { method: 'DELETE' });
  }
  console.log('Done.');
}

main().catch((err) => { console.error('ERROR:', err.message); process.exit(1); });
