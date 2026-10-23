// Permission catalogue. The owner always has every permission of the company's template;
// employees get exactly the permissions ticked on their position (должность).
// Server routes check these keys (see `perm()` in common.js), the UI only mirrors them.
const GROUPS = {
  general: [
    ['dashboard', ['dashboard.view']],
    ['contacts', ['contacts.view', 'contacts.create', 'contacts.edit', 'contacts.delete']],
    ['deals', ['deals.view', 'deals.create', 'deals.move', 'deals.edit', 'deals.delete']],
    ['tasks', ['tasks.view', 'tasks.create', 'tasks.complete', 'tasks.edit', 'tasks.delete']],
    ['team', ['team.manage']],
  ],
  carwash: [
    ['schedule', ['schedule.view', 'queue.view']],
    ['visits', ['visits.create', 'visits.work', 'visits.edit', 'visits.delete']],
    ['customers', ['customers.view', 'customers.edit', 'customers.delete', 'customers.discount']],
    ['followups', ['followups.view', 'followups.manage']],
    ['reports', ['analytics.view', 'staff.view', 'complaints.resolve']],
    ['admin', ['settings.manage', 'team.manage']],
  ],
};

const CATALOG = Object.fromEntries(
  Object.entries(GROUPS).map(([tpl, groups]) => [tpl, groups.flatMap(([, keys]) => keys)])
);

// A page (module) is available when the user has at least one of its permissions.
const MODULE_PERMS = {
  dashboard: ['dashboard.view'],
  pipeline: ['deals.view'],
  contacts: ['contacts.view'],
  tasks: ['tasks.view'],
  team: ['team.manage'],
  'cw-overview': ['schedule.view', 'queue.view'],
  'cw-schedule': ['schedule.view'],
  'cw-queue': ['queue.view'],
  'cw-customers': ['customers.view'],
  'cw-followups': ['followups.view'],
  'cw-analytics': ['analytics.view'],
  'cw-staff': ['staff.view'],
  'cw-settings': ['settings.manage'],
};

// What the earlier "employee" role could do: used for the default position
// that existing employees are moved to and for sample positions of new companies.
const DEFAULT_EMPLOYEE = {
  general: ['dashboard.view', 'contacts.view', 'contacts.create', 'deals.view', 'deals.create', 'deals.move', 'tasks.view', 'tasks.create', 'tasks.complete'],
  carwash: ['schedule.view', 'queue.view', 'visits.create', 'visits.work', 'customers.view', 'customers.edit', 'followups.view', 'followups.manage'],
};

const SAMPLE_POSITIONS = {
  carwash: {
    ru: [
      ['Сотрудник', DEFAULT_EMPLOYEE.carwash],
      ['Администратор', [...DEFAULT_EMPLOYEE.carwash, 'visits.edit', 'customers.discount', 'complaints.resolve', 'staff.view']],
      ['Мойщик', ['queue.view', 'visits.work']],
    ],
    kk: [
      ['Қызметкер', DEFAULT_EMPLOYEE.carwash],
      ['Әкімші', [...DEFAULT_EMPLOYEE.carwash, 'visits.edit', 'customers.discount', 'complaints.resolve', 'staff.view']],
      ['Жуушы', ['queue.view', 'visits.work']],
    ],
    en: [
      ['Employee', DEFAULT_EMPLOYEE.carwash],
      ['Administrator', [...DEFAULT_EMPLOYEE.carwash, 'visits.edit', 'customers.discount', 'complaints.resolve', 'staff.view']],
      ['Washer', ['queue.view', 'visits.work']],
    ],
  },
  general: {
    ru: [['Сотрудник', DEFAULT_EMPLOYEE.general]],
    kk: [['Қызметкер', DEFAULT_EMPLOYEE.general]],
    en: [['Employee', DEFAULT_EMPLOYEE.general]],
  },
};

const catalogFor = (template) => CATALOG[template] || CATALOG.general;
const cleanPerms = (template, list) => {
  const allowed = new Set(catalogFor(template));
  return [...new Set((Array.isArray(list) ? list : []).filter((k) => typeof k === 'string' && allowed.has(k)))];
};
const modulesFor = (modules, perms) => modules.filter((m) => (MODULE_PERMS[m] || []).some((k) => perms.includes(k)));

module.exports = { GROUPS, CATALOG, MODULE_PERMS, DEFAULT_EMPLOYEE, SAMPLE_POSITIONS, catalogFor, cleanPerms, modulesFor };
