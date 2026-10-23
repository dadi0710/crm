// Time, plate/phone normalisation and per-company settings.
const { db } = require('../db');

// ---------- time (company-local, "naive" strings) ----------
function localParts(tz, date = new Date()) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
  } catch {
    return localParts('UTC', date);
  }
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const d = `${p.year}-${p.month}-${p.day}`;
  return { date: d, time: `${p.hour}:${p.minute}`, dt: `${d} ${p.hour}:${p.minute}`, full: `${d} ${p.hour}:${p.minute}:${p.second}` };
}
const parseNaive = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : NaN;
};
const fmtNaive = (ms) => {
  const d = new Date(ms);
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}`;
};
const addMinutes = (dt, n) => fmtNaive(parseNaive(dt) + n * 60000);
const addDays = (date, n) => fmtNaive(parseNaive(date) + n * 86400000).slice(0, 10);
const diffDays = (a, b) => Math.round((parseNaive(b.slice(0, 10)) - parseNaive(a.slice(0, 10))) / 86400000);
const minutesBetween = (a, b) => {
  const n = Math.round((parseNaive(b) - parseNaive(a)) / 60000);
  return Number.isFinite(n) ? Math.max(0, n) : 0; // never NaN: bad dates must not break the queue
};
const weekStart = (date) => {
  const dow = new Date(parseNaive(date)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
};
const hhmmToMin = (s) => {
  const m = /^(\d{2}):(\d{2})$/.exec(s || '');
  return m ? +m[1] * 60 + +m[2] : 0;
};
const isValidDT = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s) && !Number.isNaN(parseNaive(s));
// Working hours: a booking must start after opening, end before closing and stay out of the break.
// Returns an error code or null.
function checkHours(settings, start, durationMin) {
  const open = hhmmToMin(settings.open_time), close = hhmmToMin(settings.close_time);
  const from = hhmmToMin(start.slice(11, 16));
  const to = from + Math.max(0, Number(durationMin) || 0);
  if (from < open) return 'before_open';
  if (to > close) return 'after_close';
  if (settings.break_from && settings.break_to) {
    const bf = hhmmToMin(settings.break_from), bt = hhmmToMin(settings.break_to);
    if (bt > bf && from < bt && to > bf) return 'in_break';
  }
  return null;
}
const fmtHuman = (dt) => `${dt.slice(8, 10)}.${dt.slice(5, 7)} ${dt.slice(11, 16)}`;

// ---------- plates / phones ----------
const normPlate = (p) => String(p || '').toUpperCase().replace(/[\s\-_.]/g, '').slice(0, 15);
function normPhone(phone, countryCode = '') {
  const raw = String(phone || '').trim();
  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (raw.startsWith('+')) return digits;
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('0') && countryCode) return countryCode + digits.slice(1);
  return digits;
}

// ---------- settings ----------
const DEFAULT_SETTINGS = {
  language: 'ru',
  timezone: 'Asia/Kuala_Lumpur',
  country_code: '60',
  open_time: '09:00',
  close_time: '21:00',
  break_from: '',
  break_to: '',
  slot_minutes: 30,
  loyalty: { enabled: true, every: 10 },
  channels: ['Instagram', 'Google Maps', 'WhatsApp', 'Рекомендация', 'Проходил мимо'],
  retention: {
    auto_send: true,
    reminder: { enabled: true, days: 14 },
    offer: { enabled: true, days: 30, text: 'скидка 15% на следующую мойку' },
    regular: { enabled: true, min_visits: 4, usual_gap_days: 10, miss_factor: 2 },
    review: { enabled: true, delay_min: 60, link: '' },
    send_from: '09:00',
    send_to: '20:00',
  },
  // managed by the platform admin only
  whatsapp: { phone_number_id: '', access_token: '', templates: {} },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = isObj(base[k]) && isObj(over[k]) ? deepMerge(base[k], over[k]) : over[k];
  return out;
}

function getSettings(cid) {
  const row = db.prepare('SELECT settings FROM companies WHERE id = ?').get(cid);
  let stored = {};
  try { stored = JSON.parse(row?.settings || '{}'); } catch { /* ignore */ }
  return deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), stored);
}
function saveSettings(cid, settings) {
  db.prepare('UPDATE companies SET settings = ? WHERE id = ?').run(JSON.stringify(settings), cid);
}
// Settings safe to show to company users (no API secrets).
function publicSettings(s) {
  const { whatsapp, ...rest } = s;
  return {
    ...rest,
    whatsapp: {
      configured: !!(whatsapp.phone_number_id && whatsapp.access_token),
      templates: Object.keys(whatsapp.templates || {}).filter((k) => whatsapp.templates[k]?.name),
    },
  };
}
const nowFor = (settings) => localParts(settings.timezone);

module.exports = {
  localParts, parseNaive, fmtNaive, addMinutes, addDays, diffDays, minutesBetween, weekStart, hhmmToMin,
  isValidDT, checkHours, fmtHuman, normPlate, normPhone, DEFAULT_SETTINGS, deepMerge, getSettings, saveSettings,
  publicSettings, nowFor,
};
