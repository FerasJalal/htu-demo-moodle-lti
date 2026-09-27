const crypto = require('crypto');
const express = require('express');
const { generateKeyPair, exportJWK, importPKCS8, exportPKCS8 } = require('jose');
const { db } = require('../db');
const { encrypt, decrypt } = require('./keyEncryption');
const { KEY_ENCRYPTION_SECRET } = require('../config');

// ---- Our own key pair ----
// Persisted in this service's own database (same trust boundary as every
// other secret this service already holds -- ADMIN_SECRET, LTI_BRIDGE_SECRET
// -- none of which are encrypted at rest either). Stable across restarts,
// which matters because NRPS/AGS service calls require this tool to sign its
// own JWT client assertions with it -- a key that changed on every restart
// would break the platform's cached copy of /lti/jwks.
//
// private_key_pem is encrypted at rest (AES-256-GCM, see keyEncryption.js)
// whenever KEY_ENCRYPTION_SECRET is configured; enc_iv/enc_tag being set on
// the row is what marks it as encrypted rather than legacy plaintext.
let toolKeyPairCache = null; // { privateKey: CryptoKey, publicJwk, kid }
async function getToolKeyPair() {
  if (toolKeyPairCache) return toolKeyPairCache;
  const row = db.prepare('SELECT * FROM tool_keys ORDER BY created_at ASC LIMIT 1').get();
  if (row) {
    let pem = row.private_key_pem;
    if (row.enc_iv && row.enc_tag) {
      pem = decrypt({ ciphertext: row.private_key_pem, iv: row.enc_iv, tag: row.enc_tag }, KEY_ENCRYPTION_SECRET);
    } else if (KEY_ENCRYPTION_SECRET) {
      // Legacy plaintext row, encryption now configured -- migrate it in
      // place, transparently, on this first read.
      const wrapped = encrypt(pem, KEY_ENCRYPTION_SECRET);
      db.prepare('UPDATE tool_keys SET private_key_pem = ?, enc_iv = ?, enc_tag = ? WHERE kid = ?')
        .run(wrapped.ciphertext, wrapped.iv, wrapped.tag, row.kid);
    }
    const privateKey = await importPKCS8(pem, 'RS256');
    toolKeyPairCache = { privateKey, publicJwk: JSON.parse(row.public_jwk), kid: row.kid };
    return toolKeyPairCache;
  }
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const kid = 'rennix-lti-' + crypto.randomBytes(4).toString('hex');
  const jwk = await exportJWK(publicKey);
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  jwk.kid = kid;
  const pem = await exportPKCS8(privateKey);
  const stored = KEY_ENCRYPTION_SECRET ? encrypt(pem, KEY_ENCRYPTION_SECRET) : { ciphertext: pem, iv: null, tag: null };
  db.prepare('INSERT INTO tool_keys (kid, private_key_pem, public_jwk, enc_iv, enc_tag, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(kid, stored.ciphertext, JSON.stringify(jwk), stored.iv, stored.tag, Date.now());
  toolKeyPairCache = { privateKey, publicJwk: jwk, kid };
  return toolKeyPairCache;
}

const router = express.Router();
router.get('/lti/jwks', async (req, res) => {
  const { publicJwk } = await getToolKeyPair();
  res.json({ keys: [publicJwk] });
});

module.exports = { getToolKeyPair, router };
