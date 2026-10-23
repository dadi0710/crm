// Car wash template API: bookings, live queue, customers & cars, loyalty,
// win-back follow-ups, analytics, staff control. Mounted at /api/cw.
const express = require('express');
const { db } = require('../db');
const C = require('../lib/common');
const U = require('../lib/util');
const M = require('../lib/messages');
const { runRetention, settleCustomer } = require('../lib/retention');

const { fail, str, num, idOrNull, belongs, perm } = C;
const can = (req, ...k) => C.can(req, ...k);
const r = express.Router();
r.use(C.auth, C.requireTemplate('carwash'));

const STATUSES = ['new', 'confirmed', 'arrived', 'in_progress', 'done', 'cancelled'];
const FINISHED = ['done', 'cancelled'];
const round2 = (n) => Math.round(n * 100) / 100;
const ctx = (req) => {
  const s = U.getSettings(req.cid);
  return { s, now: U.nowFor(s) };
};
const likeEsc = (q) => `%${q.replace(/[%_\\]/g, '\\$&')}%`;
const VISIT_DATE = "COALESCE(substr(v.finished_at,1,10), substr(v.scheduled_start,1,10))";
const placeholders = (n) => Array(n).fill('?').join(',');

// =====================================================================
// helpers
// =====================================================================
const VISIT_SQL = `
  SELECT v.*, c.name AS customer_name, c.phone AS customer_phone, c.whatsapp AS customer_whatsapp,
         k.plate, k.make, k.model, b.name AS bay_name, u.name AS staff_name, a.name AS accepted_name
  FROM cw_visits v
  LEFT JOIN cw_customers c ON c.id = v.customer_id
  LEFT JOIN cw_cars k ON k.id = v.car_id
  LEFT JOIN cw_bays b ON b.id = v.bay_id
  LEFT JOIN users u ON u.id = v.staff_id
  LEFT JOIN users a ON a.id = v.accepted_by
  WHERE v.company_id = ?`;

function attachServices(rows) {
  if (!rows.length) return rows;
  const lines = db
    .prepare(`SELECT * FROM cw_visit_services WHERE visit_id IN (${placeholders(rows.length)}) ORDER BY id`)
    .all(...rows.map((x) => x.id));
  const map = new Map();
  for (const l of lines) {
    if (!map.has(l.visit_id)) map.set(l.visit_id, []);
    map.get(l.visit_id).push({ id: l.id, service_id: l.service_id, name: l.name, price: l.price, duration_min: l.duration_min });
  }
  for (const v of rows) v.services = map.get(v.id) || [];
  return rows;
}
const getVisit = (cid, id) => db.prepare(VISIT_SQL + ' AND v.id = ?').get(cid, id);

function loyaltyFor(cid, carId, s, excludeVisitId = 0) {
  const L = s.loyalty;
  if (!carId) return { enabled: false };
  const n = db
    .prepare("SELECT COUNT(*) n FROM cw_visits WHERE company_id=? AND car_id=? AND status='done' AND is_rework=0 AND id != ?")
    .get(cid, carId, excludeVisitId).n;
  return {
    enabled: !!L.enabled, every: L.every, done: n, progress: n % L.every,
    next_free: !!L.enabled && (n + 1) % L.every === 0, max_free_price: L.max_free_price || 0,
  };
}

// Final price of a visit, including the "every Nth wash is free" rule.
function priceFor(visit, s) {
  if (visit.is_rework) return { final_price: 0, is_free: 0 };
  const discounted = round2(visit.price * (1 - visit.discount_percent / 100));
  if (visit.status !== 'done') return { final_price: discounted, is_free: 0 };
  const l = loyaltyFor(visit.company_id, visit.car_id, s, visit.id);
  if (l.enabled && l.next_free) {
    const cap = l.max_free_price;
    const free = cap > 0 ? Math.max(0, round2(visit.price - cap)) : 0;
    return { final_price: Math.min(discounted, free), is_free: 1 };
  }
  return { final_price: discounted, is_free: 0 };
}

function bayConflict(cid, bayId, start, duration, excludeId = 0) {
  if (!bayId) return null;
  const s0 = U.parseNaive(start);
  const s1 = s0 + duration * 60000;
  const near = db
    .prepare(
      `SELECT id, scheduled_start, duration_min FROM cw_visits
       WHERE company_id=? AND bay_id=? AND id != ? AND status NOT IN ('cancelled','done')
         AND substr(scheduled_start,1,10) BETWEEN ? AND ?`
    )
    .all(cid, bayId, excludeId, U.addDays(start.slice(0, 10), -1), U.addDays(start.slice(0, 10), 1));
  return near.find((o) => {
    const a = U.parseNaive(o.scheduled_start);
    return a < s1 && a + o.duration_min * 60000 > s0;
  }) || null;
}

function createCar(cid, customerId, c, now) {
  const plate = U.normPlate(c.plate);
  if (!plate) return { error: 'plate_required' };
  const ex = db.prepare('SELECT id, customer_id FROM cw_cars WHERE company_id=? AND plate=?').get(cid, plate);
  if (ex) return { error: 'plate_taken', customer_id: ex.customer_id, car_id: ex.id };
  const id = Number(
    db.prepare('INSERT INTO cw_cars (company_id, customer_id, plate, make, model, created_at) VALUES (?,?,?,?,?,?)')
      .run(cid, customerId, plate, str(c.make, 60), str(c.model, 60), now.full).lastInsertRowid
  );
  return { id };
}

function customerBody(b, canDiscount) {
  const o = {
    name: str(b.name, 150), phone: str(b.phone, 40), whatsapp: str(b.whatsapp, 40), instagram: str(b.instagram, 60),
    preferences: str(b.preferences, 1000), notes: str(b.notes, 3000), source: str(b.source, 60),
    marketing_opt_out: b.marketing_opt_out ? 1 : 0,
  };
  if (canDiscount) o.discount_percent = Math.min(100, num(b.discount_percent, 101));
  return o;
}

const CUSTOMER_STATS = `
  SELECT c.*, COALESCE(s.visits,0) AS visits, COALESCE(s.total,0) AS total, s.last_visit AS last_visit,
         (SELECT group_concat(k.plate, ', ') FROM cw_cars k WHERE k.customer_id = c.id) AS plates,
         (SELECT group_concat(TRIM(k.make || ' ' || k.model), ', ') FROM cw_cars k WHERE k.customer_id = c.id) AS car_names,
         (SELECT st.name FROM cw_customer_statuses st WHERE st.id = c.status_id) AS status_name,
         (SELECT st.color FROM cw_customer_statuses st WHERE st.id = c.status_id) AS status_color
  FROM cw_customers c
  LEFT JOIN (
    SELECT customer_id, COUNT(*) AS visits, SUM(final_price) AS total,
           MAX(COALESCE(substr(finished_at,1,10), substr(scheduled_start,1,10))) AS last_visit
    FROM cw_visits WHERE company_id = ? AND status = 'done' AND is_rework = 0 GROUP BY customer_id
  ) s ON s.customer_id = c.id
  WHERE c.company_id = ?`;
const withAvg = (c) => ({ ...c, avg_check: c.visits ? round2(c.total / c.visits) : 0 });

const waLink = (phone, text) => (phone ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}` : '');

// =====================================================================
// bootstrap, settings, services, bays
// =====================================================================
r.get('/bootstrap', (req, res) => {
  const { s, now } = ctx(req);
  const isOwner = can(req, 'settings.manage');
  res.json({
    now: now.dt, today: now.date,
    settings: U.publicSettings(s),
    services: db.prepare(`SELECT * FROM cw_services WHERE company_id=? ${isOwner ? '' : 'AND active=1'} ORDER BY position, id`).all(req.cid),
    bays: db.prepare(`SELECT * FROM cw_bays WHERE company_id=? ${isOwner ? '' : 'AND active=1'} ORDER BY position, id`).all(req.cid),
    users: db.prepare('SELECT id, name, role FROM users WHERE company_id=? ORDER BY id').all(req.cid),
    statuses: db.prepare('SELECT id, name, color, position FROM cw_customer_statuses WHERE company_id=? ORDER BY position, id').all(req.cid),
  });
});


// Working-hours guard shared by booking, edit and reschedule (the UI checks the same rule, the server is the judge).
function hoursProblem(s, start, duration) {
  const code = U.checkHours(s, start, duration);
  return code && { error: code, open_time: s.open_time, close_time: s.close_time, break_from: s.break_from, break_to: s.break_to };
}

function sanitizeSettings(b, cur) {
  const s = JSON.parse(JSON.stringify(cur));
  const int = (v, lo, hi, d) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : d;
  };
  const hhmm = (v, d) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : d);
  if (b.language) s.language = ['ru', 'kk', 'en'].includes(b.language) ? b.language : 'ru';
  s.open_time = hhmm(b.open_time, s.open_time);
  s.close_time = hhmm(b.close_time, s.close_time);
  if (U.hhmmToMin(s.close_time) <= U.hhmmToMin(s.open_time)) { s.open_time = cur.open_time; s.close_time = cur.close_time; }
  // optional break (lunch): both ends or none
  if (b.break_from !== undefined || b.break_to !== undefined) {
    const bf = hhmm(b.break_from, ''), bt = hhmm(b.break_to, '');
    const ok = bf && bt && U.hhmmToMin(bt) > U.hhmmToMin(bf) && U.hhmmToMin(bf) >= U.hhmmToMin(s.open_time) && U.hhmmToMin(bt) <= U.hhmmToMin(s.close_time);
    s.break_from = ok ? bf : '';
    s.break_to = ok ? bt : '';
  }
  if (b.slot_minutes !== undefined) s.slot_minutes = [10, 15, 20, 30, 60].includes(Number(b.slot_minutes)) ? Number(b.slot_minutes) : s.slot_minutes;
  if (b.loyalty) {
    s.loyalty.enabled = !!b.loyalty.enabled;
    s.loyalty.every = int(b.loyalty.every, 2, 100, s.loyalty.every);
    s.loyalty.max_free_price = num(b.loyalty.max_free_price, 1e9);
  }
  if (Array.isArray(b.channels)) s.channels = [...new Set(b.channels.map((x) => str(x, 40)).filter(Boolean))].slice(0, 20);
  if (b.retention) {
    const x = b.retention;
    const R = s.retention;
    if (x.auto_send !== undefined) R.auto_send = !!x.auto_send;
    if (x.reminder) { R.reminder.enabled = !!x.reminder.enabled; R.reminder.days = int(x.reminder.days, 1, 365, R.reminder.days); }
    if (x.offer) {
      R.offer.enabled = !!x.offer.enabled; R.offer.days = int(x.offer.days, 1, 365, R.offer.days);
      R.offer.text = str(x.offer.text, 200) || R.offer.text;
    }
    if (x.regular) {
      R.regular.enabled = !!x.regular.enabled;
      R.regular.min_visits = int(x.regular.min_visits, 2, 50, R.regular.min_visits);
      R.regular.usual_gap_days = int(x.regular.usual_gap_days, 1, 60, R.regular.usual_gap_days);
      const f = Number(x.regular.miss_factor);
      R.regular.miss_factor = Number.isFinite(f) && f >= 1.2 && f <= 10 ? f : R.regular.miss_factor;
    }
    if (x.review) {
      R.review.enabled = !!x.review.enabled; R.review.delay_min = int(x.review.delay_min, 0, 1440, R.review.delay_min);
      const link = str(x.review.link, 300);
      R.review.link = /^https?:\/\//i.test(link) ? link : '';
    }
    R.send_from = hhmm(x.send_from, R.send_from);
    R.send_to = hhmm(x.send_to, R.send_to);
  }
  return s;
}

r.put('/settings', perm('settings.manage'), (req, res) => {
  const cur = U.getSettings(req.cid);
  const next = sanitizeSettings(req.body || {}, cur);
  U.saveSettings(req.cid, next);
  res.json({ settings: U.publicSettings(next) });
});

const serviceBody = (b) => ({
  name: str(b.name, 100), price: num(b.price, 1e9), duration_min: Math.min(720, Math.max(5, Math.round(Number(b.duration_min)) || 30)),
});
r.post('/services', perm('settings.manage'), (req, res) => {
  const v = serviceBody(req.body || {});
  if (!v.name) return fail(res, 'required');
  const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM cw_services WHERE company_id=?').get(req.cid).p;
  const id = db.prepare('INSERT INTO cw_services (company_id, name, price, duration_min, position) VALUES (?,?,?,?,?)').run(req.cid, v.name, v.price, v.duration_min, pos).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
r.put('/services/:id', perm('settings.manage'), (req, res) => {
  const v = serviceBody(req.body || {});
  if (!v.name) return fail(res, 'required');
  const x = db.prepare('UPDATE cw_services SET name=?, price=?, duration_min=?, active=? WHERE id=? AND company_id=?')
    .run(v.name, v.price, v.duration_min, req.body.active === false ? 0 : 1, idOrNull(req.params.id), req.cid);
  if (!x.changes) return fail(res, 'not_found', 404);
  res.json({ ok: true });
});
r.delete('/services/:id', perm('settings.manage'), (req, res) => {
  const x = db.prepare('DELETE FROM cw_services WHERE id=? AND company_id=?').run(idOrNull(req.params.id), req.cid);
  if (!x.changes) return fail(res, 'not_found', 404);
  res.json({ ok: true });
});

r.post('/bays', perm('settings.manage'), (req, res) => {
  const name = str(req.body.name, 60);
  if (!name) return fail(res, 'required');
  const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM cw_bays WHERE company_id=?').get(req.cid).p;
  const id = db.prepare('INSERT INTO cw_bays (company_id, name, position) VALUES (?,?,?)').run(req.cid, name, pos).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
r.put('/bays/:id', perm('settings.manage'), (req, res) => {
  const name = str(req.body.name, 60);
  if (!name) return fail(res, 'required');
  const x = db.prepare('UPDATE cw_bays SET name=?, active=? WHERE id=? AND company_id=?').run(name, req.body.active === false ? 0 : 1, idOrNull(req.params.id), req.cid);
  if (!x.changes) return fail(res, 'not_found', 404);
  res.json({ ok: true });
});
r.delete('/bays/:id', perm('settings.manage'), (req, res) => {
  const x = db.prepare('DELETE FROM cw_bays WHERE id=? AND company_id=?').run(idOrNull(req.params.id), req.cid);
  if (!x.changes) return fail(res, 'not_found', 404);
  res.json({ ok: true });
});

// ---- client statuses (owner: settings.manage) ----
const COLOR = /^#[0-9a-fA-F]{6}$/;
const statusBody = (b) => ({ name: str(b?.name, 40), color: COLOR.test(b?.color || '') ? b.color.toLowerCase() : '#64748b' });
// compared in JS: SQLite's lower() only understands ASCII, not Cyrillic
const statusNameTaken = (cid, name, exceptId = 0) =>
  db.prepare('SELECT id, name FROM cw_customer_statuses WHERE company_id=?').all(cid).some((x) => x.id !== exceptId && x.name.toLowerCase() === name.toLowerCase());
r.get('/statuses', perm('customers.view', 'settings.manage'), (req, res) => {
  res.json(db.prepare(
    `SELECT s.id, s.name, s.color, s.position, (SELECT COUNT(*) FROM cw_customers c WHERE c.status_id = s.id) AS customers
     FROM cw_customer_statuses s WHERE s.company_id=? ORDER BY s.position, s.id`
  ).all(req.cid));
});
r.post('/statuses', perm('settings.manage'), (req, res) => {
  const v = statusBody(req.body);
  if (!v.name) return fail(res, 'required');
  if (statusNameTaken(req.cid, v.name)) return fail(res, 'status_exists', 409);
  const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM cw_customer_statuses WHERE company_id=?').get(req.cid).p;
  const id = db.prepare('INSERT INTO cw_customer_statuses (company_id, name, color, position) VALUES (?,?,?,?)').run(req.cid, v.name, v.color, pos).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
r.put('/statuses/:id', perm('settings.manage'), (req, res) => {
  const id = idOrNull(req.params.id);
  const v = statusBody(req.body);
  if (!v.name) return fail(res, 'required');
  if (statusNameTaken(req.cid, v.name, id)) return fail(res, 'status_exists', 409);
  const x = db.prepare('UPDATE cw_customer_statuses SET name=?, color=? WHERE id=? AND company_id=?').run(v.name, v.color, id, req.cid);
  if (!x.changes) return fail(res, 'not_found', 404);
  res.json({ ok: true });
});
// Deleting a status keeps the clients: they simply have no status afterwards.
r.delete('/statuses/:id', perm('settings.manage'), (req, res) => {
  const id = idOrNull(req.params.id);
  const x = db.transaction(() => {
    db.prepare('UPDATE cw_customers SET status_id = NULL WHERE status_id = ? AND company_id = ?').run(id, req.cid);
    return db.prepare('DELETE FROM cw_customer_statuses WHERE id=? AND company_id=?').run(id, req.cid);
  })();
  if (!x.changes) return fail(res, 'not_found', 404);
  res.json({ ok: true });
});

// =====================================================================
// customers & cars
// =====================================================================
r.get('/customers', perm('customers.view'), (req, res) => {
  const q = str(req.query.q, 100);
  const params = [req.cid, req.cid];
  let where = '';
  if (req.query.status === 'none') where += ' AND c.status_id IS NULL';
  else if (idOrNull(req.query.status)) { where += ' AND c.status_id = ?'; params.push(idOrNull(req.query.status)); }
  if (q) {
    const like = likeEsc(q);
    const plateLike = likeEsc(U.normPlate(q) || q);
    const digits = q.replace(/\D/g, '');
    const phoneLike = digits.length >= 3 ? likeEsc(digits) : like;
    where += ` AND (c.name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\' OR c.whatsapp LIKE ? ESCAPE '\\' OR c.instagram LIKE ? ESCAPE '\\'
              OR EXISTS (SELECT 1 FROM cw_cars k WHERE k.customer_id=c.id AND (k.plate LIKE ? ESCAPE '\\' OR k.make LIKE ? ESCAPE '\\' OR k.model LIKE ? ESCAPE '\\')))`;
    params.push(like, phoneLike, phoneLike, like, plateLike, like, like);
  }
  const rows = db.prepare(CUSTOMER_STATS + where + ' ORDER BY c.id DESC LIMIT 300').all(...params);
  res.json(rows.map(withAvg));
});

r.get('/customers/:id', perm('customers.view'), (req, res) => {
  const id = idOrNull(req.params.id);
  const { s } = ctx(req);
  const row = db.prepare(CUSTOMER_STATS + ' AND c.id = ?').get(req.cid, req.cid, id);
  if (!row) return fail(res, 'not_found', 404);
  const cars = db.prepare('SELECT * FROM cw_cars WHERE customer_id=? AND company_id=? ORDER BY id').all(id, req.cid)
    .map((k) => ({ ...k, loyalty: loyaltyFor(req.cid, k.id, s) }));
  const visits = attachServices(db.prepare(VISIT_SQL + ' AND v.customer_id = ? ORDER BY v.scheduled_start DESC, v.id DESC LIMIT 100').all(req.cid, id));
  const followups = db.prepare("SELECT * FROM cw_followups WHERE company_id=? AND customer_id=? AND status='open' ORDER BY id DESC").all(req.cid, id);
  const complaints = db.prepare('SELECT * FROM cw_complaints WHERE company_id=? AND customer_id=? ORDER BY id DESC LIMIT 50').all(req.cid, id);
  res.json({ customer: withAvg(row), cars, visits, followups, complaints });
});

r.post('/customers', perm('customers.edit'), (req, res) => {
  const b = req.body || {};
  const c = customerBody(b, can(req, 'customers.discount'));
  const statusId = idOrNull(b.status_id);
  if (!belongs('cw_customer_statuses', statusId, req.cid)) return fail(res, 'bad_reference');
  if (!c.name) return fail(res, 'required');
  const { now } = ctx(req);
  const cars = Array.isArray(b.cars) ? b.cars.filter((k) => U.normPlate(k?.plate)) : [];
  for (const k of cars) {
    const ex = db.prepare('SELECT customer_id FROM cw_cars WHERE company_id=? AND plate=?').get(req.cid, U.normPlate(k.plate));
    if (ex) return res.status(409).json({ error: 'plate_taken', customer_id: ex.customer_id });
  }
  const id = db.transaction(() => {
    const cid = Number(
      db.prepare('INSERT INTO cw_customers (company_id, name, phone, whatsapp, instagram, preferences, notes, source, discount_percent, marketing_opt_out, status_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(req.cid, c.name, c.phone, c.whatsapp, c.instagram, c.preferences, c.notes, c.source, c.discount_percent || 0, c.marketing_opt_out, statusId, req.user.id, now.full).lastInsertRowid
    );
    for (const k of cars) createCar(req.cid, cid, k, now);
    return cid;
  })();
  res.status(201).json({ id });
});

r.put('/customers/:id', perm('customers.edit'), (req, res) => {
  const id = idOrNull(req.params.id);
  const cur = db.prepare('SELECT * FROM cw_customers WHERE id=? AND company_id=?').get(id, req.cid);
  if (!cur) return fail(res, 'not_found', 404);
  const c = customerBody(req.body || {}, can(req, 'customers.discount'));
  const statusId = req.body.status_id !== undefined ? idOrNull(req.body.status_id) : cur.status_id;
  if (!belongs('cw_customer_statuses', statusId, req.cid)) return fail(res, 'bad_reference');
  if (!c.name) return fail(res, 'required');
  const discount = c.discount_percent !== undefined ? c.discount_percent : cur.discount_percent;
  db.prepare('UPDATE cw_customers SET name=?, phone=?, whatsapp=?, instagram=?, preferences=?, notes=?, source=?, discount_percent=?, marketing_opt_out=?, status_id=? WHERE id=? AND company_id=?')
    .run(c.name, c.phone, c.whatsapp, c.instagram, c.preferences, c.notes, c.source, discount, c.marketing_opt_out, statusId, id, req.cid);
  res.json({ ok: true });
});

r.delete('/customers/:id', perm('customers.delete'), (req, res) => {
  const x = db.prepare('DELETE FROM cw_customers WHERE id=? AND company_id=?').run(idOrNull(req.params.id), req.cid);
  if (!x.changes) return fail(res, 'not_found', 404);
  res.json({ ok: true });
});

r.post('/customers/:id/cars', perm('customers.edit'), (req, res) => {
  const id = idOrNull(req.params.id);
  if (!db.prepare('SELECT 1 FROM cw_customers WHERE id=? AND company_id=?').get(id, req.cid)) return fail(res, 'not_found', 404);
  const out = createCar(req.cid, id, req.body || {}, ctx(req).now);
  if (out.error === 'plate_taken') return res.status(409).json({ error: 'plate_taken', customer_id: out.customer_id });
  if (out.error) return fail(res, out.error);
  res.status(201).json({ id: out.id });
});
r.put('/cars/:id', perm('customers.edit'), (req, res) => {
  const id = idOrNull(req.params.id);
  const car = db.prepare('SELECT * FROM cw_cars WHERE id=? AND company_id=?').get(id, req.cid);
  if (!car) return fail(res, 'not_found', 404);
  const plate = U.normPlate(req.body.plate);
  if (!plate) return fail(res, 'plate_required');
  const dup = db.prepare('SELECT id FROM cw_cars WHERE company_id=? AND plate=? AND id != ?').get(req.cid, plate, id);
  if (dup) return fail(res, 'plate_taken', 409);
  db.prepare('UPDATE cw_cars SET plate=?, make=?, model=? WHERE id=?').run(plate, str(req.body.make, 60), str(req.body.model, 60), id);
  res.json({ ok: true });
});
r.delete('/cars/:id', perm('customers.delete'), (req, res) => {
  const x = db.prepare('DELETE FROM cw_cars WHERE id=? AND company_id=?').run(idOrNull(req.params.id), req.cid);
  if (!x.changes) return fail(res, 'not_found', 404);
  res.json({ ok: true });
});

// Quick lookup by plate while a customer is at the desk.
r.get('/cars/lookup', perm('customers.view', 'visits.create'), (req, res) => {
  const plate = U.normPlate(req.query.plate);
  if (!plate) return res.json({ found: false });
  const { s } = ctx(req);
  const car = db.prepare('SELECT * FROM cw_cars WHERE company_id=? AND plate=?').get(req.cid, plate);
  if (!car) return res.json({ found: false });
  const customer = db.prepare(CUSTOMER_STATS + ' AND c.id = ?').get(req.cid, req.cid, car.customer_id);
  res.json({ found: true, car, customer: withAvg(customer), loyalty: loyaltyFor(req.cid, car.id, s) });
});

// =====================================================================
// visits (bookings, walk-ins, queue)
// =====================================================================
r.get('/visits', perm('schedule.view', 'queue.view'), (req, res) => {
  const from = C.dateOrNull(req.query.from) || C.dateOrNull(req.query.date) || ctx(req).now.date;
  const to = C.dateOrNull(req.query.to) || from;
  const rows = db
    .prepare(VISIT_SQL + ' AND substr(v.scheduled_start,1,10) BETWEEN ? AND ? ORDER BY v.scheduled_start, v.id LIMIT 1500')
    .all(req.cid, from, to);
  res.json(attachServices(rows));
});

r.get('/visits/:id', perm('schedule.view', 'queue.view', 'customers.view'), (req, res) => {
  const v = getVisit(req.cid, idOrNull(req.params.id));
  if (!v) return fail(res, 'not_found', 404);
  attachServices([v]);
  const complaints = db.prepare('SELECT * FROM cw_complaints WHERE company_id=? AND visit_id=? ORDER BY id DESC').all(req.cid, v.id);
  res.json({ ...v, complaints, loyalty: loyaltyFor(req.cid, v.car_id, ctx(req).s, v.id) });
});

function resolveServices(cid, body) {
  const ids = C.uniqIds(body.service_ids);
  if (!ids.length) return { error: 'no_services' };
  const list = ids.map((id) => db.prepare('SELECT * FROM cw_services WHERE id=? AND company_id=?').get(id, cid));
  if (list.some((x) => !x)) return { error: 'bad_reference' };
  return { list };
}
const writeServices = (visitId, list) => {
  const ins = db.prepare('INSERT INTO cw_visit_services (visit_id, service_id, name, price, duration_min) VALUES (?,?,?,?,?)');
  for (const sv of list) ins.run(visitId, sv.id, sv.name, sv.price, sv.duration_min);
};

r.post('/visits', perm('visits.create'), (req, res) => {
  const b = req.body || {};
  const { s, now } = ctx(req);
  const isOwner = can(req, 'visits.edit'); // may assign anyone and set discounts
  const kind = b.kind === 'walkin' ? 'walkin' : 'booking';
  const start = kind === 'walkin' ? now.dt : b.scheduled_start;
  if (!U.isValidDT(start)) return fail(res, 'bad_datetime');
  const sv = resolveServices(req.cid, b);
  if (sv.error) return fail(res, sv.error);

  const bayId = idOrNull(b.bay_id);
  if (!belongs('cw_bays', bayId, req.cid)) return fail(res, 'bad_reference');
  let staffId = idOrNull(b.staff_id);
  if (!isOwner) staffId = staffId === req.user.id ? req.user.id : null; // employees may only put themselves
  if (!belongs('users', staffId, req.cid)) return fail(res, 'bad_reference');

  const price = round2(sv.list.reduce((a, x) => a + x.price, 0));
  let duration = sv.list.reduce((a, x) => a + x.duration_min, 0);
  if (b.duration_min !== undefined && Number(b.duration_min) >= 5 && Number(b.duration_min) <= 720) duration = Math.round(Number(b.duration_min));
  if (kind === 'booking') {
    const bad = hoursProblem(s, start, duration);
    if (bad) return res.status(400).json(bad);
  }
  if (!b.force) {
    const clash = bayConflict(req.cid, bayId, start, duration);
    if (clash) return res.status(409).json({ error: 'bay_busy', with: clash.id, at: clash.scheduled_start });
  }

  const result = db.transaction(() => {
    let customerId = idOrNull(b.customer_id);
    let carId = idOrNull(b.car_id);
    if (carId) {
      const car = db.prepare('SELECT * FROM cw_cars WHERE id=? AND company_id=?').get(carId, req.cid);
      if (!car) return { error: 'bad_reference' };
      customerId = car.customer_id;
    } else if (customerId) {
      if (!belongs('cw_customers', customerId, req.cid)) return { error: 'bad_reference' };
    } else if (b.quick && typeof b.quick === 'object') {
      const q = b.quick;
      const plate = U.normPlate(q.plate);
      const name = str(q.name, 150);
      const existing = plate ? db.prepare('SELECT * FROM cw_cars WHERE company_id=? AND plate=?').get(req.cid, plate) : null;
      if (existing) {
        carId = existing.id;
        customerId = existing.customer_id;
      } else if (name || plate) {
        customerId = Number(
          db.prepare('INSERT INTO cw_customers (company_id, name, phone, whatsapp, source, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
            .run(req.cid, name || plate, str(q.phone, 40), str(q.whatsapp, 40), str(q.source, 60), req.user.id, now.full).lastInsertRowid
        );
        if (plate) carId = createCar(req.cid, customerId, q, now).id;
      }
    }
    let discount = 0;
    if (customerId) discount = db.prepare('SELECT discount_percent d FROM cw_customers WHERE id=?').get(customerId).d;
    if (isOwner && b.discount_percent !== undefined && b.discount_percent !== '') discount = Math.min(100, num(b.discount_percent, 101));

    const walkin = kind === 'walkin';
    const status = walkin ? 'arrived' : b.status === 'confirmed' ? 'confirmed' : 'new';
    const final = round2(price * (1 - discount / 100));
    const id = Number(
      db.prepare(
        `INSERT INTO cw_visits (company_id, customer_id, car_id, kind, status, scheduled_start, duration_min, bay_id, staff_id, accepted_by,
           price, discount_percent, final_price, arrived_at, notes, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(req.cid, customerId, carId, kind, status, start, duration, bayId, staffId, walkin ? req.user.id : null,
        price, discount, final, walkin ? now.dt : null, str(b.notes, 2000), req.user.id, now.full).lastInsertRowid
    );
    writeServices(id, sv.list);
    // a booked customer is not "lost": stop win-back reminders for him right away
    if (customerId) settleCustomer(req.cid, customerId, now.full);
    return { id };
  })();
  if (result.error) return fail(res, result.error);
  res.status(201).json({ id: result.id });
});

// Full edit (owner): services, time, bay, staff, price/discount.
r.put('/visits/:id', perm('visits.edit'), (req, res) => {
  const id = idOrNull(req.params.id);
  const v = db.prepare('SELECT * FROM cw_visits WHERE id=? AND company_id=?').get(id, req.cid);
  if (!v) return fail(res, 'not_found', 404);
  const b = req.body || {};
  const { s } = ctx(req);
  const start = b.scheduled_start !== undefined ? b.scheduled_start : v.scheduled_start;
  if (!U.isValidDT(start)) return fail(res, 'bad_datetime');
  const bayId = b.bay_id !== undefined ? idOrNull(b.bay_id) : v.bay_id;
  const staffId = b.staff_id !== undefined ? idOrNull(b.staff_id) : v.staff_id;
  if (!belongs('cw_bays', bayId, req.cid) || !belongs('users', staffId, req.cid)) return fail(res, 'bad_reference');

  let price = v.price;
  let duration = v.duration_min;
  let services = null;
  if (b.service_ids !== undefined) {
    const sv = resolveServices(req.cid, b);
    if (sv.error) return fail(res, sv.error);
    services = sv.list;
    price = round2(sv.list.reduce((a, x) => a + x.price, 0));
    duration = sv.list.reduce((a, x) => a + x.duration_min, 0);
  }
  if (b.duration_min !== undefined && Number(b.duration_min) >= 5 && Number(b.duration_min) <= 720) duration = Math.round(Number(b.duration_min));
  const discount = b.discount_percent !== undefined && b.discount_percent !== '' ? Math.min(100, num(b.discount_percent, 101)) : v.discount_percent;
  // only when the time or length really changes, so that old visits stay editable
  if (v.kind === 'booking' && !FINISHED.includes(v.status) && (start !== v.scheduled_start || duration !== v.duration_min)) {
    const bad = hoursProblem(s, start, duration);
    if (bad) return res.status(400).json(bad);
  }
  if (!b.force && !FINISHED.includes(v.status)) {
    const clash = bayConflict(req.cid, bayId, start, duration, id);
    if (clash) return res.status(409).json({ error: 'bay_busy', with: clash.id, at: clash.scheduled_start });
  }
  db.transaction(() => {
    if (services) {
      db.prepare('DELETE FROM cw_visit_services WHERE visit_id=?').run(id);
      writeServices(id, services);
    }
    const next = { ...v, price, discount_percent: discount };
    const p = priceFor(next, s);
    db.prepare('UPDATE cw_visits SET scheduled_start=?, duration_min=?, bay_id=?, staff_id=?, price=?, discount_percent=?, final_price=?, is_free=?, notes=? WHERE id=?')
      .run(start, duration, bayId, staffId, price, discount, p.final_price, p.is_free, b.notes !== undefined ? str(b.notes, 2000) : v.notes, id);
  })();
  res.json({ ok: true });
});

r.patch('/visits/:id/notes', perm('visits.work', 'visits.edit'), (req, res) => {
  const x = db.prepare('UPDATE cw_visits SET notes=? WHERE id=? AND company_id=?').run(str(req.body.notes, 2000), idOrNull(req.params.id), req.cid);
  if (!x.changes) return fail(res, 'not_found', 404);
  res.json({ ok: true });
});

r.delete('/visits/:id', perm('visits.delete'), (req, res) => {
  const x = db.prepare('DELETE FROM cw_visits WHERE id=? AND company_id=?').run(idOrNull(req.params.id), req.cid);
  if (!x.changes) return fail(res, 'not_found', 404);
  res.json({ ok: true });
});

// Status workflow. Start/finish times are recorded automatically.
r.patch('/visits/:id/status', perm('visits.work', 'visits.edit'), (req, res) => {
  const id = idOrNull(req.params.id);
  const status = req.body.status;
  if (!STATUSES.includes(status)) return fail(res, 'bad_status');
  const v = db.prepare('SELECT * FROM cw_visits WHERE id=? AND company_id=?').get(id, req.cid);
  if (!v) return fail(res, 'not_found', 404);
  if (FINISHED.includes(v.status) && !can(req, 'visits.edit')) return fail(res, 'forbidden', 403);
  const { s, now } = ctx(req);
  const t = now.dt;
  const nv = { ...v, status };
  const bayId = req.body.bay_id !== undefined ? idOrNull(req.body.bay_id) : v.bay_id;
  if (!belongs('cw_bays', bayId, req.cid)) return fail(res, 'bad_reference');
  nv.bay_id = bayId;

  if (status === 'arrived' || status === 'in_progress' || status === 'done') {
    nv.arrived_at = v.arrived_at || t;
    nv.accepted_by = v.accepted_by || req.user.id;
  }
  if (status === 'in_progress' || status === 'done') {
    nv.started_at = v.started_at || t;
    nv.staff_id = v.staff_id || req.user.id;
  }
  if (status === 'done') nv.finished_at = t;
  else nv.finished_at = null;
  if (status === 'new' || status === 'confirmed' || status === 'arrived') { nv.started_at = null; }
  if (status === 'new' || status === 'confirmed') nv.arrived_at = null;
  if (status === 'in_progress' && v.status === 'done') nv.finished_at = null;

  const p = priceFor(nv, s);
  nv.final_price = p.final_price;
  nv.is_free = p.is_free;

  db.transaction(() => {
    db.prepare(
      `UPDATE cw_visits SET status=?, bay_id=?, arrived_at=?, started_at=?, finished_at=?, staff_id=?, accepted_by=?, final_price=?, is_free=? WHERE id=?`
    ).run(nv.status, nv.bay_id, nv.arrived_at, nv.started_at, nv.finished_at, nv.staff_id, nv.accepted_by, nv.final_price, nv.is_free, id);

    if (status === 'done' && v.status !== 'done' && v.customer_id) {
      // the customer is back: close open win-back tasks and unsent win-back messages
      settleCustomer(req.cid, v.customer_id, now.full);
      // ask for a review
      if (s.retention.review.enabled && !v.is_rework) {
        const customer = db.prepare('SELECT * FROM cw_customers WHERE id=?').get(v.customer_id);
        M.enqueue({
          cid: req.cid, customer, visitId: id, kind: 'review', vars: { link: s.retention.review.link },
          sendAfter: new Date(Date.now() + s.retention.review.delay_min * 60000).toISOString(), dedupeKey: `review:${id}`,
        });
      }
    }
  })();
  res.json({ ok: true, final_price: nv.final_price, is_free: !!nv.is_free });
});

// Staff can put themselves on a visit; the owner can assign anyone.
r.patch('/visits/:id/assign', perm('visits.work', 'visits.edit'), (req, res) => {
  const id = idOrNull(req.params.id);
  const v = db.prepare('SELECT * FROM cw_visits WHERE id=? AND company_id=?').get(id, req.cid);
  if (!v) return fail(res, 'not_found', 404);
  let staffId = idOrNull(req.body.staff_id);
  if (!can(req, 'visits.edit')) {
    if (staffId && staffId !== req.user.id) return fail(res, 'forbidden', 403);
    if (!staffId && v.staff_id && v.staff_id !== req.user.id) return fail(res, 'forbidden', 403);
  }
  if (!belongs('users', staffId, req.cid)) return fail(res, 'bad_reference');
  db.prepare('UPDATE cw_visits SET staff_id=? WHERE id=?').run(staffId, id);
  res.json({ ok: true });
});

// Reschedule a booking and (optionally) tell the customer.
r.patch('/visits/:id/reschedule', perm('visits.work', 'visits.edit'), (req, res) => {
  const id = idOrNull(req.params.id);
  const v = db.prepare('SELECT * FROM cw_visits WHERE id=? AND company_id=?').get(id, req.cid);
  if (!v) return fail(res, 'not_found', 404);
  if (FINISHED.includes(v.status)) return fail(res, 'visit_closed');
  const b = req.body || {};
  if (!U.isValidDT(b.scheduled_start)) return fail(res, 'bad_datetime');
  const bayId = b.bay_id !== undefined ? idOrNull(b.bay_id) : v.bay_id;
  if (!belongs('cw_bays', bayId, req.cid)) return fail(res, 'bad_reference');
  if (v.kind === 'booking') {
    const bad = hoursProblem(ctx(req).s, b.scheduled_start, v.duration_min);
    if (bad) return res.status(400).json(bad);
  }
  if (!b.force) {
    const clash = bayConflict(req.cid, bayId, b.scheduled_start, v.duration_min, id);
    if (clash) return res.status(409).json({ error: 'bay_busy', with: clash.id, at: clash.scheduled_start });
  }
  db.prepare('UPDATE cw_visits SET scheduled_start=?, bay_id=?, delay_minutes=0 WHERE id=?').run(b.scheduled_start, bayId, id);
  let notified = false;
  if (b.notify !== false && v.customer_id) {
    const customer = db.prepare('SELECT * FROM cw_customers WHERE id=?').get(v.customer_id);
    notified = !!M.enqueue({ cid: req.cid, customer, visitId: id, kind: 'reschedule', vars: { when: U.fmtHuman(b.scheduled_start) } });
  }
  res.json({ ok: true, notified });
});

// Report a delay and (optionally) tell the customer.
r.post('/visits/:id/delay', perm('visits.work', 'visits.edit'), (req, res) => {
  const id = idOrNull(req.params.id);
  const v = db.prepare('SELECT * FROM cw_visits WHERE id=? AND company_id=?').get(id, req.cid);
  if (!v) return fail(res, 'not_found', 404);
  if (FINISHED.includes(v.status)) return fail(res, 'visit_closed');
  const minutes = Math.round(Number(req.body.minutes));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 600) return fail(res, 'bad_minutes');
  db.prepare('UPDATE cw_visits SET delay_minutes=? WHERE id=?').run(minutes, id);
  let notified = false;
  if (req.body.notify !== false && v.customer_id) {
    const customer = db.prepare('SELECT * FROM cw_customers WHERE id=?').get(v.customer_id);
    notified = !!M.enqueue({ cid: req.cid, customer, visitId: id, kind: 'delay', vars: { minutes } });
  }
  res.json({ ok: true, notified });
});

// Live queue: who is waiting, who is being served, who is expected.
r.get('/queue', perm('queue.view', 'schedule.view'), (req, res) => {
  const { now } = ctx(req);
  const rows = attachServices(
    db.prepare(
      VISIT_SQL +
        ` AND ((substr(v.scheduled_start,1,10) = ? AND v.status IN ('new','confirmed','arrived','in_progress'))
              OR (substr(v.scheduled_start,1,10) < ? AND v.status IN ('arrived','in_progress')))
          ORDER BY v.scheduled_start, v.id`
    ).all(req.cid, now.date, now.date)
  );
  const inProgress = rows.filter((v) => v.status === 'in_progress');
  const waiting = rows.filter((v) => v.status === 'arrived').sort((a, b) => (a.arrived_at || a.scheduled_start).localeCompare(b.arrived_at || b.scheduled_start));
  const upcoming = rows.filter((v) => v.status === 'new' || v.status === 'confirmed').map((v) => ({ ...v, minutes_late: Math.max(0, U.minutesBetween(v.scheduled_start, now.dt)) }));

  const nBays = Math.max(1, db.prepare('SELECT COUNT(*) n FROM cw_bays WHERE company_id=? AND active=1').get(req.cid).n);
  const free = inProgress.map((v) => Math.max(0, v.duration_min + (v.delay_minutes || 0) - U.minutesBetween(v.started_at || v.scheduled_start, now.dt)));
  while (free.length < nBays) free.push(0);
  free.sort((a, b) => a - b);
  const slots = free.slice(0, Math.max(nBays, 1));
  for (const w of waiting) {
    slots.sort((a, b) => a - b);
    w.est_wait_min = slots[0];
    w.waited_min = U.minutesBetween(w.arrived_at || w.scheduled_start, now.dt);
    slots[0] += w.duration_min;
  }
  for (const v of inProgress) v.elapsed_min = U.minutesBetween(v.started_at || v.scheduled_start, now.dt);
  res.json({ now: now.dt, waiting, in_progress: inProgress, upcoming });
});

// Complaint / redo of a finished job.
r.post('/visits/:id/rework', perm('visits.work', 'visits.edit'), (req, res) => {
  const id = idOrNull(req.params.id);
  const v = db.prepare('SELECT * FROM cw_visits WHERE id=? AND company_id=?').get(id, req.cid);
  if (!v) return fail(res, 'not_found', 404);
  if (v.status !== 'done') return fail(res, 'visit_not_done');
  const { now } = ctx(req);
  const lines = db.prepare('SELECT * FROM cw_visit_services WHERE visit_id=?').all(id);
  const bayId = req.body.bay_id !== undefined ? idOrNull(req.body.bay_id) : v.bay_id;
  if (!belongs('cw_bays', bayId, req.cid)) return fail(res, 'bad_reference');
  const start = U.isValidDT(req.body.scheduled_start) ? req.body.scheduled_start : now.dt;
  const newId = db.transaction(() => {
    const nid = Number(
      db.prepare(
        `INSERT INTO cw_visits (company_id, customer_id, car_id, kind, status, scheduled_start, duration_min, bay_id, staff_id,
           price, discount_percent, final_price, is_rework, rework_of, notes, created_by, created_at)
         VALUES (?,?,?,'booking','confirmed',?,?,?,?,0,0,0,1,?,?,?,?)`
      ).run(req.cid, v.customer_id, v.car_id, start, v.duration_min, bayId, v.staff_id, id, str(req.body.text, 500), req.user.id, now.full).lastInsertRowid
    );
    const ins = db.prepare('INSERT INTO cw_visit_services (visit_id, service_id, name, price, duration_min) VALUES (?,?,?,0,?)');
    for (const l of lines) ins.run(nid, l.service_id, l.name, l.duration_min);
    db.prepare("INSERT INTO cw_complaints (company_id, visit_id, customer_id, staff_id, type, text, created_by, created_at) VALUES (?,?,?,?,'rework',?,?,?)")
      .run(req.cid, id, v.customer_id, v.staff_id, str(req.body.text, 1000), req.user.id, now.full);
    return nid;
  })();
  res.status(201).json({ id: newId });
});

// =====================================================================
// complaints
// =====================================================================
r.get('/complaints', perm('staff.view'), (req, res) => {
  const open = req.query.status !== 'all';
  const rows = db
    .prepare(
      `SELECT q.*, c.name AS customer_name, u.name AS staff_name, k.plate, v.scheduled_start AS visit_date
       FROM cw_complaints q
       LEFT JOIN cw_customers c ON c.id = q.customer_id
       LEFT JOIN users u ON u.id = q.staff_id
       LEFT JOIN cw_visits v ON v.id = q.visit_id
       LEFT JOIN cw_cars k ON k.id = v.car_id
       WHERE q.company_id = ? ${open ? 'AND q.resolved = 0' : ''} ORDER BY q.id DESC LIMIT 300`
    )
    .all(req.cid);
  res.json(rows);
});
r.post('/complaints', perm('visits.work', 'visits.edit'), (req, res) => {
  const b = req.body || {};
  const { now } = ctx(req);
  let visitId = idOrNull(b.visit_id);
  let customerId = idOrNull(b.customer_id);
  let staffId = idOrNull(b.staff_id);
  if (visitId) {
    const v = db.prepare('SELECT * FROM cw_visits WHERE id=? AND company_id=?').get(visitId, req.cid);
    if (!v) return fail(res, 'bad_reference');
    customerId = customerId || v.customer_id;
    staffId = staffId || v.staff_id;
  }
  if (!belongs('cw_customers', customerId, req.cid) || !belongs('users', staffId, req.cid)) return fail(res, 'bad_reference');
  const text = str(b.text, 1000);
  if (!text) return fail(res, 'required');
  const id = db.prepare("INSERT INTO cw_complaints (company_id, visit_id, customer_id, staff_id, type, text, created_by, created_at) VALUES (?,?,?,?,'complaint',?,?,?)")
    .run(req.cid, visitId, customerId, staffId, text, req.user.id, now.full).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
r.patch('/complaints/:id', perm('complaints.resolve'), (req, res) => {
  const x = db.prepare('UPDATE cw_complaints SET resolved=? WHERE id=? AND company_id=?').run(req.body.resolved === false ? 0 : 1, idOrNull(req.params.id), req.cid);
  if (!x.changes) return fail(res, 'not_found', 404);
  res.json({ ok: true });
});

r.delete('/complaints/:id', perm('visits.delete'), (req, res) => {
  const x = db.prepare('DELETE FROM cw_complaints WHERE id=? AND company_id=?').run(idOrNull(req.params.id), req.cid);
  if (!x.changes) return fail(res, 'not_found', 404);
  res.json({ ok: true });
});

// =====================================================================
// follow-ups (win-back) and messages
// =====================================================================
// Detection also runs when somebody opens the list (at most once a minute per company), so the list
// never depends on the background timer alone.
const lastDetect = new Map();
function detectNow(cid) {
  if (Date.now() - (lastDetect.get(cid) || 0) < 60000) return;
  lastDetect.set(cid, Date.now());
  try { runRetention(cid); } catch (e) { console.error('retention failed for company', cid, e.message); }
}
r.get('/followups', perm('followups.view'), (req, res) => {
  if (!req.impersonation) detectNow(req.cid); // an inspecting admin must not cause any writes
  const { s, now } = ctx(req);
  const rows = db.prepare("SELECT * FROM cw_followups WHERE company_id=? AND status='open' ORDER BY due_date, id LIMIT 300").all(req.cid);
  const out = rows.map((f) => {
    const customer = db.prepare('SELECT * FROM cw_customers WHERE id=?').get(f.customer_id);
    const last = db
      .prepare(
        `SELECT v.car_id, ${VISIT_DATE} AS d FROM cw_visits v WHERE v.company_id=? AND v.customer_id=? AND v.status='done' AND v.is_rework=0 ORDER BY d DESC, v.id DESC LIMIT 1`
      )
      .get(req.cid, f.customer_id);
    const car = db.prepare('SELECT * FROM cw_cars WHERE id=?').get(last?.car_id || 0) || db.prepare('SELECT * FROM cw_cars WHERE customer_id=? ORDER BY id LIMIT 1').get(f.customer_id);
    const kind = f.kind === 'offer' ? 'offer' : 'reminder';
    const vars = { name: customer.name, car: M.carLabel(car), offer: s.retention.offer.text };
    const message = M.messageText(kind, s.language, vars);
    const phone = U.normPhone(customer.whatsapp || customer.phone, s.country_code);
    return {
      id: f.id, kind: f.kind, due_date: f.due_date, due: f.due_date <= now.date, note: f.note,
      customer: { id: customer.id, name: customer.name, phone: customer.phone, whatsapp: customer.whatsapp, opt_out: !!customer.marketing_opt_out },
      last_visit: last?.d || null, days_since: last ? U.diffDays(last.d, now.date) : null,
      car: M.carLabel(car), message, wa_link: waLink(phone, message), has_phone: !!phone,
    };
  });
  res.json(out);
});
r.post('/followups', perm('followups.manage', 'customers.edit'), (req, res) => {
  const customerId = idOrNull(req.body.customer_id);
  if (!customerId || !belongs('cw_customers', customerId, req.cid)) return fail(res, 'bad_reference');
  const { now } = ctx(req);
  const due = C.dateOrNull(req.body.due_date) || now.date;
  const id = db.prepare("INSERT INTO cw_followups (company_id, customer_id, kind, due_date, note, created_at) VALUES (?,?,'manual',?,?,?)")
    .run(req.cid, customerId, due, str(req.body.note, 500), now.full).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
r.patch('/followups/:id', perm('followups.manage'), (req, res) => {
  const status = req.body.status === 'dismissed' ? 'dismissed' : 'done';
  const x = db.prepare("UPDATE cw_followups SET status=?, closed_at=? WHERE id=? AND company_id=? AND status='open'")
    .run(status, ctx(req).now.full, idOrNull(req.params.id), req.cid);
  if (!x.changes) return fail(res, 'not_found', 404);
  res.json({ ok: true });
});

const MSG_STATUSES = ['queued', 'sent', 'failed', 'manual', 'cancelled'];
const getMessage = (req) => db.prepare('SELECT * FROM cw_messages WHERE id=? AND company_id=?').get(idOrNull(req.params.id), req.cid);
r.get('/messages', perm('followups.view'), (req, res) => {
  const status = MSG_STATUSES.includes(req.query.status) ? req.query.status : null;
  const rows = db
    .prepare(
      `SELECT m.*, c.name AS customer_name FROM cw_messages m LEFT JOIN cw_customers c ON c.id = m.customer_id
       WHERE m.company_id = ? ${status ? 'AND m.status = ?' : ''} ORDER BY m.id DESC LIMIT 200`
    )
    .all(...(status ? [req.cid, status] : [req.cid]));
  res.json(rows.map((m) => ({ ...m, edited: !!m.edited, wa_link: waLink(m.phone, m.text) })));
});
// "Sent by hand": the manager opened the chat and wrote to the client.
r.patch('/messages/:id', perm('followups.manage'), (req, res) => {
  const x = db.prepare("UPDATE cw_messages SET status='sent', sent_at=?, wa_message_id=COALESCE(wa_message_id, 'manual'), error=NULL WHERE id=? AND company_id=? AND status IN ('manual','failed','queued')")
    .run(new Date().toISOString(), idOrNull(req.params.id), req.cid);
  if (!x.changes) return fail(res, 'not_found', 404);
  res.json({ ok: true });
});
// Edit the text before sending. A hand-edited message is never sent by the robot (WhatsApp
// templates cannot carry free text), the manager sends it by hand or cancels it.
r.put('/messages/:id', perm('followups.manage'), (req, res) => {
  const m = getMessage(req);
  if (!m) return fail(res, 'not_found', 404);
  if (!['queued', 'manual', 'failed'].includes(m.status)) return fail(res, 'message_closed', 409);
  const text = str(req.body.text, 1000);
  if (!text) return fail(res, 'required');
  db.prepare('UPDATE cw_messages SET text=?, edited=1 WHERE id=?').run(text, m.id);
  res.json({ ok: true });
});
r.post('/messages/:id/cancel', perm('followups.manage'), (req, res) => {
  const x = db.prepare("UPDATE cw_messages SET status='cancelled' WHERE id=? AND company_id=? AND status IN ('queued','manual','failed')")
    .run(idOrNull(req.params.id), req.cid);
  if (!x.changes) return fail(res, 'message_closed', 409);
  res.json({ ok: true });
});

// Run win-back detection and the sending queue right now (owner).
r.post('/retention/run', perm('settings.manage'), async (req, res) => {
  const found = runRetention(req.cid);
  const sent = await M.processQueue();
  res.json({ found, sent });
});

// =====================================================================
// overview (everyone) / analytics, staff, ads (owner)
// =====================================================================
function rangeRevenue(cid, from, to) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(final_price),0) AS revenue, COUNT(CASE WHEN is_rework=0 THEN 1 END) AS cars
       FROM cw_visits v WHERE company_id=? AND status='done' AND ${VISIT_DATE} BETWEEN ? AND ?`
    )
    .get(cid, from, to);
  return { revenue: round2(row.revenue), cars: row.cars };
}

r.get('/overview', perm('schedule.view', 'queue.view'), (req, res) => {
  const { now } = ctx(req);
  const cid = req.cid;
  const byStatus = Object.fromEntries(
    db.prepare("SELECT status, COUNT(*) n FROM cw_visits WHERE company_id=? AND substr(scheduled_start,1,10)=? GROUP BY status").all(cid, now.date).map((x) => [x.status, x.n])
  );
  const nextUp = attachServices(
    db.prepare(VISIT_SQL + " AND v.status IN ('new','confirmed') AND v.scheduled_start >= ? AND substr(v.scheduled_start,1,10) = ? ORDER BY v.scheduled_start LIMIT 6").all(cid, now.dt, now.date)
  );
  const out = {
    now: now.dt, today: now.date,
    today_by_status: byStatus,
    waiting: byStatus.arrived || 0, in_progress: byStatus.in_progress || 0, done_today: byStatus.done || 0,
    followups_due: db.prepare("SELECT COUNT(*) n FROM cw_followups WHERE company_id=? AND status='open' AND due_date<=?").get(cid, now.date).n,
    complaints_open: db.prepare('SELECT COUNT(*) n FROM cw_complaints WHERE company_id=? AND resolved=0').get(cid).n,
    messages_manual: db.prepare("SELECT COUNT(*) n FROM cw_messages WHERE company_id=? AND status='manual'").get(cid).n,
    next_up: nextUp,
  };
  if (can(req, 'analytics.view')) out.revenue_today = rangeRevenue(cid, now.date, now.date).revenue;
  res.json(out);
});

r.get('/ads', perm('analytics.view'), (req, res) => {
  res.json(db.prepare('SELECT * FROM cw_ads WHERE company_id=? ORDER BY date DESC, id DESC LIMIT 300').all(req.cid));
});
r.post('/ads', perm('analytics.view'), (req, res) => {
  const channel = str(req.body.channel, 60);
  if (!channel) return fail(res, 'required');
  const date = C.dateOrNull(req.body.date) || ctx(req).now.date;
  const id = db.prepare('INSERT INTO cw_ads (company_id, date, channel, amount, note) VALUES (?,?,?,?,?)')
    .run(req.cid, date, channel, num(req.body.amount, 1e9), str(req.body.note, 300)).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
r.delete('/ads/:id', perm('analytics.view'), (req, res) => {
  const x = db.prepare('DELETE FROM cw_ads WHERE id=? AND company_id=?').run(idOrNull(req.params.id), req.cid);
  if (!x.changes) return fail(res, 'not_found', 404);
  res.json({ ok: true });
});

function parseRange(req, now) {
  let to = C.dateOrNull(req.query.to) || now.date;
  let from = C.dateOrNull(req.query.from) || now.date.slice(0, 8) + '01';
  if (from > to) [from, to] = [to, from];
  if (U.diffDays(from, to) > 366) from = U.addDays(to, -366);
  return { from, to };
}

function analyticsData(req) {
  const { s, now } = ctx(req);
  const cid = req.cid;
  const { from, to } = parseRange(req, now);
  const days = U.diffDays(from, to) + 1;
  const perDay = Math.max(1, U.hhmmToMin(s.close_time) - U.hhmmToMin(s.open_time));

  const periods = {
    today: rangeRevenue(cid, now.date, now.date),
    week: rangeRevenue(cid, U.weekStart(now.date), now.date),
    month: rangeRevenue(cid, now.date.slice(0, 8) + '01', now.date),
  };
  const range = rangeRevenue(cid, from, to);
  range.avg_check = range.cars ? round2(range.revenue / range.cars) : 0;

  const visits = db
    .prepare(`SELECT v.*, ${VISIT_DATE} AS d FROM cw_visits v WHERE v.company_id=? AND v.status='done' AND ${VISIT_DATE} BETWEEN ? AND ?`)
    .all(cid, from, to);
  const actualMin = (v) => (v.started_at && v.finished_at ? U.minutesBetween(v.started_at, v.finished_at) : v.duration_min);

  // daily series
  const daily = new Map();
  for (let i = 0; i < days; i++) daily.set(U.addDays(from, i), { date: U.addDays(from, i), revenue: 0, cars: 0 });
  for (const v of visits) {
    const d = daily.get(v.d);
    if (!d) continue;
    d.revenue = round2(d.revenue + v.final_price);
    if (!v.is_rework) d.cars++;
  }

  // revenue per service (discounts spread proportionally)
  const lines = db
    .prepare(
      `SELECT sv.name, sv.price AS line_price, v.price AS vprice, v.final_price, v.is_rework
       FROM cw_visit_services sv JOIN cw_visits v ON v.id = sv.visit_id
       WHERE v.company_id=? AND v.status='done' AND ${VISIT_DATE} BETWEEN ? AND ?`
    )
    .all(cid, from, to);
  const bySvc = new Map();
  for (const l of lines) {
    if (l.is_rework) continue;
    const o = bySvc.get(l.name) || { name: l.name, count: 0, revenue: 0 };
    o.count++;
    o.revenue += l.vprice > 0 ? l.line_price * (l.final_price / l.vprice) : 0;
    bySvc.set(l.name, o);
  }
  const byService = [...bySvc.values()].map((o) => ({ ...o, revenue: round2(o.revenue) })).sort((a, b) => b.revenue - a.revenue);

  // load of bays and staff
  const bays = db.prepare('SELECT id, name FROM cw_bays WHERE company_id=? ORDER BY position, id').all(cid).map((b) => {
    const mine = visits.filter((v) => v.bay_id === b.id);
    const busy = mine.reduce((a, v) => a + actualMin(v), 0);
    return { id: b.id, name: b.name, cars: mine.filter((v) => !v.is_rework).length, busy_minutes: busy, utilization: Math.min(1, busy / (perDay * days)) };
  });
  const staff = db.prepare('SELECT id, name FROM users WHERE company_id=? ORDER BY id').all(cid).map((u) => {
    const mine = visits.filter((v) => v.staff_id === u.id);
    const busy = mine.reduce((a, v) => a + actualMin(v), 0);
    return { id: u.id, name: u.name, cars: mine.filter((v) => !v.is_rework).length, revenue: round2(mine.reduce((a, v) => a + v.final_price, 0)), busy_minutes: busy, utilization: Math.min(1, busy / (perDay * days)) };
  });

  // advertising: spend, cost per new customer, payback — per channel
  const key = (x) => String(x || '').trim().toLowerCase();
  const channels = new Map();
  const ch = (name) => {
    const k = key(name) || '—';
    if (!channels.has(k)) channels.set(k, { channel: String(name || '').trim() || '—', spend: 0, new_customers: 0, revenue: 0 });
    return channels.get(k);
  };
  for (const a of db.prepare('SELECT channel, SUM(amount) AS sum FROM cw_ads WHERE company_id=? AND date BETWEEN ? AND ? GROUP BY lower(trim(channel))').all(cid, from, to)) ch(a.channel).spend = a.sum;
  for (const n of db.prepare('SELECT source, COUNT(*) AS n FROM cw_customers WHERE company_id=? AND substr(created_at,1,10) BETWEEN ? AND ? GROUP BY lower(trim(source))').all(cid, from, to)) ch(n.source).new_customers = n.n;
  for (const rv of db.prepare(
    `SELECT c.source AS source, SUM(v.final_price) AS sum FROM cw_visits v JOIN cw_customers c ON c.id = v.customer_id
     WHERE v.company_id=? AND v.status='done' AND ${VISIT_DATE} BETWEEN ? AND ? GROUP BY lower(trim(c.source))`
  ).all(cid, from, to)) ch(rv.source).revenue = rv.sum;
  const adRows = [...channels.values()]
    .filter((x) => x.spend > 0 || x.new_customers > 0)
    .map((x) => ({
      ...x, spend: round2(x.spend), revenue: round2(x.revenue),
      cac: x.spend > 0 && x.new_customers > 0 ? round2(x.spend / x.new_customers) : null,
      roi: x.spend > 0 ? round2((x.revenue - x.spend) / x.spend) : null,
    }))
    .sort((a, b) => b.spend - a.spend);
  const paid = adRows.filter((x) => x.spend > 0);
  const spend = round2(paid.reduce((a, x) => a + x.spend, 0));
  const paidNew = paid.reduce((a, x) => a + x.new_customers, 0);
  const paidRev = round2(paid.reduce((a, x) => a + x.revenue, 0));
  const ads = {
    spend, new_customers: paidNew, revenue: paidRev,
    cac: spend > 0 && paidNew > 0 ? round2(spend / paidNew) : null,
    roi: spend > 0 ? round2((paidRev - spend) / spend) : null,
    channels: adRows,
  };

  return { from, to, days, periods, range, daily: [...daily.values()], by_service: byService, bays, staff, ads };
}
r.get('/analytics', perm('analytics.view'), (req, res) => res.json(analyticsData(req)));

function staffData(req) {
  const { now } = ctx(req);
  const cid = req.cid;
  const { from, to } = parseRange(req, now);
  const users = db.prepare('SELECT id, name, role FROM users WHERE company_id=? ORDER BY id').all(cid);
  const planned = db
    .prepare(`SELECT staff_id, COUNT(*) n FROM cw_visits v WHERE company_id=? AND status != 'cancelled' AND staff_id IS NOT NULL AND substr(scheduled_start,1,10) BETWEEN ? AND ? GROUP BY staff_id`)
    .all(cid, from, to);
  const done = db.prepare(`SELECT v.*, ${VISIT_DATE} AS d FROM cw_visits v WHERE v.company_id=? AND v.status='done' AND ${VISIT_DATE} BETWEEN ? AND ?`).all(cid, from, to);
  const complaints = db.prepare("SELECT staff_id, type, COUNT(*) n FROM cw_complaints WHERE company_id=? AND substr(created_at,1,10) BETWEEN ? AND ? GROUP BY staff_id, type").all(cid, from, to);
  const rows = users.map((u) => {
    const mine = done.filter((v) => v.staff_id === u.id && !v.is_rework);
    const timed = mine.filter((v) => v.started_at && v.finished_at);
    const plannedMin = timed.reduce((a, v) => a + v.duration_min, 0);
    const actualMin = timed.reduce((a, v) => a + U.minutesBetween(v.started_at, v.finished_at), 0);
    const cnt = (type) => complaints.filter((c) => c.staff_id === u.id && c.type === type).reduce((a, c) => a + c.n, 0);
    return {
      id: u.id, name: u.name, role: u.role,
      assigned: planned.find((p) => p.staff_id === u.id)?.n || 0,
      done: mine.length,
      accepted: done.filter((v) => v.accepted_by === u.id && !v.is_rework).length,
      revenue: round2(mine.reduce((a, v) => a + v.final_price, 0)),
      planned_minutes: plannedMin, actual_minutes: actualMin,
      avg_planned: timed.length ? Math.round(plannedMin / timed.length) : null,
      avg_actual: timed.length ? Math.round(actualMin / timed.length) : null,
      efficiency: actualMin > 0 ? round2(plannedMin / actualMin) : null,
      complaints: cnt('complaint'), reworks: cnt('rework'),
    };
  });
  return { from, to, staff: rows };
}
r.get('/staff-stats', perm('staff.view'), (req, res) => res.json(staffData(req)));

// ---- Excel export for a chosen period (same layout as the report sample: 3 sheets) ----
// Each sheet is included only if the user holds the permission for its data.
r.get('/export', perm('analytics.view', 'staff.view'), async (req, res) => {
  try {
    const { now } = ctx(req);
    const range = parseRange(req, now);
    const lang = ['ru', 'kk', 'en'].includes(req.query.lang) ? req.query.lang : 'ru';
    const company = db.prepare('SELECT name, currency FROM companies WHERE id=?').get(req.cid);
    const data = { company, range, lang };
    if (can(req, 'analytics.view')) {
      data.analytics = analyticsData(req);
      data.ads = db.prepare('SELECT date, channel, amount FROM cw_ads WHERE company_id=? AND date BETWEEN ? AND ? ORDER BY date, id').all(req.cid, range.from, range.to);
    }
    if (can(req, 'staff.view')) data.staff = staffData(req).staff;
    const buf = await require('../lib/export').build(data);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="crm-report_${range.from}_${range.to}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error('export failed', e);
    fail(res, 'server_error', 500);
  }
});

module.exports = r;
