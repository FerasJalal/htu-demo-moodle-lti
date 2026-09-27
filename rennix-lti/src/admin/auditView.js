const express = require('express');
const { db } = require('../db');
const { escapeHtml } = require('../util/html');
const { requireAdmin } = require('./auth');

const PAGE_SIZE = 50;

const router = express.Router();

router.get('/admin/audit', requireAdmin, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const total = db.prepare('SELECT COUNT(*) AS count FROM admin_audit_log').get().count;
  const rows = db.prepare('SELECT event, detail, ip, created_at FROM admin_audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?').all(PAGE_SIZE, offset);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Audit log</title>
<style>
  body { font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif; background:#f7f8fa; margin:0; padding:32px 16px; }
  .card { max-width:900px; margin:0 auto 20px; background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:24px; }
  h1 { font-size:18px; margin:0 0 4px; }
  p.sub { color:#57606a; font-size:13px; margin:0 0 16px; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  td, th { text-align:left; padding:6px 8px; border-bottom:1px solid #eef1f4; vertical-align:top; }
  td.event { font-weight:700; white-space:nowrap; }
  td.detail { color:#57606a; word-break:break-word; }
  td.time, td.ip { white-space:nowrap; color:#8a94a6; }
  .nav { display:flex; justify-content:space-between; align-items:center; max-width:900px; margin:0 auto 12px; font-size:12px; }
  .nav a { color:#d41128; text-decoration:none; }
  .pager { display:flex; gap:12px; align-items:center; }
  .pager a, .pager span { color:#57606a; }
</style></head>
<body>
  <div class="nav"><a href="/admin">&larr; Back to admin</a><span>${total} events</span></div>
  <div class="card">
    <h1>Audit log</h1>
    <p class="sub">Most recent first. Page ${page} of ${totalPages}.</p>
    <table>
      <tr><th>Time</th><th>Event</th><th>Detail</th><th>IP</th></tr>
      ${rows.map((r) => `<tr>
        <td class="time">${escapeHtml(new Date(r.created_at).toISOString())}</td>
        <td class="event">${escapeHtml(r.event)}</td>
        <td class="detail">${escapeHtml(r.detail || '')}</td>
        <td class="ip">${escapeHtml(r.ip || '')}</td>
      </tr>`).join('')}
    </table>
    <div class="pager" style="margin-top:16px;">
      ${page > 1 ? `<a href="/admin/audit?page=${page - 1}">&larr; Newer</a>` : '<span>&larr; Newer</span>'}
      ${page < totalPages ? `<a href="/admin/audit?page=${page + 1}">Older &rarr;</a>` : '<span>Older &rarr;</span>'}
    </div>
  </div>
</body></html>`);
});

module.exports = { router };
