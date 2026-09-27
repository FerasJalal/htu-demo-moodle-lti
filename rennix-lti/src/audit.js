const { db } = require('./db');

// Never pass raw secrets, tokens, or full request bodies into `detail` --
// this table exists to answer "who did what, when", not to reconstruct
// credentials from logs.
function logAdminEvent(event, detail, req) {
  const ip = req ? (req.get('x-forwarded-for') || req.socket?.remoteAddress || '') : '';
  db.prepare('INSERT INTO admin_audit_log (event, detail, ip, created_at) VALUES (?, ?, ?, ?)')
    .run(event, detail || null, String(ip).split(',')[0].trim(), Date.now());
}

module.exports = { logAdminEvent };
