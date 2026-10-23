// Platform admin API: the seller of the CRM creates and manages client companies here.
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const C = require('../lib/common');
const U = require('../lib/util');
const { TEMPLATES, CURRENCIES, createCompany } = require('../lib/templates');
const Sub = require('../lib/subscription');
const Audit = require('../lib/audit');

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
// every platform-admin action is logged under the admin's e-mail
const logAdmin = (req, action, o = {}) =>
  Audit.record({ actor_type: 'admin', actor_id: req.admin?.id ?? null, actor_name: req.admin?.email ?? o.actor_name ?? null, actor_role: 'admin', ip: req.ip, action, ...o });
const adminCount = () => db.prepare('SELECT COUNT(*) n FROM admins').get().n;

// Optional: seed the admin from environment variables (recommended on a public server).
function seedAdminFromEnv() {
  const email = (process.env.q@mail.ru || '').trim().toLowerCase();
  const password = process.env.qqqqqqqq || '';
  if (!email || password.length < 10 || adminCount() > 0) return;
  db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)').run(email, bcrypt.hashSync(password, 10));
  console.log(`Platform admin created from environment: ${email}`);
}
seedAdminFromEnv();

router.get('/status', (req, res) => res.json({ setupRequired: adminCount() === 0 }));

router.post('/setup', limiter, (req, res) => {
  if (adminCount() > 0) return C.fail(res, 'forbidden', 403);
  const email = C.str(req.body.email, 200).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!C.emailOk(email)) return C.fail(res, 'bad_email');
  if (password.length < 10 || password.length > 200) return C.fail(res, 'weak_password_admin');
  const id = db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)').run(email, bcrypt.hashSync(password, 10)).lastInsertRowid;
  C.adminSignIn(res, { id: Number(id) });
  Audit.record({ actor_type: 'admin', actor_id: Number(id), actor_name: email, actor_role: 'admin', ip: req.ip, action: 'admin.setup' });
  res.json({ ok: true });
});

router.post('/login', limiter, (req, res) => {
  const email = C.str(req.body.email, 200).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(email);
  const ok = bcrypt.compareSync(password, admin ? admin.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinva');
  if (!admin || !ok) {
    Audit.record({ actor_type: 'admin', actor_name: email, ip: req.ip, action: 'admin.login_failed', details: { email } });
    return C.fail(res, 'bad_credentials', 401);
  }
  C.adminSignIn(res, admin);
  Audit.record({ actor_type: 'admin', actor_id: admin.id, actor_name: admin.email, actor_role: 'admin', ip: req.ip, action: 'admin.login', details: { email } });
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.clearCookie('atoken');
  res.json({ ok: true });
});

router.get('/me', C.adminAuth, (req, res) => res.json({ admin: req.admin }));

router.get('/templates', C.adminAuth, (req, res) => {
  res.json({ templates: Object.values(TEMPLATES).map((t) => ({ id: t.id, name: t.name, description: t.description })), currencies: CURRENCIES });
});

function companyRow(c) {
  const s = U.getSettings(c.id);
  return {
    id: c.id, name: c.name, template: c.template, currency: c.currency, suspended: !!c.suspended, created_at: c.created_at,
    subscription: Sub.stateOf(c),
    owner_name: c.owner_name, owner_email: c.owner_email, users: c.users,
    timezone: s.timezone, language: s.language, country_code: s.country_code,
    whatsapp: {
      phone_number_id: s.whatsapp.phone_number_id,
      token_set: !!s.whatsapp.access_token,
      templates: s.whatsapp.templates || {},
    },
  };
}
const COMPANY_SELECT = `
  SELECT c.*, (SELECT name FROM users u WHERE u.company_id=c.id AND u.role='owner' ORDER BY u.id LIMIT 1) AS owner_name,
         (SELECT email FROM users u WHERE u.company_id=c.id AND u.role='owner' ORDER BY u.id LIMIT 1) AS owner_email,
         (SELECT COUNT(*) FROM users u WHERE u.company_id=c.id) AS users
  FROM companies c`;

// Sets the paid period. Returns { paid_until } or { error }.
function applySubscription(req, company, b) {
  let paid_from = null, paid_until = null, kind = b.kind || 'extend', period = null;
  if (b.action === 'unlimited') { kind = 'unlimited'; }
  else if (b.action === 'set') {
    if (!Sub.isDate(b.paid_until)) return { error: 'bad_date' };
    paid_until = b.paid_until; kind = b.kind || 'set';
  } else if (b.action === 'extend') {
    const r = Sub.computeUntil(company, { months: b.months, days: b.days, from: b.from });
    if (!r) return { error: 'bad_period' };
    paid_from = r.paid_from; paid_until = r.paid_until; period = Sub.periodLabel(b);
  } else return { error: 'bad_period' };
  db.prepare('UPDATE companies SET paid_until = ? WHERE id = ?').run(paid_until, company.id);
  Sub.logEvent(company.id, req.admin.email, { kind, period, paid_from, paid_until, amount: b.amount, note: b.note });
  return { paid_until };
}

router.get('/companies', C.adminAuth, (req, res) => {
  res.json(db.prepare(COMPANY_SELECT + ' ORDER BY c.id DESC').all().map(companyRow));
});

router.post('/companies', C.adminAuth, (req, res) => {
  const b = req.body || {};
  const companyName = C.str(b.companyName, 100);
  const ownerName = C.str(b.ownerName, 100);
  const email = C.str(b.email, 200).toLowerCase();
  const password = typeof b.password === 'string' ? b.password : '';
  if (!companyName || !ownerName) return C.fail(res, 'required');
  if (!TEMPLATES[b.template]) return C.fail(res, 'bad_template');
  if (!C.emailOk(email)) return C.fail(res, 'bad_email');
  if (password.length < 8 || password.length > 200) return C.fail(res, 'weak_password');
  const timezone = C.str(b.timezone, 60) || U.DEFAULT_SETTINGS.timezone;
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    return C.fail(res, 'bad_timezone');
  }
  try {
    const r = createCompany({
      template: b.template, companyName, ownerName, email, password, currency: b.currency,
      language: b.language, timezone, country_code: b.country_code,
    });
    // paid period chosen at creation: months / days / explicit end date / no limit
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(r.companyId);
    const sub = applySubscription(req, company, { action: b.period_months || b.period_days ? 'extend' : b.paid_until ? 'set' : 'unlimited', months: b.period_months, days: b.period_days, paid_until: b.paid_until, amount: b.amount, note: b.note, kind: 'start' });
    if (sub.error) return C.fail(res, sub.error);
    logAdmin(req, 'company.create', { company_id: r.companyId, company_name: companyName, entity_type: 'company', entity_id: r.companyId, entity_label: companyName, details: { template: b.template, owner_email: email, paid_until: sub.paid_until } });
    res.status(201).json({ id: r.companyId });
  } catch (e) {
    if (e.message === 'email_taken') return C.fail(res, 'email_taken', 409);
    throw e;
  }
});

router.patch('/companies/:id', C.adminAuth, (req, res) => {
  const id = C.idOrNull(req.params.id);
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  if (!company) return C.fail(res, 'not_found', 404);
  const b = req.body || {};
  const label = { company_id: id, company_name: company.name, entity_type: 'company', entity_id: id, entity_label: company.name };
  if (typeof b.suspended === 'boolean') {
    db.prepare('UPDATE companies SET suspended = ? WHERE id = ?').run(b.suspended ? 1 : 0, id);
    logAdmin(req, b.suspended ? 'company.suspend' : 'company.activate', label);
  }
  if (b.name !== undefined) {
    const name = C.str(b.name, 100);
    if (!name) return C.fail(res, 'required');
    db.prepare('UPDATE companies SET name = ? WHERE id = ?').run(name, id);
    logAdmin(req, 'company.rename', { ...label, details: { changes: { name: [company.name, name] } } });
  }
  if (company.template === 'carwash' && (b.whatsapp || b.timezone || b.language || b.country_code !== undefined)) {
    const s = U.getSettings(id);
    if (b.timezone) {
      try { new Intl.DateTimeFormat('en', { timeZone: String(b.timezone) }); s.timezone = String(b.timezone); } catch { return C.fail(res, 'bad_timezone'); }
    }
    if (b.language) s.language = ['ru', 'kk', 'en'].includes(b.language) ? b.language : 'ru';
    if (b.country_code !== undefined) s.country_code = String(b.country_code).replace(/\D/g, '').slice(0, 4);
    if (b.whatsapp) {
      const w = b.whatsapp;
      if (w.phone_number_id !== undefined) s.whatsapp.phone_number_id = C.str(w.phone_number_id, 40).replace(/\D/g, '');
      if (typeof w.access_token === 'string' && w.access_token.trim()) s.whatsapp.access_token = w.access_token.trim().slice(0, 600);
      if (w.clear_token === true) s.whatsapp.access_token = '';
      if (w.templates && typeof w.templates === 'object') {
        const out = {};
        for (const kind of ['reminder', 'offer', 'review', 'reschedule', 'delay']) {
          const t = w.templates[kind];
          const name = C.str(t?.name, 80);
          if (name && /^[a-z0-9_]+$/.test(name)) out[kind] = { name, lang: C.str(t?.lang, 10) || 'ru' };
        }
        s.whatsapp.templates = out;
      }
    }
    U.saveSettings(id, s);
    logAdmin(req, 'company.settings', { ...label, details: { fields: Object.keys(b).filter((k) => k !== 'name' && k !== 'suspended') } }); // secrets are never written to the log
  }
  res.json({ ok: true });
});

// ---- subscription: extend / change the term / remove the limit ----
router.get('/companies/:id/subscription', C.adminAuth, (req, res) => {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(C.idOrNull(req.params.id));
  if (!company) return C.fail(res, 'not_found', 404);
  res.json({ state: Sub.stateOf(company), events: db.prepare('SELECT * FROM subscription_events WHERE company_id = ? ORDER BY id DESC LIMIT 100').all(company.id) });
});
router.post('/companies/:id/subscription', C.adminAuth, (req, res) => {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(C.idOrNull(req.params.id));
  if (!company) return C.fail(res, 'not_found', 404);
  const before = company.paid_until;
  const r = applySubscription(req, company, req.body || {});
  if (r.error) return C.fail(res, r.error);
  logAdmin(req, 'subscription.change', { company_id: company.id, company_name: company.name, entity_type: 'company', entity_id: company.id, entity_label: company.name,
    details: { action: req.body.action, changes: { paid_until: [before, r.paid_until] }, note: C.str(req.body.note, 300) } });
  res.json({ ok: true, state: Sub.stateOf({ ...company, paid_until: r.paid_until }) });
});

// ---- sign in as the business (inspection) ----
// mode "view": read-only. mode "act": may change data; a reason is mandatory and every change is logged.
router.post('/companies/:id/impersonate', C.adminAuth, (req, res) => {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(C.idOrNull(req.params.id));
  if (!company) return C.fail(res, 'not_found', 404);
  const mode = req.body.mode === 'act' ? 'act' : 'view';
  const reason = C.str(req.body.reason, 300);
  if (mode === 'act' && reason.length < 5) return C.fail(res, 'reason_required');
  if (!db.prepare("SELECT 1 FROM users WHERE company_id = ? AND role = 'owner'").get(company.id)) return C.fail(res, 'not_found', 404);
  C.impersonationSignIn(res, req.admin, company.id, mode);
  logAdmin(req, 'admin.impersonate_start', { company_id: company.id, company_name: company.name, entity_type: 'company', entity_id: company.id, entity_label: company.name, details: { mode, reason } });
  res.json({ ok: true, mode });
});

// ---- audit log ----
function logWhere(q) {
  const w = [], p = [];
  const from = C.dateOrNull(q.from), to = C.dateOrNull(q.to);
  if (from) { w.push('ts >= ?'); p.push(from + 'T00:00:00.000Z'); }
  if (to) { w.push('ts <= ?'); p.push(to + 'T23:59:59.999Z'); }
  const cid = C.idOrNull(q.company);
  if (cid) { w.push('company_id = ?'); p.push(cid); }
  if (q.action) { w.push('action = ?'); p.push(C.str(q.action, 60)); }
  if (['user', 'admin', 'system'].includes(q.actor_type)) { w.push('actor_type = ?'); p.push(q.actor_type); }
  if (q.suspicious === '1') w.push('suspicious = 1');
  const text = C.str(q.q, 100);
  if (text) {
    const like = `%${text.replace(/[%_\\]/g, '\\$&')}%`;
    w.push("(actor_name LIKE ? ESCAPE '\\' OR company_name LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR entity_label LIKE ? ESCAPE '\\' OR details LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\' OR suspicious_reason LIKE ? ESCAPE '\\')");
    p.push(like, like, like, like, like, like, like);
  }
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p };
}
router.get('/logs', C.adminAuth, (req, res) => {
  const { where, params } = logWhere(req.query);
  const limit = Math.min(200, Math.max(1, Math.round(Number(req.query.limit)) || 50));
  const offset = Math.max(0, Math.round(Number(req.query.offset)) || 0);
  const total = db.prepare(`SELECT COUNT(*) n FROM audit_log ${where}`).get(...params).n;
  const rows = db.prepare(`SELECT id, ts, company_id, company_name, actor_type, actor_id, actor_name, actor_role, action, entity_type, entity_id, entity_label, details, ip, suspicious, suspicious_reason FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ total, rows: rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null })) });
});
router.get('/logs/meta', C.adminAuth, (req, res) => {
  res.json({
    actions: db.prepare('SELECT action, COUNT(*) n FROM audit_log GROUP BY action ORDER BY action').all(),
    suspicious_total: db.prepare('SELECT COUNT(*) n FROM audit_log WHERE suspicious = 1').get().n,
    suspicious_24h: db.prepare('SELECT COUNT(*) n FROM audit_log WHERE suspicious = 1 AND ts >= ?').get(new Date(Date.now() - 86400000).toISOString()).n,
  });
});
router.get('/logs/verify', C.adminAuth, (req, res) => res.json(Audit.verifyChain()));

router.post('/companies/:id/reset-password', C.adminAuth, (req, res) => {
  const id = C.idOrNull(req.params.id);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (password.length < 8 || password.length > 200) return C.fail(res, 'weak_password');
  const owner = db.prepare("SELECT id FROM users WHERE company_id = ? AND role = 'owner' ORDER BY id LIMIT 1").get(id);
  if (!owner) return C.fail(res, 'not_found', 404);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), owner.id);
  const co = db.prepare('SELECT name FROM companies WHERE id = ?').get(id);
  logAdmin(req, 'company.reset_password', { company_id: id, company_name: co?.name, entity_type: 'user', entity_id: owner.id, entity_label: 'owner' });
  res.json({ ok: true });
});

module.exports = router;
