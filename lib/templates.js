// Business templates: which modules a company gets and how a new company is seeded.
const bcrypt = require('bcryptjs');
const { db, DEFAULT_STAGES } = require('../db');
const U = require('./util');
const P = require('./permissions');

const TEMPLATES = {
  general: {
    id: 'general',
    name: 'Универсальная',
    description: 'Клиенты, воронка сделок, задачи, дашборд. Подходит для любого малого бизнеса.',
    modules: ['dashboard', 'pipeline', 'contacts', 'tasks', 'team'],
  },
  carwash: {
    id: 'carwash',
    name: 'Автомойка',
    description: 'Записи по постам, живая очередь, база клиентов и авто, автовозврат клиентов (WhatsApp), лояльность, аналитика, контроль сотрудников. Без воронки сделок.',
    modules: ['cw-overview', 'cw-schedule', 'cw-queue', 'cw-customers', 'cw-followups', 'cw-analytics', 'cw-staff', 'cw-settings', 'team'],
  },
};

const CURRENCIES = ['USD', 'EUR', 'MYR', 'RUB', 'KZT', 'UAH', 'GBP', 'SGD', 'AED', 'TRY'];

const CARWASH_SERVICES = {
  ru: [
    ['Обычная мойка', 30, 30], ['Комплексная мойка', 60, 60], ['Химчистка салона', 240, 180],
    ['Полировка кузова', 300, 180], ['Мойка двигателя', 40, 30],
  ],
  kk: [
    ['Қарапайым жуу', 30, 30], ['Кешенді жуу', 60, 60], ['Салонды химиялық тазалау', 240, 180],
    ['Кузовты жылтырату', 300, 180], ['Қозғалтқышты жуу', 40, 30],
  ],
  en: [
    ['Standard wash', 30, 30], ['Full wash (complex)', 60, 60], ['Interior dry cleaning', 240, 180],
    ['Body polishing', 300, 180], ['Engine wash', 40, 30],
  ],
};

/**
 * Creates a company with an owner account and template-specific starting data.
 * Returns { companyId, userId } or throws Error('email_taken'|...).
 */
function createCompany(o) {
  const template = TEMPLATES[o.template] ? o.template : 'general';
  const currency = CURRENCIES.includes(o.currency) ? o.currency : 'USD';
  const language = ['ru', 'kk', 'en'].includes(o.language) ? o.language : 'ru';
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(o.email)) throw new Error('email_taken');
  const hash = bcrypt.hashSync(o.password, 10);

  return db.transaction(() => {
    const cid = Number(db.prepare('INSERT INTO companies (name, currency, template) VALUES (?, ?, ?)').run(o.companyName, currency, template).lastInsertRowid);
    const uid = Number(
      db.prepare("INSERT INTO users (company_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, 'owner')").run(cid, o.ownerName, o.email, hash).lastInsertRowid
    );
    if (template === 'general') {
      const ins = db.prepare('INSERT INTO stages (company_id, key, position, kind) VALUES (?, ?, ?, ?)');
      DEFAULT_STAGES.forEach(([key, kind], i) => ins.run(cid, key, i, kind));
      // the time zone decides when a subscription day ends
      U.saveSettings(cid, U.deepMerge(JSON.parse(JSON.stringify(U.DEFAULT_SETTINGS)), { language, timezone: o.timezone || U.DEFAULT_SETTINGS.timezone }));
    }
    if (template === 'carwash') {
      const settings = U.deepMerge(JSON.parse(JSON.stringify(U.DEFAULT_SETTINGS)), {
        language,
        timezone: o.timezone || U.DEFAULT_SETTINGS.timezone,
        country_code: String(o.country_code ?? U.DEFAULT_SETTINGS.country_code).replace(/\D/g, ''),
        channels: { en: ['Instagram', 'Google Maps', 'WhatsApp', 'Referral', 'Walk-by'], kk: ['Instagram', 'Google Maps', 'WhatsApp', 'Ұсыныс бойынша', 'Қасынан өтіп бара жатқан'] }[language] || U.DEFAULT_SETTINGS.channels,
        retention: { offer: { text: { en: '15% off your next wash', kk: 'келесі жууға 15% жеңілдік' }[language] || U.DEFAULT_SETTINGS.retention.offer.text } },
      });
      U.saveSettings(cid, settings);
      const sv = db.prepare('INSERT INTO cw_services (company_id, name, price, duration_min, position) VALUES (?, ?, ?, ?, ?)');
      CARWASH_SERVICES[language].forEach(([name, price, dur], i) => sv.run(cid, name, price, dur, i));
      const bay = db.prepare('INSERT INTO cw_bays (company_id, name, position) VALUES (?, ?, ?)');
      [1, 2].forEach((n, i) => bay.run(cid, { en: `Bay ${n}`, kk: `Бекет ${n}`, ru: `Пост ${n}` }[language], i));
    }
    // sample positions (the owner can rename, change or delete them)
    const pos = db.prepare('INSERT INTO positions (company_id, name, permissions) VALUES (?,?,?)');
    for (const [name, perms] of (P.SAMPLE_POSITIONS[template] || P.SAMPLE_POSITIONS.general)[language]) pos.run(cid, name, JSON.stringify(perms));
    if (template === 'carwash') {
      const st = db.prepare('INSERT INTO cw_customer_statuses (company_id, name, color, position) VALUES (?,?,?,?)');
      ({
        en: [['New', '#2563eb'], ['Regular', '#16a34a'], ['VIP', '#d97706']],
        kk: [['Жаңа', '#2563eb'], ['Тұрақты', '#16a34a'], ['VIP', '#d97706']],
        ru: [['Новый', '#2563eb'], ['Постоянный', '#16a34a'], ['VIP', '#d97706']],
      }[language]).forEach(([n, c], i) => st.run(cid, n, c, i));
    }
    return { companyId: cid, userId: uid };
  })();
}

module.exports = { TEMPLATES, CURRENCIES, createCompany };
