const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isRateLimited } = require('../src/rateLimit');

test('allows requests under the threshold', () => {
  const key = `test-under-${Date.now()}`;
  for (let i = 0; i < 5; i++) {
    assert.equal(isRateLimited(key, 5, 60_000), false);
  }
});

test('blocks requests once over the threshold', () => {
  const key = `test-over-${Date.now()}`;
  for (let i = 0; i < 3; i++) {
    assert.equal(isRateLimited(key, 3, 60_000), false);
  }
  assert.equal(isRateLimited(key, 3, 60_000), true);
});

test('old requests age out of the window', async () => {
  const key = `test-window-${Date.now()}`;
  for (let i = 0; i < 2; i++) isRateLimited(key, 2, 50);
  assert.equal(isRateLimited(key, 2, 50), true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(isRateLimited(key, 2, 50), false);
});
