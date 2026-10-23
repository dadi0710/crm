const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.5+, no compilation needed

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'crm.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Small helper so that route code can wrap several writes in one transaction.
db.transaction = (fn) => (...args) => {
  db.exec('BEGIN');
  try {
    const result = fn(...args);
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
};

db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','employee')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  organization TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'open' CHECK (kind IN ('open','won','lost'))
);
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  stage_id INTEGER NOT NULL REFERENCES stages(id),
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  due_date TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id INTEGER REFERENCES deals(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_deals_company ON deals(company_id);
CREATE INDEX IF NOT EXISTS idx_tasks_company ON tasks(company_id);
CREATE INDEX IF NOT EXISTS idx_stages_company ON stages(company_id);
`);

// ---- lightweight migrations for databases created by earlier versions ----
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('companies', 'template', "TEXT NOT NULL DEFAULT 'general'");
addColumn('companies', 'settings', "TEXT NOT NULL DEFAULT '{}'");
addColumn('companies', 'suspended', 'INTEGER NOT NULL DEFAULT 0');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== car wash template =====
CREATE TABLE IF NOT EXISTS cw_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  duration_min INTEGER NOT NULL DEFAULT 30,
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cw_bays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cw_customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  whatsapp TEXT DEFAULT '',
  instagram TEXT DEFAULT '',
  preferences TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  source TEXT DEFAULT '',
  discount_percent REAL NOT NULL DEFAULT 0,
  marketing_opt_out INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cw_cars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES cw_customers(id) ON DELETE CASCADE,
  plate TEXT NOT NULL,
  make TEXT DEFAULT '',
  model TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, plate)
);
CREATE TABLE IF NOT EXISTS cw_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES cw_customers(id) ON DELETE SET NULL,
  car_id INTEGER REFERENCES cw_cars(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'booking' CHECK (kind IN ('booking','walkin')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','confirmed','arrived','in_progress','done','cancelled')),
  scheduled_start TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 30,
  bay_id INTEGER REFERENCES cw_bays(id) ON DELETE SET NULL,
  staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  accepted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  price REAL NOT NULL DEFAULT 0,
  discount_percent REAL NOT NULL DEFAULT 0,
  final_price REAL NOT NULL DEFAULT 0,
  is_free INTEGER NOT NULL DEFAULT 0,
  is_rework INTEGER NOT NULL DEFAULT 0,
  rework_of INTEGER,
  arrived_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cw_visit_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id INTEGER NOT NULL REFERENCES cw_visits(id) ON DELETE CASCADE,
  service_id INTEGER,
  name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  duration_min INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cw_complaints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  visit_id INTEGER REFERENCES cw_visits(id) ON DELETE SET NULL,
  customer_id INTEGER REFERENCES cw_customers(id) ON DELETE SET NULL,
  staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'complaint' CHECK (type IN ('complaint','rework')),
  text TEXT DEFAULT '',
  resolved INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cw_followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES cw_customers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('reminder','offer','lost_regular','manual')),
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
  note TEXT DEFAULT '',
  dedupe_key TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_followup_dedupe ON cw_followups(company_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS cw_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES cw_customers(id) ON DELETE SET NULL,
  visit_id INTEGER REFERENCES cw_visits(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  phone TEXT NOT NULL,
  text TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','manual','cancelled')),
  edited INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  send_after TEXT,
  dedupe_key TEXT,
  wa_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_message_dedupe ON cw_messages(company_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS cw_ads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  channel TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cw_visits_company_start ON cw_visits(company_id, scheduled_start);
CREATE INDEX IF NOT EXISTS idx_cw_visits_customer ON cw_visits(customer_id);
CREATE INDEX IF NOT EXISTS idx_cw_visits_car ON cw_visits(car_id);
CREATE INDEX IF NOT EXISTS idx_cw_customers_company ON cw_customers(company_id);
CREATE INDEX IF NOT EXISTS idx_cw_cars_customer ON cw_cars(customer_id);
CREATE INDEX IF NOT EXISTS idx_cw_messages_status ON cw_messages(status, send_after);
CREATE INDEX IF NOT EXISTS idx_cw_followups_company ON cw_followups(company_id, status);
`);

// ---- positions (roles with owner-chosen permissions) and client statuses ----
db.exec(`
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_positions_company ON positions(company_id);
CREATE TABLE IF NOT EXISTS cw_customer_statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#64748b',
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cw_statuses_company ON cw_customer_statuses(company_id);
`);
addColumn('users', 'position_id', 'INTEGER REFERENCES positions(id) ON DELETE SET NULL');
addColumn('cw_customers', 'status_id', 'INTEGER REFERENCES cw_customer_statuses(id) ON DELETE SET NULL');
addColumn('cw_messages', 'edited', 'INTEGER NOT NULL DEFAULT 0');

// Older databases: the message status check did not know 'cancelled'. SQLite cannot alter a CHECK,
// so the table is rebuilt once (rows and ids are kept).
{
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='cw_messages'").get()?.sql || '';
  if (sql && !sql.includes("'cancelled'")) {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE cw_messages_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
            customer_id INTEGER REFERENCES cw_customers(id) ON DELETE SET NULL,
            visit_id INTEGER REFERENCES cw_visits(id) ON DELETE SET NULL,
            kind TEXT NOT NULL,
            phone TEXT NOT NULL,
            text TEXT NOT NULL,
            params TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','manual','cancelled')),
            edited INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            send_after TEXT,
            dedupe_key TEXT,
            wa_message_id TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            sent_at TEXT
          );
          INSERT INTO cw_messages_new (id, company_id, customer_id, visit_id, kind, phone, text, params, status, edited, error, send_after, dedupe_key, wa_message_id, created_at, sent_at)
            SELECT id, company_id, customer_id, visit_id, kind, phone, text, params, status, edited, error, send_after, dedupe_key, wa_message_id, created_at, sent_at FROM cw_messages;
          DROP TABLE cw_messages;
          ALTER TABLE cw_messages_new RENAME TO cw_messages;
          CREATE UNIQUE INDEX IF NOT EXISTS uq_message_dedupe ON cw_messages(company_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
          CREATE INDEX IF NOT EXISTS idx_cw_messages_status ON cw_messages(status, send_after);
        `);
      })();
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

// Employees created before positions existed get a "Сотрудник" position with the old employee rights.
{
  const { DEFAULT_EMPLOYEE } = require('./lib/permissions');
  const rows = db.prepare(
    `SELECT u.company_id, c.template FROM users u JOIN companies c ON c.id = u.company_id
     WHERE u.role = 'employee' AND u.position_id IS NULL GROUP BY u.company_id`
  ).all();
  for (const { company_id, template } of rows) {
    const perms = DEFAULT_EMPLOYEE[template] || DEFAULT_EMPLOYEE.general;
    const id = Number(db.prepare('INSERT INTO positions (company_id, name, permissions) VALUES (?,?,?)').run(company_id, 'Сотрудник', JSON.stringify(perms)).lastInsertRowid);
    db.prepare("UPDATE users SET position_id = ? WHERE company_id = ? AND role = 'employee' AND position_id IS NULL").run(id, company_id);
  }
}


// ---- subscriptions, audit log ----
// paid_until: last day (company-local, inclusive) the business may use the CRM; NULL = no limit
// (all companies created before subscriptions existed stay unlimited until the admin sets a term).
addColumn('companies', 'paid_until', 'TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS subscription_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  admin_email TEXT,
  kind TEXT NOT NULL,            -- start | extend | set | unlimited
  period TEXT,                   -- human readable, e.g. "1 мес" / "30 дн"
  paid_from TEXT,
  paid_until TEXT,
  amount REAL,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subev_company ON subscription_events(company_id);

-- Append-only event log. Rows are chained by hash and database triggers refuse UPDATE and DELETE,
-- so nothing can be edited or removed quietly (not even by the application itself).
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  company_id INTEGER,
  company_name TEXT,
  actor_type TEXT NOT NULL,      -- user | admin | system
  actor_id INTEGER,
  actor_name TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  entity_label TEXT,
  details TEXT,
  ip TEXT,
  suspicious INTEGER NOT NULL DEFAULT 0,
  suspicious_reason TEXT,
  prev_hash TEXT,
  hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_company ON audit_log(company_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_susp ON audit_log(suspicious, ts);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
`);

const DEFAULT_STAGES = [
  ['new', 'open'],
  ['qualified', 'open'],
  ['proposal', 'open'],
  ['negotiation', 'open'],
  ['won', 'won'],
  ['lost', 'lost'],
];

module.exports = { db, DATA_DIR, DEFAULT_STAGES };
