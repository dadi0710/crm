// Team: employees and positions (должности) with owner-chosen permissions. Mounted at /api.
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const C = require('../lib/common');
const P = require('../lib/permissions');

const { fail, str, emailOk, idOrNull, auth, perm } = C;
const r = express.Router();

const tooMuch = (req, perms) => !C.can(req, 'team.manage') || (req.user.role !== 'owner' && perms.some((k) => !req.perms.includes(k)));

r.get('/permissions', auth, perm('team.manage'), (req, res) => {
  res.json({ groups: P.GROUPS[req.template] || P.GROUPS.general, mine: req.perms });
});

// ---- positions ----
const posRow = (p) => ({ id: p.id, name: p.name, permissions: P.cleanPerms(p.template, JSON.parse(p.permissions || '[]')), users: p.users });
r.get('/positions', auth, perm('team.manage'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.*, ? AS template, (SELECT COUNT(*) FROM users u WHERE u.position_id = p.id) AS users
       FROM positions p WHERE p.company_id = ? ORDER BY p.id`
    )
    .all(req.template, req.cid);
  res.json(rows.map(posRow));
});

function positionBody(req) {
  const name = str(req.body?.name, 60);
  const permissions = P.cleanPerms(req.template, req.body?.permissions);
  return { name, permissions };
}
// compared in JS: SQLite's lower() only understands ASCII, not Cyrillic
const nameTaken = (cid, name, exceptId = 0) =>
  db.prepare('SELECT id, name FROM positions WHERE company_id = ?').all(cid).some((x) => x.id !== exceptId && x.name.toLowerCase() === name.toLowerCase());

r.post('/positions', auth, perm('team.manage'), (req, res) => {
  const b = positionBody(req);
  if (!b.name) return fail(res, 'required');
  if (tooMuch(req, b.permissions)) return fail(res, 'forbidden', 403);
  if (nameTaken(req.cid, b.name)) return fail(res, 'position_exists', 409);
  const id = db.prepare('INSERT INTO positions (company_id, name, permissions) VALUES (?,?,?)').run(req.cid, b.name, JSON.stringify(b.permissions)).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});

r.put('/positions/:id', auth, perm('team.manage'), (req, res) => {
  const id = idOrNull(req.params.id);
  const cur = db.prepare('SELECT * FROM positions WHERE id = ? AND company_id = ?').get(id, req.cid);
  if (!cur) return fail(res, 'not_found', 404);
  const b = positionBody(req);
  if (!b.name) return fail(res, 'required');
  // a non-owner may neither grant nor take away rights they do not have themselves
  if (tooMuch(req, [...b.permissions, ...P.cleanPerms(req.template, JSON.parse(cur.permissions || '[]'))])) return fail(res, 'forbidden', 403);
  if (nameTaken(req.cid, b.name, id)) return fail(res, 'position_exists', 409);
  db.prepare('UPDATE positions SET name = ?, permissions = ? WHERE id = ?').run(b.name, JSON.stringify(b.permissions), id);
  res.json({ ok: true });
});

r.delete('/positions/:id', auth, perm('team.manage'), (req, res) => {
  const id = idOrNull(req.params.id);
  const cur = db.prepare('SELECT * FROM positions WHERE id = ? AND company_id = ?').get(id, req.cid);
  if (!cur) return fail(res, 'not_found', 404);
  if (tooMuch(req, P.cleanPerms(req.template, JSON.parse(cur.permissions || '[]')))) return fail(res, 'forbidden', 403);
  if (db.prepare('SELECT 1 FROM users WHERE position_id = ?').get(id)) return fail(res, 'position_in_use', 409);
  db.prepare('DELETE FROM positions WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---- employees ----
r.get('/users', auth, (req, res) => {
  if (!C.can(req, 'team.manage')) {
    // everyone may see names (to assign tasks / visits), nothing else
    return res.json(db.prepare('SELECT id, name FROM users WHERE company_id = ? ORDER BY id').all(req.cid));
  }
  res.json(
    db
      .prepare(
        `SELECT u.id, u.name, u.email, u.role, u.position_id, p.name AS position_name, u.created_at
         FROM users u LEFT JOIN positions p ON p.id = u.position_id WHERE u.company_id = ? ORDER BY u.id`
      )
      .all(req.cid)
  );
});

const positionOk = (cid, id) => id && !!db.prepare('SELECT 1 FROM positions WHERE id = ? AND company_id = ?').get(id, cid);
// a non-owner may only hand out positions whose rights they hold themselves
const positionAllowed = (req, id) => {
  if (req.user.role === 'owner') return true;
  const p = db.prepare('SELECT permissions FROM positions WHERE id = ?').get(id);
  return P.cleanPerms(req.template, JSON.parse(p?.permissions || '[]')).every((k) => req.perms.includes(k));
};

r.post('/users', auth, perm('team.manage'), (req, res) => {
  const name = str(req.body.name, 100);
  const email = str(req.body.email, 200).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const positionId = idOrNull(req.body.position_id);
  if (!name) return fail(res, 'required');
  if (!emailOk(email)) return fail(res, 'bad_email');
  if (password.length < 8 || password.length > 200) return fail(res, 'weak_password');
  if (!positionOk(req.cid, positionId)) return fail(res, 'position_required');
  if (!positionAllowed(req, positionId)) return fail(res, 'forbidden', 403);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return fail(res, 'email_taken', 409);
  const id = db
    .prepare("INSERT INTO users (company_id, name, email, password_hash, role, position_id) VALUES (?, ?, ?, ?, 'employee', ?)")
    .run(req.cid, name, email, bcrypt.hashSync(password, 10), positionId).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});

// change an employee's name, position or password
r.put('/users/:id', auth, perm('team.manage'), (req, res) => {
  const id = idOrNull(req.params.id);
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND company_id = ? AND role = 'employee'").get(id, req.cid);
  if (!u) return fail(res, 'not_found', 404);
  const b = req.body || {};
  const name = b.name !== undefined ? str(b.name, 100) : u.name;
  if (!name) return fail(res, 'required');
  let positionId = u.position_id;
  if (b.position_id !== undefined) {
    positionId = idOrNull(b.position_id);
    if (!positionOk(req.cid, positionId)) return fail(res, 'position_required');
    if (positionId !== u.position_id) {
      if (id === req.user.id) return fail(res, 'cannot_edit_self');
      if (!positionAllowed(req, positionId)) return fail(res, 'forbidden', 403);
    }
  }
  let hash = u.password_hash;
  if (b.password !== undefined && b.password !== '') {
    if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200) return fail(res, 'weak_password');
    hash = bcrypt.hashSync(b.password, 10);
  }
  db.prepare('UPDATE users SET name = ?, position_id = ?, password_hash = ? WHERE id = ?').run(name, positionId, hash, id);
  res.json({ ok: true });
});

r.delete('/users/:id', auth, perm('team.manage'), (req, res) => {
  const id = idOrNull(req.params.id);
  if (id === req.user.id) return fail(res, 'cannot_delete_self');
  const x = db.prepare("DELETE FROM users WHERE id = ? AND company_id = ? AND role = 'employee'").run(id, req.cid);
  if (!x.changes) return fail(res, 'not_found', 404);
  res.json({ ok: true });
});

module.exports = r;
