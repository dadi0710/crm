// Subscription terms. paid_until is the LAST day (company-local, inclusive) of access;
// access closes at 00:00 of the next day. NULL means "no limit".
const { db } = require('../db');
const U = require('./util');

const pad = (n) => String(n).padStart(2, '0');
const isDate = (d) => {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(d + 'T00:00:00Z');
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d && +d.slice(0, 4) >= 2000 && +d.slice(0, 4) <= 2100;
};

// 01.01 + 1 month = 01.02; 31.01 + 1 month = 28.02 (clamped to the end of the month)
function addMonths(date, n) {
  const y = +date.slice(0, 4), m = +date.slice(5, 7) - 1, d = +date.slice(8, 10);
  const total = y * 12 + m + n;
  const ny = Math.floor(total / 12), nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, last))}`;
}

function stateOf(company) {
  const tz = U.getSettings(company.id).timezone;
  const today = U.localParts(tz).date;
  if (!company.paid_until) return { unlimited: true, paid_until: null, blocks_on: null, days_left: null, expired: false, today };
  const days_left = U.diffDays(today, company.paid_until);
  return { unlimited: false, paid_until: company.paid_until, blocks_on: U.addDays(company.paid_until, 1), days_left, expired: days_left < 0, today };
}
const isExpired = (company) => stateOf(company).expired;
const isActive = (cid) => {
  const c = db.prepare('SELECT id, suspended, paid_until FROM companies WHERE id = ?').get(cid);
  return !!c && !c.suspended && !isExpired(c);
};

// Works out the new last day for a payment of `months` or `days` (or an explicit end date).
function computeUntil(company, { months, days, from }) {
  const st = stateOf(company);
  const m = Number.isInteger(+months) && +months > 0 ? Math.min(+months, 120) : 0;
  const d = Number.isInteger(+days) && +days > 0 ? Math.min(+days, 3650) : 0;
  if (!m && !d) return null;
  const active = !st.unlimited && !st.expired;
  // extending a running subscription continues from its end; otherwise it starts today (or the chosen date)
  const start = isDate(from) ? from : active ? null : st.today;
  if (start) return { paid_from: start, paid_until: m ? addMonths(start, m) : U.addDays(start, d) };
  return { paid_from: U.addDays(company.paid_until, 1), paid_until: m ? addMonths(company.paid_until, m) : U.addDays(company.paid_until, d) };
}
const periodLabel = ({ months, days }) => (+months > 0 ? `${+months} мес` : `${+days} дн`);

function logEvent(companyId, adminEmail, ev) {
  db.prepare('INSERT INTO subscription_events (company_id, admin_email, kind, period, paid_from, paid_until, amount, note) VALUES (?,?,?,?,?,?,?,?)')
    .run(companyId, adminEmail || null, ev.kind, ev.period ?? null, ev.paid_from ?? null, ev.paid_until ?? null, Number.isFinite(+ev.amount) && ev.amount !== '' && ev.amount !== null ? +ev.amount : null, String(ev.note || '').slice(0, 300));
}

module.exports = { addMonths, stateOf, isExpired, isActive, computeUntil, periodLabel, logEvent, isDate };
