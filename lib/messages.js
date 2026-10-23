// Client messaging: message texts, outbox queue and the WhatsApp Cloud API sender.
const { db } = require('../db');
const U = require('./util');

const MARKETING = new Set(['reminder', 'offer', 'review']);
const KINDS = ['reminder', 'offer', 'review', 'reschedule', 'delay'];

const TEXTS = {
  ru: {
    reminder: (v) => `Здравствуйте, ${v.name}! Давно не виделись. Пора освежить ${v.car || 'автомобиль'}? Будем рады видеть вас на мойке!`,
    offer: (v) => `${v.name}, мы скучаем! Специально для вас: ${v.offer}. Ждём вас на мойке!`,
    review: (v) => `${v.name}, спасибо, что выбрали нас! Оцените, пожалуйста, как всё прошло${v.link ? ': ' + v.link : '.'}`,
    reschedule: (v) => `${v.name}, ваша запись перенесена на ${v.when}. Если время не подходит, напишите нам.`,
    delay: (v) => `${v.name}, приносим извинения: ваша очередь немного задерживается (примерно ${v.minutes} мин). Спасибо за ожидание!`,
  },
  kk: {
    reminder: (v) => `Сәлеметсіз бе, ${v.name}! Көптен көрмедік. ${v.car || 'Көлігіңізді'} жаңартатын уақыт болған жоқ па? Сізді жуу орнында қуана күтеміз!`,
    offer: (v) => `${v.name}, сағындық! Дәл сізге арнайы: ${v.offer}. Жуу орнында күтеміз!`,
    review: (v) => `${v.name}, бізді таңдағаныңыз үшін рахмет! Бәрі қалай өткенін бағалаңызшы${v.link ? ': ' + v.link : '.'}`,
    reschedule: (v) => `${v.name}, жазылымыңыз ${v.when} уақытына ауыстырылды. Уақыт сәйкес келмесе, бізге жазыңыз.`,
    delay: (v) => `${v.name}, кешірім сұраймыз: кезегіңіз сәл кешігіп жатыр (шамамен ${v.minutes} мин). Күткеніңіз үшін рахмет!`,
  },
  en: {
    reminder: (v) => `Hi ${v.name}! It's been a while. Time to freshen up ${v.car || 'your car'}? We'd love to see you at the wash!`,
    offer: (v) => `${v.name}, we miss you! Just for you: ${v.offer}. See you soon!`,
    review: (v) => `${v.name}, thanks for choosing us! Please tell us how it went${v.link ? ': ' + v.link : '.'}`,
    reschedule: (v) => `${v.name}, your appointment has been moved to ${v.when}. If this time doesn't suit you, please message us.`,
    delay: (v) => `${v.name}, sorry, your turn is delayed by about ${v.minutes} min. Thank you for waiting!`,
  },
};

// Order of the {{1}}, {{2}} variables in the WhatsApp template body for each message kind.
function templateParams(kind, v) {
  switch (kind) {
    case 'reminder': return [v.name, v.car || '-'];
    case 'offer': return [v.name, v.offer];
    case 'review': return [v.name, v.link || '-'];
    case 'reschedule': return [v.name, v.when];
    case 'delay': return [v.name, String(v.minutes)];
    default: return [];
  }
}
const clean = (x) => String(x ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 500) || '-';

function messageText(kind, lang, vars) {
  const t = (TEXTS[lang] || TEXTS.ru)[kind];
  return t ? t(vars) : '';
}

const carLabel = (car) => (car ? [car.make, car.model, car.plate].filter(Boolean).join(' ') : '');

/**
 * Put a message into the outbox. Returns the new id, or null if skipped
 * (no phone, opted out of marketing, duplicate dedupe key).
 */
function enqueue({ cid, customer, visitId = null, kind, vars = {}, sendAfter = null, dedupeKey = null }) {
  if (!customer || !KINDS.includes(kind)) return null;
  const s = U.getSettings(cid);
  const phone = U.normPhone(customer.whatsapp || customer.phone, s.country_code);
  if (!phone) return null;
  if (customer.marketing_opt_out && MARKETING.has(kind)) return null;
  const v = { name: customer.name || ({ en: 'Hello', kk: 'Сәлеметсіз бе' }[s.language] || 'Здравствуйте'), ...vars };
  const text = messageText(kind, s.language, v);
  const params = templateParams(kind, v).map(clean);
  const r = db
    .prepare('INSERT OR IGNORE INTO cw_messages (company_id, customer_id, visit_id, kind, phone, text, params, send_after, dedupe_key) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(cid, customer.id, visitId, kind, phone, text, JSON.stringify(params), sendAfter, dedupeKey);
  return r.changes ? Number(r.lastInsertRowid) : null;
}

// ---------- WhatsApp Cloud API ----------
async function sendWhatsApp(wa, to, tmpl, params) {
  const base = process.env.WA_API_BASE || 'https://graph.facebook.com/v21.0';
  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: tmpl.name,
      language: { code: tmpl.lang || 'ru' },
      components: params.length ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: clean(p) })) }] : [],
    },
  };
  const r = await fetch(`${base}/${wa.phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${wa.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
  return data?.messages?.[0]?.id || '';
}

let processing = false;
/** Sends queued messages whose time has come. Safe to call often. */
async function processQueue() {
  if (processing) return { sent: 0, failed: 0, manual: 0 };
  processing = true;
  const stats = { sent: 0, failed: 0, manual: 0 };
  try {
    const nowIso = new Date().toISOString();
    const rows = db
      .prepare("SELECT * FROM cw_messages WHERE status = 'queued' AND edited = 0 AND (send_after IS NULL OR send_after <= ?) ORDER BY id LIMIT 50")
      .all(nowIso);
    const Sub = require('./subscription');
    const okCompany = new Map();
    const active = (cid) => { if (!okCompany.has(cid)) okCompany.set(cid, Sub.isActive(cid)); return okCompany.get(cid); };
    for (const m of rows) {
      if (!active(m.company_id)) continue; // suspended / unpaid businesses send nothing; messages wait
      // the manager may have edited or cancelled it a moment ago: never send those
      const cur = db.prepare('SELECT status, edited FROM cw_messages WHERE id = ?').get(m.id);
      if (!cur || cur.status !== 'queued' || cur.edited) continue;
      const s = U.getSettings(m.company_id);
      const wa = s.whatsapp;
      const tmpl = wa.templates?.[m.kind];
      if (!wa.phone_number_id || !wa.access_token || !tmpl?.name) {
        db.prepare("UPDATE cw_messages SET status = 'manual' WHERE id = ? AND status = 'queued'").run(m.id);
        stats.manual++;
        continue;
      }
      if (MARKETING.has(m.kind)) {
        const t = U.localParts(s.timezone).time;
        if (t < s.retention.send_from || t > s.retention.send_to) continue; // wait for working hours
      }
      try {
        const id = await sendWhatsApp(wa, m.phone, tmpl, JSON.parse(m.params || '[]'));
        db.prepare("UPDATE cw_messages SET status = 'sent', sent_at = ?, wa_message_id = ?, error = NULL WHERE id = ? AND status = 'queued'").run(nowIso, id, m.id);
        stats.sent++;
      } catch (e) {
        db.prepare("UPDATE cw_messages SET status = 'failed', error = ? WHERE id = ? AND status = 'queued'").run(String(e.message || e).slice(0, 300), m.id);
        stats.failed++;
      }
    }
  } finally {
    processing = false;
  }
  return stats;
}

module.exports = { MARKETING, KINDS, messageText, templateParams, carLabel, enqueue, processQueue, sendWhatsApp };
