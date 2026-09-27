const { createRemoteJWKSet } = require('jose');

// `createRemoteJWKSet` caches fetched keys internally, but only within the
// lifetime of the object it returns -- so it must itself be created once per
// platform and reused, not recreated on every launch (which would defeat the
// cache entirely and turn every single launch into a live HTTP round-trip to
// the institution's JWKS endpoint before verification can even start).
const platformJwksCache = new Map(); // platform.id -> ReturnType<createRemoteJWKSet>

function getPlatformJwks(platform) {
  let jwks = platformJwksCache.get(platform.id);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(platform.jwks_url));
    platformJwksCache.set(platform.id, jwks);
  }
  return jwks;
}

// Called when an admin edits a platform's issuer/JWKS URL -- the cached key
// set would otherwise keep verifying against the old endpoint until restart.
function forgetPlatformJwks(platformId) {
  platformJwksCache.delete(Number(platformId));
}

module.exports = { getPlatformJwks, forgetPlatformJwks };
