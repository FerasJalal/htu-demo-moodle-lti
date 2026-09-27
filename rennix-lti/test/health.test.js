const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_PATH = path.join(os.tmpdir(), `lti-health-test-${crypto.randomBytes(6).toString('hex')}.db`);
process.env.ADMIN_SECRET = 'test-admin-secret';
process.env.SESSION_SECRET = 'test-session-secret';

const app = require('../server');

let server, port;
before(async () => {
  server = http.createServer(app);
  port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function get(reqPath) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: reqPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }).on('error', reject);
  });
}

test('GET /health returns 200 and ok:true when the DB is reachable', async () => {
  const res = await get('/health');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
});
