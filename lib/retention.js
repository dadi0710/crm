// Automatic client win-back: finds customers who stopped coming and creates
// manager follow-ups (and, if enabled, outgoing messages). All thresholds come
// from the company's settings.
const { db } = require('../db');
const U = require('./util');
const M = require('./messages');

const VISIT_DATE = "COALESCE(substr(v.finished_at,1,10), substr(v.scheduled_start,1,10))";

function addFollowup(cid, customerId, kind, due, dedupeKey, now) {
  const r = db
    .prepare('INSERT OR IGNORE INTO cw_followups (company_id, customer_id, kind, due_date, dedupe_key, created_at) VALUES (?,?,?,?,?,?)')
    .run(cid, customerId, kind, due, dedupeKey, now);
  return r.changes > 0;
}

// A customer who is back (finished visit) or has an upcoming visit no longer needs a win-back:
// close his open win-back tasks and cancel win-back messages that have not been sent yet.
function settleCustomer(cid, customerId, nowFull) {
  db.prepare("UPDATE cw_followups SET status='done', closed_at=? WHERE company_id=? AND customer_id=? AND status='open' AND kind IN ('reminder','offer','lost_regular')")
    .run(nowFull, cid, customerId);
  db.prepare("UPDATE cw_messages SET status='cancelled' WHERE company_id=? AND customer_id=? AND kind IN ('reminder','offer') AND status IN ('queued','manual')")
    .run(cid, customerId);
}

function runRetention(cid) {
  const s = U.getSettings(cid);
  const r = s.retention;
  const now = U.localParts(s.timezone);
  const out = { reminders: 0, offers: 0, lostRegular: 0 };
  const anyEnabled = r.reminder.enabled || r.offer.enabled || r.regular.enabled;
  if (!anyEnabled) return out;

  const visits = db
    .prepare(
      `SELECT v.id, v.customer_id, v.car_id, ${VISIT_DATE} AS d
       FROM cw_visits v WHERE v.company_id = ? AND v.status = 'done' AND v.is_rework = 0 AND v.customer_id IS NOT NULL
       ORDER BY v.customer_id, d, v.id`
    )
    .all(cid);
  const byCustomer = new Map();
  for (const v of visits) {
    if (!byCustomer.has(v.customer_id)) byCustomer.set(v.customer_id, []);
    byCustomer.get(v.customer_id).push(v);
  }
  // customers who already have a visit planned or in progress are not "lost"
  const booked = new Set(
    db.prepare(
      "SELECT DISTINCT customer_id FROM cw_visits WHERE company_id = ? AND customer_id IS NOT NULL AND status IN ('new','confirmed','arrived','in_progress') AND substr(scheduled_start,1,10) >= ?"
    ).all(cid, now.date).map((x) => x.customer_id)
  );
  const customers = new Map(db.prepare('SELECT * FROM cw_customers WHERE company_id = ?').all(cid).map((c) => [c.id, c]));
  const cars = new Map(db.prepare('SELECT * FROM cw_cars WHERE company_id = ?').all(cid).map((c) => [c.id, c]));

  for (const [customerId, list] of byCustomer) {
    const customer = customers.get(customerId);
    if (!customer) continue;
    if (booked.has(customerId)) { settleCustomer(cid, customerId, now.full); continue; }
    const last = list[list.length - 1];
    const daysSince = U.diffDays(last.d, now.date);
    if (daysSince < 0) continue;
    const car = M.carLabel(cars.get(last.car_id));
    const optedOut = !!customer.marketing_opt_out;

    // --- 1) "Haven't been for N days": reminder, then personal offer ---
    let stage = null;
    if (r.offer.enabled && daysSince >= r.offer.days) stage = 'offer';
    else if (r.reminder.enabled && daysSince >= r.reminder.days && (!r.offer.enabled || daysSince < r.offer.days)) stage = 'reminder';
    if (stage && !optedOut) {
      const key = `${stage}:${last.id}`;
      if (addFollowup(cid, customerId, stage, now.date, key, now.full)) {
        stage === 'offer' ? out.offers++ : out.reminders++;
        if (r.auto_send) {
          M.enqueue({ cid, customer, kind: stage, vars: { car, offer: r.offer.text }, dedupeKey: key });
        }
      }
    }

    // --- 2) A regular who disappeared: signal to the manager only ---
    if (r.regular.enabled && list.length >= r.regular.min_visits) {
      const recent = list.slice(-6);
      const gaps = [];
      for (let i = 1; i < recent.length; i++) gaps.push(U.diffDays(recent[i - 1].d, recent[i].d));
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const threshold = Math.max(avg * r.regular.miss_factor, avg + 5);
      if (avg > 0 && avg <= r.regular.usual_gap_days && daysSince > threshold && daysSince <= 180) {
        if (addFollowup(cid, customerId, 'lost_regular', now.date, `lost_regular:${last.id}`, now.full)) out.lostRegular++;
      }
    }
  }
  return out;
}

function runRetentionAll() {
  const Sub = require('./subscription');
  // suspended or unpaid businesses get no automatic work
  const ids = db.prepare("SELECT id, paid_until FROM companies WHERE template = 'carwash' AND suspended = 0").all().filter((c) => !Sub.isExpired(c));
  for (const { id } of ids) {
    try { runRetention(id); } catch (e) { console.error('retention failed for company', id, e.message); }
  }
}

module.exports = { runRetention, runRetentionAll, settleCustomer };
