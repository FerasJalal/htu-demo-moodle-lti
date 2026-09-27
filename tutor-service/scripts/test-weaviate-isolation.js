// Smoke test: hybrid search + strict tenant_id/course_id filtering on CourseContent.
// Inserts throwaway objects with deterministic dummy vectors, queries across
// tenant/course boundaries, asserts isolation, then deletes everything it created.
// Run: WEAVIATE_URL=... WEAVIATE_API_KEY=... node scripts/test-weaviate-isolation.js

const WEAVIATE_URL = process.env.WEAVIATE_URL || 'http://localhost:8081';
const WEAVIATE_API_KEY = process.env.WEAVIATE_API_KEY;
const CLASS_NAME = 'CourseContent';
const VECTOR_DIM = 1024; // BGE-M3 dense embedding size

if (!WEAVIATE_API_KEY) {
  console.error('WEAVIATE_API_KEY not set');
  process.exit(1);
}

function seededVector(seed, dim) {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const v = Array.from({ length: dim }, () => rand() * 2 - 1);
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  return v.map((x) => x / norm);
}

async function wf(path, options = {}) {
  const res = await fetch(`${WEAVIATE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${WEAVIATE_API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
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
  { tenant_id: 'htu', course_id: 'cs101', source_type: 'pdf', document_id: 'week5-slides', chunk_index: 0, text: 'Integration by parts is used when integrating a product of functions.' },
  { tenant_id: 'htu', course_id: 'cs101', source_type: 'video_transcript', document_id: 'week5-video3', video_id: 'week5-video3', start_time: 120, end_time: 145, chunk_index: 1, text: 'The derivative represents the instantaneous rate of change of a function.' },
  { tenant_id: 'htu', course_id: 'cs202', source_type: 'pdf', document_id: 'week1-slides', chunk_index: 0, text: 'Big-O notation describes the upper bound of an algorithm\'s growth rate.' },
  { tenant_id: 'other-tenant', course_id: 'cs101', source_type: 'pdf', document_id: 'week5-slides', chunk_index: 0, text: 'Integration by parts is used when integrating a product of functions.' },
];

async function main() {
  console.log('Inserting fixtures...');
  const ids = [];
  for (let i = 0; i < FIXTURES.length; i++) {
    const obj = await wf('/v1/objects', {
      method: 'POST',
      body: JSON.stringify({
        class: CLASS_NAME,
        properties: FIXTURES[i],
        vector: seededVector(i + 1, VECTOR_DIM),
      }),
    });
    ids.push(obj.id);
  }
  console.log(`Inserted ${ids.length} objects.`);

  // Give the inverted + vector index a moment to catch up.
  await new Promise((r) => setTimeout(r, 1000));

  console.log('\n--- Test 1: hybrid query scoped to htu/cs101 (should return 2, not the other tenant or other course) ---');
  const queryVec = seededVector(1, VECTOR_DIM);
  const test1 = await graphql(`{
    Get {
      ${CLASS_NAME}(
        hybrid: { query: "integration derivative", vector: ${JSON.stringify(queryVec)}, alpha: 0.5 }
        where: {
          operator: And
          operands: [
            { path: ["tenant_id"], operator: Equal, valueText: "htu" }
            { path: ["course_id"], operator: Equal, valueText: "cs101" }
          ]
        }
      ) { document_id chunk_index tenant_id course_id _additional { score } }
    }
  }`);
  const results1 = test1.Get[CLASS_NAME];
  console.log(results1);
  const leaked = results1.some((r) => r.tenant_id !== 'htu' || r.course_id !== 'cs101');
  console.log(leaked ? 'FAIL: cross-tenant/course leakage detected' : 'PASS: no cross-tenant/course leakage');
  console.log(results1.length === 2 ? 'PASS: got exactly the 2 expected chunks' : `FAIL: expected 2 results, got ${results1.length}`);

  console.log('\n--- Test 2: same query text, but filtered to other-tenant/cs101 (should return only the other-tenant chunk, not htu\'s identical text) ---');
  const test2 = await graphql(`{
    Get {
      ${CLASS_NAME}(
        hybrid: { query: "integration", vector: ${JSON.stringify(queryVec)}, alpha: 0.5 }
        where: {
          operator: And
          operands: [
            { path: ["tenant_id"], operator: Equal, valueText: "other-tenant" }
            { path: ["course_id"], operator: Equal, valueText: "cs101" }
          ]
        }
      ) { document_id tenant_id course_id }
    }
  }`);
  const results2 = test2.Get[CLASS_NAME];
  console.log(results2);
  console.log(
    results2.length === 1 && results2[0].tenant_id === 'other-tenant'
      ? 'PASS: correctly isolated despite identical text content'
      : 'FAIL: isolation broken',
  );

  console.log('\nCleaning up fixtures...');
  for (const id of ids) {
    await wf(`/v1/objects/${CLASS_NAME}/${id}`, { method: 'DELETE' });
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
