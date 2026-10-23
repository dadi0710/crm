// Audit log: who did what, when, to which object. Append-only (database triggers refuse UPDATE/DELETE)
// and hash-chained, so a quiet edit can be detected. Suspicious behaviour is flagged with a reason.
const crypto = require('crypto');
const { db } = require('../db');
const U = require('./util');

const SECRET_RE = /pass|token|secret|hash/i;
const SKIP_FIELDS = new Set(['id', 'created_at', 'company_id']);

function redact(v, depth = 0) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + '…' : v;
  if (typeof v !== 'object') return v;
  if (depth > 3) return '…';
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (SECRET_RE.test(k)) continue;
    out[k] = redact(val, depth + 1);
  }
  return out;
}

const FIELDS = ['ts', 'company_id', 'actor_type', 'actor_id', 'actor_name', 'actor_role', 'action', 'entity_type', 'entity_id', 'entity_label', 'details', 'ip', 'suspicious', 'suspicious_reason'];
const rowHash = (prev, r) => crypto.createHash('sha256').update((prev || '') + '␟' + FIELDS.map((k) => String(r[k] ?? '')).join('␟')).digest('hex');

// ---------- suspicious-behaviour rules ----------
const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();
function assess(e, ts) {
  if (e.suspicious) return { suspicious: 1, reason: e.reason || '' };
  const d = e.details || {};
  const who = (type, id) => (id ? ['actor_type = ? AND actor_id = ?', [type, id]] : ['actor_type = ?', [type]]);
  // failed logins: guessing passwords
  if (e.action === 'auth.login_failed' || e.action === 'admin.login_failed') {
    const n = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = ? AND ts >= ? AND (ip = ? OR details LIKE ?)").get(e.action, minutesAgo(15), e.ip || '-', `%"email":${JSON.stringify(d.email || '-')}%`).n + 1;
    if (n >= 5) return { suspicious: 1, reason: `Подбор пароля: ${n} неудачных входов за 15 минут` };
    return { suspicious: 0 };
  }
  if (e.action === 'auth.login' || e.action === 'admin.login') {
    const failed = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action IN ('auth.login_failed','admin.login_failed') AND ts >= ? AND (ip = ? OR details LIKE ?)").get(minutesAgo(15), e.ip || '-', `%"email":${JSON.stringify(d.email || '-')}%`).n;
    if (failed >= 3) return { suspicious: 1, reason: `Вход после ${failed} неудачных попыток` };
    return { suspicious: 0 };
  }
  if (e.action === 'access.denied') return { suspicious: 1, reason: 'Запрос без нужного права (интерфейс такое не отправляет)' };
  if (e.action === 'complaint.delete') return { suspicious: 1, reason: 'Удалена жалоба' };
  if (e.action === 'visit.delete' && d.data?.status === 'done') return { suspicious: 1, reason: 'Удалена завершённая запись (влияет на выручку)' };
  if (e.action === 'admin.impersonate_start' && d.mode === 'act') return { suspicious: 1, reason: 'Администратор платформы вошёл в CRM в режиме действий' };
  if (e.action.endsWith('.delete')) {
    const [w, p] = who(e.actor_type, e.actor_id);
    const n = db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action LIKE '%.delete' AND ts >= ? AND ${w}`).get(minutesAgo(10), ...p).n + 1;
    if (n >= 5) return { suspicious: 1, reason: `Массовое удаление: ${n} удалений за 10 минут` };
  }
  const disc = d.changes?.discount_percent?.[1] ?? d.body?.discount_percent;
  if (Number(disc) >= 50) return { suspicious: 1, reason: `Скидка ${disc}%` };
  if (e.action.startsWith('position.')) {
    const added = [...((d.changes?.permissions?.[1]) || []), ...(Array.isArray(d.data?.permissions) ? d.data.permissions : [])];
    const risky = added.filter((k) => ['settings.manage', 'team.manage', 'analytics.view', 'visits.delete', 'customers.delete'].includes(k));
    if (risky.length && !(d.changes?.permissions?.[0] || []).some((k) => risky.includes(k))) return { suspicious: 1, reason: `Выданы чувствительные права: ${[...new Set(risky)].join(', ')}` };
  }
  // employees changing or deleting things in the middle of the night (company-local time)
  if (e.actor_type === 'user' && e.actor_role !== 'owner' && /\.(update|delete|status)$/.test(e.action) && e.company_id) {
    const hour = +U.localParts(U.getSettings(e.company_id).timezone, new Date(ts)).time.slice(0, 2);
    if (hour < 5) return { suspicious: 1, reason: 'Изменение данных сотрудником в ночное время' };
  }
  return { suspicious: 0 };
}

function record(e) {
  try {
    const ts = new Date().toISOString();
    let companyName = e.company_name || null;
    if (e.company_id && !companyName) companyName = db.prepare('SELECT name FROM companies WHERE id = ?').get(e.company_id)?.name || null;
    const details = e.details ? redact(e.details) : null;
    const ev = { ...e, details };
    const a = assess(ev, ts);
    const row = {
      ts, company_id: e.company_id ?? null, actor_type: e.actor_type || 'system', actor_id: e.actor_id ?? null,
      actor_name: e.actor_name ?? null, actor_role: e.actor_role ?? null, action: e.action,
      entity_type: e.entity_type ?? null, entity_id: e.entity_id ?? null, entity_label: e.entity_label ? String(e.entity_label).slice(0, 200) : null,
      details: details ? JSON.stringify(details).slice(0, 6000) : null, ip: e.ip ?? null,
      suspicious: a.suspicious ? 1 : 0, suspicious_reason: a.suspicious ? a.reason || null : null,
    };
    db.transaction(() => {
      const prev = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get()?.hash || '';
      const hash = rowHash(prev, row);
      db.prepare(
        `INSERT INTO audit_log (ts, company_id, company_name, actor_type, actor_id, actor_name, actor_role, action, entity_type, entity_id, entity_label, details, ip, suspicious, suspicious_reason, prev_hash, hash)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(row.ts, row.company_id, companyName, row.actor_type, row.actor_id, row.actor_name, row.actor_role, row.action, row.entity_type, row.entity_id, row.entity_label, row.details, row.ip, row.suspicious, row.suspicious_reason, prev, hash);
    })();
  } catch (err) {
    console.error('audit log failed:', err.message); // logging must never break the action itself
  }
}

/** Recomputes the whole chain. Returns { ok, checked, brokenAt }. */
function verifyChain() {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id').all();
  let prev = '';
  for (const r of rows) {
    if ((r.prev_hash || '') !== prev || rowHash(prev, r) !== r.hash) return { ok: false, checked: rows.length, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length, brokenAt: null };
}

// ---------- automatic logging of company API calls ----------
const TABLE_LABEL = {
  contacts: (r) => r.name, deals: (r) => r.title, tasks: (r) => r.title, users: (r) => r.name, positions: (r) => r.name,
  cw_services: (r) => r.name, cw_bays: (r) => r.name, cw_customer_statuses: (r) => r.name, cw_customers: (r) => r.name,
  cw_cars: (r) => r.plate, cw_ads: (r) => `${r.channel} ${r.date}`, cw_followups: (r) => r.kind,
  cw_complaints: (r) => String(r.text || r.type || '').slice(0, 60), cw_messages: (r) => `${r.kind} → ${r.phone}`,
  cw_visits: (r) => {
    const car = r.car_id ? db.prepare('SELECT plate FROM cw_cars WHERE id = ?').get(r.car_id) : null;
    return `${car?.plate || '#' + r.id} · ${r.scheduled_start}`;
  },
};
// [method, path, action, entity, table, options]
const RULES = [
  ['POST', '/contacts', 'contact.create', 'contact', 'contacts'], ['PUT', '/contacts/:id', 'contact.update', 'contact', 'contacts'], ['DELETE', '/contacts/:id', 'contact.delete', 'contact', 'contacts'],
  ['POST', '/deals', 'deal.create', 'deal', 'deals'], ['PUT', '/deals/:id', 'deal.update', 'deal', 'deals'], ['PATCH', '/deals/:id/stage', 'deal.update', 'deal', 'deals'], ['DELETE', '/deals/:id', 'deal.delete', 'deal', 'deals'],
  ['POST', '/tasks', 'task.create', 'task', 'tasks'], ['PUT', '/tasks/:id', 'task.update', 'task', 'tasks'], ['PATCH', '/tasks/:id/done', 'task.update', 'task', 'tasks'], ['DELETE', '/tasks/:id', 'task.delete', 'task', 'tasks'],
  ['POST', '/users', 'user.create', 'user', 'users'], ['PUT', '/users/:id', 'user.update', 'user', 'users'], ['DELETE', '/users/:id', 'user.delete', 'user', 'users'],
  ['POST', '/positions', 'position.create', 'position', 'positions'], ['PUT', '/positions/:id', 'position.update', 'position', 'positions'], ['DELETE', '/positions/:id', 'position.delete', 'position', 'positions'],
  ['PUT', '/cw/settings', 'settings.update', 'settings', 'settings'],
  ['POST', '/cw/services', 'service.create', 'service', 'cw_services'], ['PUT', '/cw/services/:id', 'service.update', 'service', 'cw_services'], ['DELETE', '/cw/services/:id', 'service.delete', 'service', 'cw_services'],
  ['POST', '/cw/bays', 'bay.create', 'bay', 'cw_bays'], ['PUT', '/cw/bays/:id', 'bay.update', 'bay', 'cw_bays'], ['DELETE', '/cw/bays/:id', 'bay.delete', 'bay', 'cw_bays'],
  ['POST', '/cw/statuses', 'customer_status.create', 'customer_status', 'cw_customer_statuses'], ['PUT', '/cw/statuses/:id', 'customer_status.update', 'customer_status', 'cw_customer_statuses'], ['DELETE', '/cw/statuses/:id', 'customer_status.delete', 'customer_status', 'cw_customer_statuses'],
  ['POST', '/cw/customers', 'customer.create', 'customer', 'cw_customers'], ['PUT', '/cw/customers/:id', 'customer.update', 'customer', 'cw_customers'], ['DELETE', '/cw/customers/:id', 'customer.delete', 'customer', 'cw_customers'],
  ['POST', '/cw/customers/:cid/cars', 'car.create', 'car', 'cw_cars'], ['PUT', '/cw/cars/:id', 'car.update', 'car', 'cw_cars'], ['DELETE', '/cw/cars/:id', 'car.delete', 'car', 'cw_cars'],
  ['POST', '/cw/visits', 'visit.create', 'visit', 'cw_visits'], ['PUT', '/cw/visits/:id', 'visit.update', 'visit', 'cw_visits'], ['DELETE', '/cw/visits/:id', 'visit.delete', 'visit', 'cw_visits'],
  ['PATCH', '/cw/visits/:id/status', 'visit.status', 'visit', 'cw_visits'], ['PATCH', '/cw/visits/:id/notes', 'visit.update', 'visit', 'cw_visits'],
  ['PATCH', '/cw/visits/:id/assign', 'visit.update', 'visit', 'cw_visits'], ['PATCH', '/cw/visits/:id/reschedule', 'visit.reschedule', 'visit', 'cw_visits'],
  ['POST', '/cw/visits/:id/delay', 'visit.delay', 'visit', 'cw_visits'], ['POST', '/cw/visits/:id/rework', 'visit.rework', 'visit', 'cw_visits'],
  ['POST', '/cw/complaints', 'complaint.create', 'complaint', 'cw_complaints'], ['PATCH', '/cw/complaints/:id', 'complaint.update', 'complaint', 'cw_complaints'], ['DELETE', '/cw/complaints/:id', 'complaint.delete', 'complaint', 'cw_complaints'],
  ['POST', '/cw/followups', 'followup.create', 'followup', 'cw_followups'], ['PATCH', '/cw/followups/:id', 'followup.update', 'followup', 'cw_followups'],
  ['PUT', '/cw/messages/:id', 'message.edit', 'message', 'cw_messages'], ['PATCH', '/cw/messages/:id', 'message.sent', 'message', 'cw_messages'], ['POST', '/cw/messages/:id/cancel', 'message.cancel', 'message', 'cw_messages'],
  ['POST', '/cw/retention/run', 'retention.run', 'company', null],
  ['POST', '/cw/ads', 'ad.create', 'ad', 'cw_ads'], ['DELETE', '/cw/ads/:id', 'ad.delete', 'ad', 'cw_ads'],
  ['GET', '/cw/export', 'export.download', 'export', null],
].map(([method, path, action, entity, table]) => {
  const names = [];
  const re = new RegExp('^/api' + path.replace(/:(\w+)/g, (m, n) => (names.push(n), '(\\d+)')) + '/?$');
  return { method, re, names, action, entity, table };
});
function matchRule(method, url) {
  const path = url.split('?')[0];
  for (const r of RULES) {
    if (r.method !== method) continue;
    const m = r.re.exec(path);
    if (m) return { rule: r, params: Object.fromEntries(r.names.map((n, i) => [n, Number(m[i + 1])])) };
  }
  return null;
}

const fetchRow = (table, id, cid) => {
  if (table === 'settings') return U.getSettings(cid);
  if (!table || !id) return null;
  return table === 'users' || table === 'positions' || table.startsWith('cw_') || ['contacts', 'deals', 'tasks'].includes(table)
    ? db.prepare(`SELECT * FROM ${table} WHERE id = ? AND company_id = ?`).get(id, cid) || null
    : null;
};
// the editing handlers run after authentication: take the "before" picture then
function snapshot(req) {
  const a = req._audit;
  if (!a || !a.rule.table || a.rule.method === 'POST') return;
  const id = a.params.id;
  try { a.before = fetchRow(a.rule.table, id, req.cid); } catch { a.before = null; }
}
function diff(before, after, prefix = '') {
  const out = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (SKIP_FIELDS.has(k) || SECRET_RE.test(k)) continue;
    const b = before?.[k], a = after?.[k];
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    if (b && a && typeof b === 'object' && typeof a === 'object' && !Array.isArray(b) && !Array.isArray(a)) Object.assign(out, diff(b, a, prefix + k + '.'));
    else out[prefix + k] = [b ?? null, a ?? null];
  }
  return out;
}
const clean = (row) => (row ? Object.fromEntries(Object.entries(row).filter(([k]) => !SECRET_RE.test(k) && !SKIP_FIELDS.has(k))) : null);
// permissions are stored as JSON text: compare them as lists
const normalize = (row) => {
  if (row && typeof row.permissions === 'string') { try { return { ...row, permissions: JSON.parse(row.permissions) }; } catch { /* keep text */ } }
  return row;
};

function http(req, res, next) {
  const m = matchRule(req.method, req.originalUrl);
  if (m) req._audit = { ...m, before: null };
  const json = res.json.bind(res);
  res.json = (body) => { res._body = body; return json(body); };
  res.on('finish', () => {
    try {
      if (!req.user || !req.cid) return;
      const imp = req.impersonation;
      const actor = imp
        ? { actor_type: 'admin', actor_id: imp.admin_id, actor_name: imp.admin_email, actor_role: 'admin' }
        : { actor_type: 'user', actor_id: req.user.id, actor_name: req.user.name, actor_role: req.user.role };
      const base = { company_id: req.cid, ip: req.ip, ...actor };
      if (res.statusCode === 403 && res._body?.error === 'forbidden') {
        record({ ...base, action: 'access.denied', details: { method: req.method, path: req.originalUrl.split('?')[0] } });
        return;
      }
      const a = req._audit;
      if (!a || res.statusCode >= 400) return;
      const { rule, params } = a;
      const id = params.id || res._body?.id || null;
      const after = rule.method === 'DELETE' || !rule.table ? null : normalize(fetchRow(rule.table, id, req.cid));
      const before = normalize(a.before);
      let details = {};
      if (rule.method === 'PUT' || rule.method === 'PATCH' || (rule.table === 'settings')) details = { changes: diff(before, after) };
      else if (rule.method === 'DELETE') details = { data: clean(before) };
      else if (rule.method === 'POST') details = { data: clean(after) || undefined, body: rule.table ? undefined : req.body };
      else if (rule.method === 'GET') details = { query: req.query };
      if (imp) details.via = `admin:${imp.mode}`;
      if (req.method === 'POST' && rule.action === 'visit.create') details.body = { discount_percent: req.body?.discount_percent };
      const row = rule.table === 'settings' ? null : after || before;
      const label = row && TABLE_LABEL[rule.table] ? TABLE_LABEL[rule.table](row) : null;
      record({ ...base, action: rule.action, entity_type: rule.entity, entity_id: id, entity_label: label, details });
    } catch (err) {
      console.error('audit http failed:', err.message);
    }
  });
  next();
}

module.exports = { record, verifyChain, http, snapshot, redact };
