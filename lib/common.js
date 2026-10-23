// Shared helpers: secrets, input validation, authentication middleware.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { db, DATA_DIR } = require('../db');
const P = require('./permissions');
const Sub = require('./subscription');
const Audit = require('./audit');

const IS_PROD = process.env.NODE_ENV === 'production';

let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  const f = path.join(DATA_DIR, '.secret');
  if (fs.existsSync(f)) SECRET = fs.readFileSync(f, 'utf8');
  else {
    SECRET = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(f, SECRET, { mode: 0o600 });
  }
}
const ADMIN_SECRET = SECRET + ':platform-admin';

// ---- validation helpers ----
const fail = (res, code, status = 400) => res.status(status).json({ error: code });
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v, max = 1e12) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < max ? n : 0;
};
const dateOrNull = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
const idOrNull = (v) => (v !== null && v !== '' && v !== undefined && Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const uniqIds = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map(idOrNull).filter(Boolean))];

// Make sure a referenced row belongs to the same company (tenant isolation).
const belongs = (table, id, cid) =>
  id === null || id === undefined || !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND company_id = ?`).get(id, cid);

// ---- company users ----
function signIn(res, user) {
  const token = jwt.sign({ uid: user.id }, SECRET, { expiresIn: '14d' });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 14 * 24 * 3600 * 1000 });
}

// Platform-admin "sign in as the business": a separate short-lived cookie. "view" mode can only read,
// "act" mode can change data (every change is written to the audit log under the admin's name).
const IMP_COOKIE = 'itoken';
function impersonationSignIn(res, admin, companyId, mode) {
  const token = jwt.sign({ aid: admin.id, cid: companyId, mode }, ADMIN_SECRET, { expiresIn: '2h' });
  res.cookie(IMP_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: IS_PROD, maxAge: 2 * 3600 * 1000 });
}
function readImpersonation(req) {
  const tok = req.cookies?.[IMP_COOKIE];
  if (!tok) return null;
  try {
    const p = jwt.verify(tok, ADMIN_SECRET);
    const admin = db.prepare('SELECT id, email FROM admins WHERE id = ?').get(p.aid);
    if (!admin || !['view', 'act'].includes(p.mode)) return null;
    return { admin_id: admin.id, admin_email: admin.email, company_id: p.cid, mode: p.mode };
  } catch { return null; }
}

function auth(req, res, next) {
  try {
    const imp = readImpersonation(req);
    let uid;
    if (imp) {
      const owner = db.prepare("SELECT id FROM users WHERE company_id = ? AND role = 'owner' ORDER BY id LIMIT 1").get(imp.company_id);
      if (!owner) return fail(res, 'unauthorized', 401);
      uid = owner.id;
    } else {
      uid = jwt.verify(req.cookies.token || '', SECRET).uid;
    }
    const user = db
      .prepare(
        `SELECT u.id, u.company_id, u.name, u.email, u.role, u.position_id, c.suspended, c.template, c.paid_until, c.name AS company_name,
                p.name AS position_name, p.permissions AS position_perms
         FROM users u JOIN companies c ON c.id = u.company_id
         LEFT JOIN positions p ON p.id = u.position_id AND p.company_id = u.company_id
         WHERE u.id = ?`
      )
      .get(uid);
    if (!user) return fail(res, 'unauthorized', 401);
    // an administrator inspecting a business may look at suspended / expired accounts too
    if (!imp) {
      if (user.suspended) return fail(res, 'suspended', 403);
      if (Sub.isExpired({ id: user.company_id, paid_until: user.paid_until })) return fail(res, 'subscription_expired', 403);
    }
    // read-only inspection: nothing may be changed
    if (imp && imp.mode === 'view' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return fail(res, 'read_only_mode', 403);
    // owner: everything the template has; employee: what the position allows (checked on the server for every request)
    let perms;
    if (user.role === 'owner') perms = P.catalogFor(user.template).slice();
    else {
      let stored = [];
      try { stored = JSON.parse(user.position_perms || '[]'); } catch { /* none */ }
      perms = P.cleanPerms(user.template, stored);
    }
    req.user = {
      id: user.id, company_id: user.company_id, name: user.name, email: user.email, role: user.role,
      position_id: user.position_id, position_name: user.position_name || null,
    };
    req.perms = perms;
    req.cid = user.company_id;
    req.template = user.template;
    req.paidUntil = user.paid_until;
    req.impersonation = imp;
    Audit.snapshot(req);
    next();
  } catch {
    fail(res, 'unauthorized', 401);
  }
}
const ownerOnly = (req, res, next) => (req.user.role === 'owner' ? next() : fail(res, 'forbidden', 403));
// perm('a','b') lets a request through when the user has ANY of the listed permissions.
const can = (req, ...keys) => keys.some((k) => req.perms.includes(k));
const perm = (...keys) => (req, res, next) => (can(req, ...keys) ? next() : fail(res, 'forbidden', 403));
const requireTemplate = (name) => (req, res, next) => (req.template === name ? next() : fail(res, 'forbidden', 403));

// ---- platform admin (the person who sells the CRM) ----
function adminSignIn(res, admin) {
  const token = jwt.sign({ aid: admin.id }, ADMIN_SECRET, { expiresIn: '7d' });
  res.cookie('atoken', token, { httpOnly: true, sameSite: 'strict', secure: IS_PROD, maxAge: 7 * 24 * 3600 * 1000 });
}
function adminAuth(req, res, next) {
  try {
    const { aid } = jwt.verify(req.cookies.atoken || '', ADMIN_SECRET);
    const admin = db.prepare('SELECT id, email FROM admins WHERE id = ?').get(aid);
    if (!admin) return fail(res, 'unauthorized', 401);
    req.admin = admin;
    next();
  } catch {
    fail(res, 'unauthorized', 401);
  }
}

module.exports = {
  IS_PROD, fail, str, num, dateOrNull, emailOk, idOrNull, uniqIds, belongs,
  signIn, auth, impersonationSignIn, readImpersonation, IMP_COOKIE, ownerOnly, can, perm, requireTemplate, adminSignIn, adminAuth,
};
