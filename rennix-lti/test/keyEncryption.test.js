const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encrypt, decrypt } = require('../src/security/keyEncryption');

const SECRET = 'test-key-encryption-secret';

test('encrypt/decrypt round-trips the plaintext', () => {
  const plaintext = '-----BEGIN PRIVATE KEY-----\nfake-pem-content\n-----END PRIVATE KEY-----';
  const wrapped = encrypt(plaintext, SECRET);
  assert.equal(decrypt(wrapped, SECRET), plaintext);
});

test('ciphertext and iv/tag are not the plaintext', () => {
  const plaintext = 'super-secret-pem';
  const wrapped = encrypt(plaintext, SECRET);
  assert.notEqual(wrapped.ciphertext, plaintext);
  assert.ok(wrapped.iv);
  assert.ok(wrapped.tag);
});

test('decrypting with the wrong secret throws (GCM auth failure)', () => {
  const wrapped = encrypt('some-pem', SECRET);
  assert.throws(() => decrypt(wrapped, 'a-different-secret'));
});

test('a tampered ciphertext fails to decrypt', () => {
  const wrapped = encrypt('some-pem', SECRET);
  const tamperedBuf = Buffer.from(wrapped.ciphertext, 'base64');
  tamperedBuf[0] ^= 0xff;
  assert.throws(() => decrypt({ ...wrapped, ciphertext: tamperedBuf.toString('base64') }, SECRET));
});

test('a tampered auth tag fails to decrypt', () => {
  const wrapped = encrypt('some-pem', SECRET);
  const tamperedTag = Buffer.from(wrapped.tag, 'base64');
  tamperedTag[0] ^= 0xff;
  assert.throws(() => decrypt({ ...wrapped, tag: tamperedTag.toString('base64') }, SECRET));
});

test('two encryptions of the same plaintext produce different ciphertext/iv (random IV)', () => {
  const a = encrypt('same-pem', SECRET);
  const b = encrypt('same-pem', SECRET);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
});
