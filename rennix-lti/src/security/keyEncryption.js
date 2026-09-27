const crypto = require('crypto');

// Wraps the tool's own RSA private key (src/security/toolKeys.js) before it
// touches SQLite. The key is derived by hashing KEY_ENCRYPTION_SECRET rather
// than requiring it to already be exactly 32 bytes -- this wraps one
// long-lived key, not a password store, so a plain digest is enough (no
// salt/KDF needed since there's nothing being brute-forced offline here that
// a salt would help against).
function deriveKey(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(plaintext, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decrypt({ ciphertext, iv, tag }, secret) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = { encrypt, decrypt };
