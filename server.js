const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { db } = require('./db');
const C = require('./lib/common');
const { TEMPLATES } = require('./lib/templates');
const P = require('./lib/permissions');
const U = require('./lib/util');
const Sub = require('./lib/subscription');
const Audit = require('./lib/audit');
const { fail, str, num, dateOrNull, idOrNull, belongs, signIn, auth, perm } = C;

const PORT = process.env.PORT || 3000;

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// every change made through the API is written to the audit log (lib/audit.js)
app.use('/api', Audit.http);

// ---- AUTH ----
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

// Public registration is disabled: accounts are created by the platform admin (/admin).
app.post('/api/auth/register', (req, res) => fail(res, 'registration_disabled', 403));

app.post('/api/auth/login', authLimiter, (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  // Compare against a dummy hash when user not found to keep timing similar.
  const ok = bcrypt.compareSync(password, user ? user.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinva');
  if (!user || !ok) {
    Audit.record({ actor_type: 'user', actor_id: user?.id ?? null, actor_name: email, company_id: user?.company_id ?? null, action: 'auth.login_failed', ip: req.ip, details: { email } });
    return fail(res, 'bad_credentials', 401);
  }
  const company = db.prepare('SELECT id, suspended, paid_until FROM companies WHERE id = ?').get(user.company_id);
  const who = { actor_type: 'user', actor_id: user.id, actor_name: user.name, actor_role: user.role, company_id: user.company_id, ip: req.ip, details: { email } };
  if (company.suspended) { Audit.record({ ...who, action: 'auth.login_blocked', details: { email, reason: 'suspended' } }); return fail(res, 'suspended', 403); }
  if (Sub.isExpired(company)) { Audit.record({ ...who, action: 'auth.login_blocked', details: { email, reason: 'subscription_expired' } }); return fail(res, 'subscription_expired', 403); }
  signIn(res, user);
  Audit.record({ ...who, action: 'auth.login' });
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  const imp = C.readImpersonation(req);
  if (imp) Audit.record({ actor_type: 'admin', actor_id: imp.admin_id, actor_name: imp.admin_email, actor_role: 'admin', company_id: imp.company_id, action: 'admin.impersonate_end', ip: req.ip, details: { mode: imp.mode } });
  res.clearCookie('token');
  res.clearCookie(C.IMP_COOKIE);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const company = db.prepare('SELECT id, name, currency, template FROM companies WHERE id = ?').get(req.cid);
  const tpl = TEMPLATES[company.template] || TEMPLATES.general;
  const stages = db.prepare('SELECT id, key, position, kind FROM stages WHERE company_id = ? ORDER BY position').all(req.cid);
  const modules = P.modulesFor(tpl.modules, req.perms);
  const timezone = company.template === 'carwash' ? U.getSettings(req.cid).timezone : null;
  const sub = Sub.stateOf({ id: req.cid, paid_until: req.paidUntil });
  // only the owner (and an inspecting admin) is told about the subscription term
  const subscription = req.user.role === 'owner' ? { unlimited: sub.unlimited, paid_until: sub.paid_until, blocks_on: sub.blocks_on, days_left: sub.days_left } : null;
  const impersonation = req.impersonation ? { mode: req.impersonation.mode, admin_email: req.impersonation.admin_email } : null;
  res.json({ user: req.user, permissions: req.perms, company: { ...company, modules, timezone }, stages, subscription, impersonation });
});

// ---- TEAM: employees + positions (routes/team.js) ----
app.use('/api', require('./routes/team'));

// ---- CONTACTS ----
app.get('/api/contacts', auth, C.requireTemplate('general'), perm('contacts.view', 'contacts.create', 'deals.create', 'deals.edit', 'tasks.create', 'tasks.edit'), (req, res) => {
  const q = str(req.query.q, 100);
  let rows;
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    rows = db
      .prepare(
        `SELECT * FROM contacts WHERE company_id = ? AND (name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR organization LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\') ORDER BY id DESC LIMIT 500`
      )
      .all(req.cid, like, like, like, like, like);
  } else {
    rows = db.prepare('SELECT * FROM contacts WHERE company_id = ? ORDER BY id DESC LIMIT 500').all(req.cid);
  }
  res.json(rows);
});

function contactBody(b) {
  return {
    name: str(b.name, 150),
    email: str(b.email, 200),
    phone: str(b.phone, 50),
    organization: str(b.organization, 150),
    tags: str(b.tags, 200),
    notes: str(b.notes, 5000),
  };
}

app.post('/api/contacts', auth, C.requireTemplate('general'), perm('contacts.create'), (req, res) => {
  const c = contactBody(req.body);
  if (!c.name) return fail(res, 'required');
  const id = db
    .prepare('INSERT INTO contacts (company_id, name, email, phone, organization, tags, notes, created_by) VALUES (?,?,?,?,?,?,?,?)')
    .run(req.cid, c.name, c.email, c.phone, c.organization, c.tags, c.notes, req.user.id).lastInsertRowid;
  res.status(201).json({ id });
});

app.put('/api/contacts/:id', auth, C.requireTemplate('general'), perm('contacts.edit'), (req, res) => {
  const c = contactBody(req.body);
  if (!c.name) return fail(res, 'required');
  const r = db
    .prepare('UPDATE contacts SET name=?, email=?, phone=?, organization=?, tags=?, notes=? WHERE id=? AND company_id=?')
    .run(c.name, c.email, c.phone, c.organization, c.tags, c.notes, idOrNull(req.params.id), req.cid);
  if (!r.changes) return fail(res, 'not_found', 404);
  res.json({ ok: true });
});

app.delete('/api/contacts/:id', auth, C.requireTemplate('general'), perm('contacts.delete'), (req, res) => {
  const r = db.prepare('DELETE FROM contacts WHERE id=? AND company_id=?').run(idOrNull(req.params.id), req.cid);
  if (!r.changes) return fail(res, 'not_found', 404);
  res.json({ ok: true });
});

// ---- DEALS ----
const DEAL_SELECT = `
  SELECT d.*, c.name AS contact_name, u.name AS owner_name
  FROM deals d
  LEFT JOIN contacts c ON c.id = d.contact_id
  LEFT JOIN users u ON u.id = d.owner_id
  WHERE d.company_id = ?`;

app.get('/api/deals', auth, C.requireTemplate('general'), perm('deals.view'), (req, res) => {
  res.json(db.prepare(DEAL_SELECT + ' ORDER BY d.id DESC LIMIT 2000').all(req.cid));
});

function validateDealRefs(req, contactId, ownerId, stageId) {
  return belongs('contacts', contactId, req.cid) && belongs('users', ownerId, req.cid) && (stageId === undefined || belongs('stages', stageId, req.cid));
}

app.post('/api/deals', auth, C.requireTemplate('general'), perm('deals.create'), (req, res) => {
  const title = str(req.body.title, 200);
  if (!title) return fail(res, 'required');
  const contactId = idOrNull(req.body.contact_id);
  // employees always own the deals they create; owner may assign anyone
  const ownerId = C.can(req, 'deals.edit') ? idOrNull(req.body.owner_id) || req.user.id : req.user.id;
  let stageId = idOrNull(req.body.stage_id);
  if (!stageId) stageId = db.prepare('SELECT id FROM stages WHERE company_id=? ORDER BY position LIMIT 1').get(req.cid).id;
  if (!validateDealRefs(req, contactId, ownerId, stageId)) return fail(res, 'bad_reference');
  const kind = db.prepare('SELECT kind FROM stages WHERE id=?').get(stageId).kind;
  const id = db
    .prepare('INSERT INTO deals (company_id, title, amount, contact_id, stage_id, owner_id, notes, created_by, closed_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(req.cid, title, num(req.body.amount), contactId, stageId, ownerId, str(req.body.notes, 5000), req.user.id, kind === 'open' ? null : new Date().toISOString()).lastInsertRowid;
  res.status(201).json({ id });
});

app.put('/api/deals/:id', auth, C.requireTemplate('general'), perm('deals.edit'), (req, res) => {
  const title = str(req.body.title, 200);
  if (!title) return fail(res, 'required');
  const id = idOrNull(req.params.id);
  const existing = db.prepare('SELECT * FROM deals WHERE id=? AND company_id=?').get(id, req.cid);
  if (!existing) return fail(res, 'not_found', 404);
  const contactId = idOrNull(req.body.contact_id);
  const ownerId = idOrNull(req.body.owner_id) || existing.owner_id;
  const stageId = idOrNull(req.body.stage_id) || existing.stage_id;
  if (!validateDealRefs(req, contactId, ownerId, stageId)) return fail(res, 'bad_reference');
  const kind = db.prepare('SELECT kind FROM stages WHERE id=?').get(stageId).kind;
  const closedAt = kind === 'open' ? null : existing.closed_at || new Date().toISOString();
  db.prepare('UPDATE deals SET title=?, amount=?, contact_id=?, owner_id=?, stage_id=?, notes=?, closed_at=? WHERE id=? AND company_id=?').run(
    title, num(req.body.amount), contactId, ownerId, stageId, str(req.body.notes, 5000), closedAt, id, req.cid
  );
  res.json({ ok: true });
});

// moving a deal between stages is allowed for everyone
app.patch('/api/deals/:id/stage', auth, C.requireTemplate('general'), perm('deals.move'), (req, res) => {
  const id = idOrNull(req.params.id);
  const stageId = idOrNull(req.body.stage_id);
  const deal = db.prepare('SELECT * FROM deals WHERE id=? AND company_id=?').get(id, req.cid);
  if (!deal) return fail(res, 'not_found', 404);
  const stage = db.prepare('SELECT * FROM stages WHERE id=? AND company_id=?').get(stageId, req.cid);
  if (!stage) return fail(res, 'bad_reference');
  const closedAt = stage.kind === 'open' ? null : deal.closed_at || new Date().toISOString();
  db.prepare('UPDATE deals SET stage_id=?, closed_at=? WHERE id=?').run(stage.id, closedAt, id);
  res.json({ ok: true });
});

app.delete('/api/deals/:id', auth, C.requireTemplate('general'), perm('deals.delete'), (req, res) => {
  const r = db.prepare('DELETE FROM deals WHERE id=? AND company_id=?').run(idOrNull(req.params.id), req.cid);
  if (!r.changes) return fail(res, 'not_found', 404);
  res.json({ ok: true });
});

// ---- TASKS ----
const TASK_SELECT = `
  SELECT t.*, u.name AS assignee_name, c.name AS contact_name, d.title AS deal_title
  FROM tasks t
  LEFT JOIN users u ON u.id = t.assignee_id
  LEFT JOIN contacts c ON c.id = t.contact_id
  LEFT JOIN deals d ON d.id = t.deal_id
  WHERE t.company_id = ?`;

app.get('/api/tasks', auth, C.requireTemplate('general'), perm('tasks.view'), (req, res) => {
  res.json(db.prepare(TASK_SELECT + ' ORDER BY t.done ASC, t.due_date IS NULL, t.due_date ASC, t.id DESC LIMIT 2000').all(req.cid));
});

app.post('/api/tasks', auth, C.requireTemplate('general'), perm('tasks.create'), (req, res) => {
  const title = str(req.body.title, 200);
  if (!title) return fail(res, 'required');
  const assignee = idOrNull(req.body.assignee_id) || req.user.id;
  const contactId = idOrNull(req.body.contact_id);
  const dealId = idOrNull(req.body.deal_id);
  if (!belongs('users', assignee, req.cid) || !belongs('contacts', contactId, req.cid) || !belongs('deals', dealId, req.cid))
    return fail(res, 'bad_reference');
  const id = db
    .prepare('INSERT INTO tasks (company_id, title, description, due_date, assignee_id, contact_id, deal_id, created_by) VALUES (?,?,?,?,?,?,?,?)')
    .run(req.cid, title, str(req.body.description, 5000), dateOrNull(req.body.due_date), assignee, contactId, dealId, req.user.id).lastInsertRowid;
  res.status(201).json({ id });
});

app.put('/api/tasks/:id', auth, C.requireTemplate('general'), perm('tasks.edit'), (req, res) => {
  const title = str(req.body.title, 200);
  if (!title) return fail(res, 'required');
  const assignee = idOrNull(req.body.assignee_id);
  const contactId = idOrNull(req.body.contact_id);
  const dealId = idOrNull(req.body.deal_id);
  if (!belongs('users', assignee, req.cid) || !belongs('contacts', contactId, req.cid) || !belongs('deals', dealId, req.cid))
    return fail(res, 'bad_reference');
  const r = db
    .prepare('UPDATE tasks SET title=?, description=?, due_date=?, assignee_id=?, contact_id=?, deal_id=? WHERE id=? AND company_id=?')
    .run(title, str(req.body.description, 5000), dateOrNull(req.body.due_date), assignee, contactId, dealId, idOrNull(req.params.id), req.cid);
  if (!r.changes) return fail(res, 'not_found', 404);
  res.json({ ok: true });
});

// completing a task: owner any task, employee only tasks assigned to / created by them
app.patch('/api/tasks/:id/done', auth, C.requireTemplate('general'), perm('tasks.complete', 'tasks.edit'), (req, res) => {
  const id = idOrNull(req.params.id);
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND company_id=?').get(id, req.cid);
  if (!task) return fail(res, 'not_found', 404);
  if (!C.can(req, 'tasks.edit') && task.assignee_id !== req.user.id && task.created_by !== req.user.id) return fail(res, 'forbidden', 403);
  db.prepare('UPDATE tasks SET done=? WHERE id=?').run(req.body.done ? 1 : 0, id);
  res.json({ ok: true });
});

app.delete('/api/tasks/:id', auth, C.requireTemplate('general'), perm('tasks.delete'), (req, res) => {
  const r = db.prepare('DELETE FROM tasks WHERE id=? AND company_id=?').run(idOrNull(req.params.id), req.cid);
  if (!r.changes) return fail(res, 'not_found', 404);
  res.json({ ok: true });
});

// ---- DASHBOARD ----
app.get('/api/dashboard', auth, C.requireTemplate('general'), perm('dashboard.view'), (req, res) => {
  const cid = req.cid;
  const today = dateOrNull(req.query.today) || new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  const contacts = one('SELECT COUNT(*) n FROM contacts WHERE company_id=?', cid).n;
  const open = one(`SELECT COUNT(*) n, COALESCE(SUM(d.amount),0) s FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.company_id=? AND s.kind='open'`, cid);
  const won = one(`SELECT COUNT(*) n, COALESCE(SUM(d.amount),0) s FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.company_id=? AND s.kind='won'`, cid);
  const wonMonth = one(`SELECT COALESCE(SUM(d.amount),0) s FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.company_id=? AND s.kind='won' AND substr(d.closed_at,1,10) >= ?`, cid, monthStart);
  const lost = one(`SELECT COUNT(*) n FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.company_id=? AND s.kind='lost'`, cid).n;
  const tasksOpen = one('SELECT COUNT(*) n FROM tasks WHERE company_id=? AND done=0', cid).n;
  const overdue = one('SELECT COUNT(*) n FROM tasks WHERE company_id=? AND done=0 AND due_date IS NOT NULL AND due_date < ?', cid, today).n;
  const dueToday = one('SELECT COUNT(*) n FROM tasks WHERE company_id=? AND done=0 AND due_date = ?', cid, today).n;

  const funnel = db
    .prepare(
      `SELECT s.id, s.key, s.kind, COUNT(d.id) AS count, COALESCE(SUM(d.amount),0) AS sum
       FROM stages s LEFT JOIN deals d ON d.stage_id = s.id
       WHERE s.company_id = ? GROUP BY s.id ORDER BY s.position`
    )
    .all(cid);

  const byManager = db
    .prepare(
      `SELECT u.id, u.name,
         COUNT(CASE WHEN s.kind='won' THEN 1 END) AS won_count,
         COALESCE(SUM(CASE WHEN s.kind='won' THEN d.amount END),0) AS won_sum,
         COUNT(CASE WHEN s.kind='open' THEN 1 END) AS open_count
       FROM users u
       LEFT JOIN deals d ON d.owner_id = u.id
       LEFT JOIN stages s ON s.id = d.stage_id
       WHERE u.company_id = ? GROUP BY u.id ORDER BY won_sum DESC`
    )
    .all(cid);

  const monthly = db
    .prepare(
      `SELECT substr(d.closed_at,1,7) AS month, COALESCE(SUM(d.amount),0) AS sum, COUNT(*) AS count
       FROM deals d JOIN stages s ON s.id=d.stage_id
       WHERE d.company_id=? AND s.kind='won' AND d.closed_at IS NOT NULL
       GROUP BY month ORDER BY month DESC LIMIT 6`
    )
    .all(cid)
    .reverse();

  res.json({
    contacts,
    openDeals: open.n,
    openSum: open.s,
    wonDeals: won.n,
    wonSum: won.s,
    wonMonthSum: wonMonth.s,
    lostDeals: lost,
    conversion: won.n + lost > 0 ? won.n / (won.n + lost) : null,
    tasksOpen,
    overdue,
    dueToday,
    funnel,
    byManager,
    monthly,
  });
});

// ---- car wash template + platform admin ----
app.use('/api/admin', require('./routes/admin'));
app.use('/api/cw', require('./routes/carwash'));

// ---- static frontend ----
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res) => fail(res, 'not_found', 404));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return fail(res, 'bad_json');
  console.error(err);
  fail(res, 'server_error', 500);
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`CRM running: http://localhost:${PORT}`));
  require('./lib/worker').start();
}
module.exports = app;
