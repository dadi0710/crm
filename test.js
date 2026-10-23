// End-to-end API tests. Runs against a temporary database and a fake WhatsApp server.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-'));
const assert = require('assert');

// ---- fake WhatsApp Cloud API ----
const waCalls = [];
const waServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    waCalls.push({ url: req.url, auth: req.headers.authorization, body: json });
    if (json.to === '60111111111') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: '(#131026) Message undeliverable' } }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages: [{ id: 'wamid.TEST' + waCalls.length }] }));
  });
});

waServer.listen(0, '127.0.0.1', () => {
  process.env.WA_API_BASE = `http://127.0.0.1:${waServer.address().port}/v21.0`;
  const app = require('./server');
  const { db } = require('./db');

  const server = app.listen(0, async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const mk = () => {
      const jar = {};
      return async (method, url, body) => {
        const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
        const r = await fetch(base + url, {
          method,
          headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        for (const sc of r.headers.getSetCookie?.() || []) {
          const [pair] = sc.split(';');
          const i = pair.indexOf('=');
          if (/Expires=Thu, 01 Jan 1970/i.test(sc)) delete jar[pair.slice(0, i)];
          else jar[pair.slice(0, i)] = pair.slice(i + 1);
        }
        const text = await r.text();
        let data = {};
        try { data = JSON.parse(text); } catch { data = { _text: text }; }
        return { status: r.status, data };
      };
    };

    let passed = 0;
    const ok = (cond, name) => { assert.ok(cond, name); passed++; console.log('  ok -', name); };
    const section = (s) => console.log('\n' + s);
    const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

    try {
      const Adm = mk(), A = mk(), B = mk(), E = mk(), W = mk(), WE = mk(), W2 = mk(), Anon = mk();

      // =================================================================
      section('Platform admin');
      let r = await Anon('GET', '/api/admin/status');
      ok(r.data.setupRequired === true, 'admin setup required on first run');
      r = await Anon('GET', '/api/admin/companies');
      ok(r.status === 401, 'admin API needs login');
      r = await Adm('POST', '/api/admin/setup', { email: 'boss@x.com', password: 'short' });
      ok(r.status === 400, 'weak admin password rejected');
      r = await Adm('POST', '/api/admin/setup', { email: 'boss@x.com', password: 'very-strong-pass' });
      ok(r.status === 200, 'admin created');
      r = await Anon('POST', '/api/admin/setup', { email: 'evil@x.com', password: 'very-strong-pass' });
      ok(r.status === 403, 'second setup is refused');
      r = await Anon('POST', '/api/admin/login', { email: 'boss@x.com', password: 'wrong-password' });
      ok(r.status === 401, 'wrong admin password -> 401');
      r = await Adm('GET', '/api/admin/templates');
      ok(r.data.templates.some((t) => t.id === 'carwash') && r.data.templates.some((t) => t.id === 'general'), 'templates listed');

      const create = (o) => Adm('POST', '/api/admin/companies', { currency: 'MYR', language: 'ru', timezone: 'Asia/Kuala_Lumpur', country_code: '60', ...o });
      r = await create({ template: 'nope', companyName: 'X', ownerName: 'X', email: 'x@x.com', password: 'secret123' });
      ok(r.status === 400, 'unknown template rejected');
      r = await create({ template: 'general', companyName: 'Acme', ownerName: 'Alice', email: 'alice@a.com', password: 'secret123' });
      ok(r.status === 201, 'create company from "general" template');
      const acmeId = r.data.id;
      r = await create({ template: 'general', companyName: 'Dup', ownerName: 'X', email: 'alice@a.com', password: 'secret123' });
      ok(r.status === 409, 'duplicate owner email rejected');
      r = await create({ template: 'general', companyName: 'Dup', ownerName: 'X', email: 'z@a.com', password: 'short' });
      ok(r.status === 400, 'weak client password rejected');
      r = await create({ template: 'general', companyName: 'Beta', ownerName: 'Bob', email: 'bob@b.com', password: 'secret123' });
      ok(r.status === 201, 'create second general company');
      r = await create({ template: 'carwash', companyName: 'Shine Wash', ownerName: 'Wendy', email: 'wendy@w.com', password: 'secret123' });
      ok(r.status === 201, 'create company from "car wash" template');
      const washId = r.data.id;
      r = await create({ template: 'carwash', companyName: 'Other Wash', ownerName: 'Oscar', email: 'oscar@o.com', password: 'secret123', language: 'en' });
      const wash2Id = r.data.id;
      r = await Adm('GET', '/api/admin/companies');
      ok(r.data.length === 4 && r.data.find((c) => c.id === washId).template === 'carwash', 'admin sees all companies with templates');

      r = await Anon('POST', '/api/auth/register', { companyName: 'Hack', name: 'H', email: 'h@h.com', password: 'secret123' });
      ok(r.status === 403, 'public registration is disabled');

      r = await Anon('GET', '/admin');
      ok(r.status === 200 && /html/i.test(r.data._text || ''), '/admin page is served');
      r = await Anon('GET', '/manifest.webmanifest');
      ok(r.status === 200, 'mobile manifest is served');

      // =================================================================
      section('General template (unchanged behaviour)');
      r = await A('GET', '/api/me');
      ok(r.status === 401, 'unauthenticated /me -> 401');
      r = await A('POST', '/api/auth/login', { email: 'alice@a.com', password: 'secret123' });
      ok(r.status === 200, 'owner login');
      r = await B('POST', '/api/auth/login', { email: 'bob@b.com', password: 'secret123' });
      r = await A('GET', '/api/me');
      ok(r.data.user.role === 'owner' && r.data.company.currency === 'MYR' && r.data.stages.length === 6, 'owner profile + 6 default stages');
      ok(r.data.company.modules.includes('pipeline') && !r.data.company.modules.some((m) => m.startsWith('cw-')), 'general modules include pipeline');
      const stages = r.data.stages;

      r = await A('GET', '/api/positions');
      const genEmp = r.data.find((p) => p.name === 'Сотрудник');
      ok(genEmp && genEmp.permissions.includes('tasks.create'), 'general company starts with a sample position');
      r = await A('POST', '/api/users', { name: 'Eve', email: 'eve@a.com', password: 'secret123' });
      ok(r.status === 400 && r.data.error === 'position_required', 'employee needs a position');
      r = await A('POST', '/api/users', { name: 'Eve', email: 'eve@a.com', password: 'secret123', position_id: genEmp.id });
      ok(r.status === 201, 'owner creates employee');
      const eveId = r.data.id;
      r = await E('POST', '/api/auth/login', { email: 'eve@a.com', password: 'wrong' });
      ok(r.status === 401, 'wrong password -> 401');
      await E('POST', '/api/auth/login', { email: 'eve@a.com', password: 'secret123' });
      r = await E('POST', '/api/users', { name: 'Z', email: 'z@a.com', password: 'secret123' });
      ok(r.status === 403, 'employee cannot add users');
      r = await E('GET', '/api/me');
      ok(!r.data.company.modules.includes('team'), 'employee does not get the team module');

      r = await A('POST', '/api/contacts', { name: 'Client One', email: 'c1@x.com', tags: 'vip, kl' });
      const c1 = r.data.id;
      ok(r.status === 201, 'owner creates contact');
      r = await E('PUT', `/api/contacts/${c1}`, { name: 'Hacked' });
      ok(r.status === 403, 'employee cannot edit contact');
      r = await A('GET', '/api/contacts?q=%25');
      ok(r.data.length === 0, 'search escapes % wildcard');
      r = await B('PUT', `/api/contacts/${c1}`, { name: 'Hacked' });
      ok(r.status === 404, 'company B cannot edit A contact');
      r = await B('POST', '/api/deals', { title: 'Sneaky', contact_id: c1 });
      ok(r.status === 400, 'company B cannot link A contact to deal');

      r = await E('POST', '/api/deals', { title: 'Order #1', amount: 1500, contact_id: c1 });
      const d1 = r.data.id;
      r = await A('POST', '/api/deals', { title: 'Order #2', amount: 500, owner_id: eveId });
      const d2 = r.data.id;
      const won = stages.find((s) => s.kind === 'won'), lost = stages.find((s) => s.kind === 'lost');
      await E('PATCH', `/api/deals/${d1}/stage`, { stage_id: won.id });
      await A('PATCH', `/api/deals/${d2}/stage`, { stage_id: lost.id });
      r = await E('PUT', `/api/deals/${d1}`, { title: 'x' });
      ok(r.status === 403, 'employee cannot edit deal');
      r = await A('GET', `/api/dashboard?today=${new Date().toISOString().slice(0, 10)}`);
      ok(r.data.wonSum === 1500 && r.data.conversion === 0.5, 'dashboard revenue + conversion');
      r = await A('DELETE', `/api/users/${eveId}`);
      r = await E('GET', '/api/me');
      ok(r.status === 401, 'removed employee loses access immediately');

      section('Template isolation');
      r = await A('GET', '/api/cw/bootstrap');
      ok(r.status === 403, 'general company cannot use car wash API');
      r = await W('POST', '/api/auth/login', { email: 'wendy@w.com', password: 'secret123' });
      ok(r.status === 200, 'car wash owner login');
      r = await W('GET', '/api/contacts');
      ok(r.status === 403, 'car wash company cannot use general API');
      r = await W('GET', '/api/deals');
      ok(r.status === 403, 'car wash has no deal pipeline');

      // =================================================================
      section('Car wash: setup and permissions');
      r = await W('GET', '/api/me');
      ok(r.data.company.template === 'carwash' && r.data.company.modules.includes('cw-analytics') && !r.data.company.modules.includes('pipeline'), 'owner sees car wash modules, no pipeline');
      r = await W('GET', '/api/positions');
      const cwEmp = r.data.find((p) => p.name === 'Сотрудник');
      r = await W('POST', '/api/users', { name: 'Sam', email: 'sam@w.com', password: 'secret123', position_id: cwEmp.id });
      const samId = r.data.id;
      r = await W('POST', '/api/users', { name: 'Tom', email: 'tom@w.com', password: 'secret123', position_id: cwEmp.id });
      const tomId = r.data.id;
      await WE('POST', '/api/auth/login', { email: 'sam@w.com', password: 'secret123' });
      r = await WE('GET', '/api/me');
      ok(r.data.company.modules.includes('cw-queue') && !r.data.company.modules.includes('cw-analytics') && !r.data.company.modules.includes('cw-settings'), 'employee: no analytics/settings modules');

      r = await W('GET', '/api/cw/bootstrap');
      const boot = r.data;
      ok(boot.services.length === 5 && boot.bays.length === 2, 'template seeds 5 services and 2 bays');
      const today = boot.today;
      const tomorrow = addDays(today, 1);
      const svc = boot.services.find((s) => s.name === 'Обычная мойка');
      const svcFull = boot.services.find((s) => s.name === 'Комплексная мойка');
      const [bay1, bay2] = boot.bays;
      ok(svc.price === 30 && svc.duration_min === 30, 'default service price/duration');
      ok(!('access_token' in (boot.settings.whatsapp || {})), 'WhatsApp secrets are never sent to the browser');

      r = await WE('POST', '/api/cw/services', { name: 'Hack', price: 1, duration_min: 10 });
      ok(r.status === 403, 'employee cannot edit services');
      r = await W('POST', '/api/cw/services', { name: 'Воск', price: 45, duration_min: 20 });
      ok(r.status === 201, 'owner adds a service');
      const waxId = r.data.id;
      r = await W('PUT', `/api/cw/services/${waxId}`, { name: 'Воск Premium', price: 55, duration_min: 25, active: true });
      ok(r.status === 200, 'owner edits a service');
      r = await W('DELETE', `/api/cw/services/${waxId}`);
      ok(r.status === 200, 'owner deletes a service');
      r = await WE('PUT', '/api/cw/settings', { loyalty: { enabled: true, every: 2 } });
      ok(r.status === 403, 'employee cannot change settings');
      r = await WE('GET', '/api/cw/analytics');
      ok(r.status === 403, 'employee cannot open analytics');
      r = await WE('GET', '/api/cw/staff-stats');
      ok(r.status === 403, 'employee cannot open staff stats');
      r = await WE('POST', '/api/cw/ads', { channel: 'X', amount: 5 });
      ok(r.status === 403, 'employee cannot add ad expenses');

      // =================================================================
      section('Car wash: bookings, bays, queue');
      r = await W('POST', '/api/cw/visits', {
        kind: 'booking', scheduled_start: `${tomorrow} 10:00`, service_ids: [svc.id], bay_id: bay1.id,
        quick: { name: 'Ahmad', phone: '0123456789', plate: 'abc 123', make: 'Toyota', model: 'Vios', source: 'Instagram' },
      });
      ok(r.status === 201, 'owner books a customer (customer + car created on the fly)');
      const v1 = r.data.id;
      r = await W('GET', '/api/cw/cars/lookup?plate=ABC-123');
      ok(r.data.found && r.data.car.plate === 'ABC123' && r.data.customer.name === 'Ahmad', 'plate lookup ignores case, spaces and dashes');
      const ahmadId = r.data.customer.id, ahmadCar = r.data.car.id;
      r = await W('POST', '/api/cw/visits', { kind: 'booking', scheduled_start: `${tomorrow} 10:15`, service_ids: [svc.id], bay_id: bay1.id, quick: { plate: 'ZZZ 999', name: 'Clash' } });
      ok(r.status === 409 && r.data.error === 'bay_busy', 'overlapping booking on the same bay is rejected');
      r = await W('POST', '/api/cw/visits', { kind: 'booking', scheduled_start: `${tomorrow} 10:30`, service_ids: [svc.id], bay_id: bay1.id, quick: { plate: 'ZZZ 999', name: 'Clash' } });
      ok(r.status === 201, 'back-to-back booking is allowed');
      r = await W('POST', '/api/cw/visits', { kind: 'booking', scheduled_start: `${tomorrow} 10:15`, service_ids: [svc.id], bay_id: bay1.id, quick: { plate: 'QQQ 1', name: 'Forced' }, force: true });
      ok(r.status === 201, 'owner can force a booking over a clash');
      r = await W('POST', '/api/cw/visits', { kind: 'booking', scheduled_start: `${tomorrow} 10:00`, service_ids: [svc.id], bay_id: bay2.id, quick: { plate: 'BBB 2', name: 'Other bay' } });
      ok(r.status === 201, 'same time on another bay is fine');
      r = await W('POST', '/api/cw/visits', { kind: 'booking', scheduled_start: 'tomorrow', service_ids: [svc.id] });
      ok(r.status === 400, 'bad date/time rejected');
      r = await W('POST', '/api/cw/visits', { kind: 'booking', scheduled_start: `${tomorrow} 12:00`, service_ids: [] });
      ok(r.status === 400, 'at least one service required');
      r = await W('GET', `/api/cw/visits?date=${tomorrow}`);
      ok(r.data.length === 4 && r.data[0].services.length === 1 && r.data.some((v) => v.plate === 'ABC123'), 'schedule lists the day with services and cars');

      // staff
      r = await WE('POST', '/api/cw/visits', { kind: 'walkin', service_ids: [svc.id], staff_id: tomId, quick: { plate: 'WLK 100', name: 'Walk-in Wei', phone: '0187654321' } });
      ok(r.status === 201, 'employee registers a walk-in');
      const w1 = r.data.id;
      r = await WE('GET', `/api/cw/visits/${w1}`);
      ok(r.data.status === 'arrived' && r.data.kind === 'walkin' && r.data.arrived_at && r.data.accepted_by === samId, 'walk-in is "arrived" and records who accepted the car');
      ok(r.data.staff_id === null, 'employee cannot assign someone else when creating');
      r = await WE('PATCH', `/api/cw/visits/${w1}/assign`, { staff_id: tomId });
      ok(r.status === 403, 'employee cannot assign another employee');
      r = await WE('PATCH', `/api/cw/visits/${w1}/assign`, { staff_id: samId });
      ok(r.status === 200, 'employee can assign himself');
      r = await WE('GET', '/api/cw/queue');
      ok(r.data.waiting.some((v) => v.id === w1) && r.data.upcoming.length === 0, 'walk-in is in the live queue');
      ok(typeof r.data.waiting[0].est_wait_min === 'number', 'queue shows estimated wait');

      r = await WE('PATCH', `/api/cw/visits/${w1}/status`, { status: 'in_progress', bay_id: bay2.id });
      ok(r.status === 200, 'employee starts work');
      r = await WE('GET', `/api/cw/visits/${w1}`);
      ok(r.data.started_at && r.data.staff_id === samId && !r.data.finished_at, 'start time recorded automatically');
      r = await WE('PATCH', `/api/cw/visits/${w1}/status`, { status: 'done' });
      ok(r.status === 200 && r.data.final_price === 30, 'employee finishes work, price calculated');
      r = await WE('GET', `/api/cw/visits/${w1}`);
      ok(r.data.finished_at && r.data.status === 'done', 'finish time recorded automatically');
      r = await WE('PATCH', `/api/cw/visits/${w1}/status`, { status: 'new' });
      ok(r.status === 403, 'employee cannot reopen a finished visit');
      r = await W('PATCH', `/api/cw/visits/${w1}/status`, { status: 'bad' });
      ok(r.status === 400, 'unknown status rejected');
      r = await WE('PUT', `/api/cw/visits/${v1}`, { service_ids: [svc.id] });
      ok(r.status === 403, 'employee cannot fully edit a visit');
      r = await WE('DELETE', `/api/cw/visits/${v1}`);
      ok(r.status === 403, 'employee cannot delete a visit');

      // =================================================================
      section('Car wash: reschedule / delay notifications (no WhatsApp configured yet)');
      r = await W('PATCH', `/api/cw/visits/${v1}/reschedule`, { scheduled_start: `${tomorrow} 14:00`, notify: true });
      ok(r.status === 200 && r.data.notified === true, 'reschedule queues a notification');
      r = await W('POST', `/api/cw/visits/${v1}/delay`, { minutes: 20, notify: true });
      ok(r.status === 200 && r.data.notified === true, 'delay queues a notification');
      r = await W('POST', `/api/cw/visits/${v1}/delay`, { minutes: 0 });
      ok(r.status === 400, 'bad delay rejected');
      r = await W('GET', '/api/cw/messages?status=queued');
      const resch = r.data.find((m) => m.kind === 'reschedule');
      ok(resch && /14:00/.test(resch.text) && resch.phone === '60123456789', 'message has new time and phone in international format');
      r = await W('POST', '/api/cw/retention/run');
      ok(r.status === 200, 'owner triggers the sending queue');
      r = await W('GET', '/api/cw/messages?status=manual');
      ok(r.data.length >= 2 && /wa\.me\/60123456789/.test(r.data[0].wa_link || r.data[1].wa_link), 'without WhatsApp API the message is offered for manual sending');
      const man = r.data[0];
      r = await WE('PATCH', `/api/cw/messages/${man.id}`, {});
      ok(r.status === 200, 'manager marks a manual message as sent');

      // =================================================================
      section('Car wash: loyalty (every Nth wash free) and discounts');
      r = await W('PUT', '/api/cw/settings', { loyalty: { enabled: true, every: 3, max_free_price: 0 }, retention: { send_from: '00:00', send_to: '23:59' } });
      ok(r.status === 200 && r.data.settings.loyalty.every === 3, 'owner configures loyalty');
      const washOnce = async (plate, name, extra = {}) => {
        const c = await WE('POST', '/api/cw/visits', { kind: 'walkin', service_ids: [svc.id], quick: { plate, name, phone: '0191112222', ...extra } });
        await WE('PATCH', `/api/cw/visits/${c.data.id}/status`, { status: 'in_progress' });
        const d = await WE('PATCH', `/api/cw/visits/${c.data.id}/status`, { status: 'done' });
        return { id: c.data.id, ...d.data };
      };
      const l1 = await washOnce('LOY 333', 'Loyal Lee');
      const l2 = await washOnce('LOY 333', 'Loyal Lee');
      r = await W('GET', '/api/cw/cars/lookup?plate=LOY333');
      ok(r.data.loyalty.done === 2 && r.data.loyalty.next_free === true, 'lookup warns that the next wash is free');
      const l3 = await washOnce('LOY 333', 'Loyal Lee');
      const l4 = await washOnce('LOY 333', 'Loyal Lee');
      ok(l1.final_price === 30 && l2.final_price === 30 && l3.final_price === 0 && l3.is_free === true && l4.final_price === 30, 'every 3rd wash is free, then the count restarts');
      r = await W('GET', '/api/cw/cars/lookup?plate=LOY333');
      ok(r.data.customer.visits === 4 && r.data.customer.total === 90 && r.data.customer.avg_check === 22.5, 'customer stats: visits, total spent, average check');

      r = await W('PUT', `/api/cw/customers/${ahmadId}`, { name: 'Ahmad', phone: '0123456789', discount_percent: 20, preferences: 'No wax, call before' });
      ok(r.status === 200, 'owner sets a personal discount');
      r = await WE('PUT', `/api/cw/customers/${ahmadId}`, { name: 'Ahmad', phone: '0123456789', discount_percent: 90, preferences: 'No wax, call before' });
      r = await W('GET', `/api/cw/customers/${ahmadId}`);
      ok(r.data.customer.discount_percent === 20, 'employee cannot change the personal discount');
      ok(r.data.customer.preferences === 'No wax, call before' && r.data.cars[0].loyalty.every === 3, 'customer card has preferences and per-car loyalty');
      r = await W('POST', '/api/cw/visits', { kind: 'walkin', service_ids: [svc.id], car_id: ahmadCar });
      ok(r.status === 201, 'walk-in for a known car');
      const ahmadWalk = r.data.id;
      r = await W('GET', `/api/cw/visits/${ahmadWalk}`);
      ok(r.data.discount_percent === 20 && r.data.final_price === 24, 'personal discount is applied to the price');

      r = await W('POST', '/api/cw/customers', { name: 'Dup', cars: [{ plate: 'loy-333' }] });
      ok(r.status === 409 && r.data.error === 'plate_taken', 'a plate can belong to only one customer');

      // =================================================================
      section('Car wash: complaints and redo');
      r = await WE('POST', `/api/cw/visits/${l1.id}/rework`, { text: 'Streaks on the windows' });
      ok(r.status === 201, 'redo of a finished job');
      const reworkId = r.data.id;
      r = await W('GET', `/api/cw/visits/${reworkId}`);
      ok(r.data.is_rework === 1 && r.data.final_price === 0 && r.data.status === 'confirmed' && r.data.services.length === 1, 'redo is free and keeps services');
      r = await WE('POST', `/api/cw/visits/${v1}/rework`, {});
      ok(r.status === 400, 'cannot redo an unfinished visit');
      r = await WE('POST', '/api/cw/complaints', { visit_id: l2.id, text: 'Scratch on the door' });
      ok(r.status === 201, 'employee logs a complaint');
      r = await W('GET', '/api/cw/complaints');
      ok(r.data.length === 2 && r.data.some((c) => c.type === 'rework') && r.data.some((c) => c.staff_name === 'Sam' || c.staff_id === null), 'complaints list contains complaint and redo');
      r = await W('PATCH', `/api/cw/complaints/${r.data[0].id}`, { resolved: true });
      ok(r.status === 200, 'owner resolves a complaint');

      // =================================================================
      section('Car wash: connecting WhatsApp (done by the platform admin)');
      r = await Adm('PATCH', `/api/admin/companies/${washId}`, {
        whatsapp: {
          phone_number_id: '555000', access_token: 'SECRET-TOKEN',
          templates: { reminder: { name: 'wash_reminder', lang: 'ru' }, offer: { name: 'wash_offer', lang: 'ru' }, reschedule: { name: 'wash_reschedule', lang: 'ru' }, delay: { name: 'wash_delay', lang: 'ru' }, review: { name: 'wash_review', lang: 'ru' } },
        },
      });
      ok(r.status === 200, 'admin connects the company to WhatsApp');
      r = await W('GET', '/api/cw/bootstrap');
      ok(r.data.settings.whatsapp.configured === true && !JSON.stringify(r.data).includes('SECRET-TOKEN'), 'client sees "configured" but never the token');
      r = await Adm('GET', '/api/admin/companies');
      ok(!JSON.stringify(r.data).includes('SECRET-TOKEN') && r.data.find((c) => c.id === washId).whatsapp.token_set === true, 'admin list does not leak the token either');

      // =================================================================
      section('Car wash: automatic win-back (14 days / 30 days / lost regular)');
      const setupDone = async (plate, name, dates, extra = {}) => {
        let last;
        for (const date of dates) {
          const c = await W('POST', '/api/cw/visits', { kind: 'walkin', service_ids: [svc.id], quick: { plate, name, phone: extra.phone || '0121111111' } });
          await W('PATCH', `/api/cw/visits/${c.data.id}/status`, { status: 'in_progress' });
          await W('PATCH', `/api/cw/visits/${c.data.id}/status`, { status: 'done' });
          db.prepare("UPDATE cw_visits SET scheduled_start=?, arrived_at=?, started_at=?, finished_at=? WHERE id=?")
            .run(`${date} 10:00`, `${date} 10:00`, `${date} 10:05`, `${date} 10:35`, c.data.id);
          last = c.data.id;
        }
        return last;
      };
      await setupDone('RET 001', 'Reminder Ray', [addDays(today, -15)], { phone: '0121111111' });
      await setupDone('RET 002', 'Offer Olga', [addDays(today, -35)], { phone: '0122222222' });
      await setupDone('REG 005', 'Regular Rita', [-48, -41, -34, -27, -20].map((n) => addDays(today, n)), { phone: '0123333333' });
      await setupDone('OPT 004', 'Optout Omar', [addDays(today, -40)], { phone: '0124444444' });
      await setupDone('FAIL 01', 'Failing Fay', [addDays(today, -16)], { phone: '0111111111' });
      const omar = (await W('GET', '/api/cw/cars/lookup?plate=OPT004')).data.customer;
      await W('PUT', `/api/cw/customers/${omar.id}`, { name: 'Optout Omar', phone: '0124444444', marketing_opt_out: true });

      r = await W('POST', '/api/cw/retention/run');
      ok(r.data.found.reminders >= 2 && r.data.found.offers >= 1 && r.data.found.lostRegular === 1, 'win-back finds reminders, offers and a lost regular');
      ok(r.data.sent.sent === 3 && r.data.sent.failed === 1, 'win-back messages are sent automatically; an undeliverable number is marked failed');
      r = await W('GET', '/api/cw/followups');
      const byName = (n) => r.data.filter((f) => f.customer.name === n).map((f) => f.kind);
      ok(byName('Reminder Ray').join() === 'reminder', '15 days away -> reminder');
      ok(byName('Offer Olga').join() === 'offer', '35 days away -> personal offer');
      ok(byName('Regular Rita').includes('lost_regular') && byName('Regular Rita').includes('reminder'), 'weekly regular who vanished -> signal to the manager');
      ok(byName('Optout Omar').length === 0, 'customers who opted out of marketing get nothing');
      const ray = r.data.find((f) => f.customer.name === 'Reminder Ray');
      ok(/wa\.me\/60121111111\?text=/.test(ray.wa_link) && /Reminder Ray/.test(ray.message) && ray.days_since === 15, 'follow-up has ready-made message, WhatsApp link, days since last visit');
      const before = r.data.length;
      r = await W('POST', '/api/cw/retention/run');
      ok(r.data.found.reminders === 0 && r.data.found.offers === 0 && r.data.found.lostRegular === 0, 'win-back does not create duplicates');
      r = await W('GET', '/api/cw/followups');
      ok(r.data.length === before, 'follow-up count is stable after a re-run');
      const manual = await WE('POST', '/api/cw/followups', { customer_id: ahmadId, due_date: today, note: 'Ask about wax' });
      ok(manual.status === 201, 'manager creates a manual reminder');

      section('Car wash: WhatsApp sending (fake Cloud API)');
      await W('PATCH', `/api/cw/visits/${v1}/reschedule`, { scheduled_start: `${tomorrow} 15:00`, notify: true });
      r = await W('POST', '/api/cw/retention/run');
      ok(r.data.sent.sent === 1 && r.data.sent.failed === 0, 'reschedule notification is sent right away (failed messages are not retried blindly)');
      const call = waCalls.find((c) => c.body.template?.name === 'wash_reminder');
      ok(call && call.url === '/v21.0/555000/messages' && call.auth === 'Bearer SECRET-TOKEN' && call.body.to === '60121111111', 'WhatsApp request: endpoint, auth, recipient');
      ok(call.body.template.components[0].parameters[0].text === 'Reminder Ray', 'template variables are filled in');
      ok(waCalls.some((c) => c.body.template?.name === 'wash_reschedule'), 'reschedule notification goes out through WhatsApp');
      ok(waCalls.filter((c) => c.body.template?.name === 'wash_reminder').length === 3 && waCalls.filter((c) => c.body.template?.name === 'wash_offer').length === 1, 'reminders and the personal offer use their own templates');
      r = await W('GET', '/api/cw/messages?status=failed');
      ok(r.data.length === 1 && /undeliverable/.test(r.data[0].error), 'failed message keeps the error text');
      r = await W('GET', '/api/cw/messages?status=sent');
      ok(r.data.filter((m) => m.wa_message_id && m.wa_message_id !== 'manual').length === 4 && r.data.filter((m) => m.wa_message_id === 'manual').length === 1, 'API-sent messages store the WhatsApp id; the manually confirmed one is marked "manual"');

      section('Car wash: customer returns -> reminder closes, review is requested');
      r = await W('GET', '/api/cw/followups');
      const rayFollow = r.data.filter((f) => f.customer.name === 'Reminder Ray').length;
      const back = await washOnce('RET 001', 'Reminder Ray');
      r = await W('GET', '/api/cw/followups');
      ok(rayFollow === 1 && r.data.filter((f) => f.customer.name === 'Reminder Ray').length === 0, 'open follow-ups close when the customer returns');
      r = await W('GET', '/api/cw/messages?status=queued');
      const review = r.data.find((m) => m.kind === 'review');
      ok(review && review.visit_id === back.id, 'review request is queued after the visit');
      ok(Date.parse(review.send_after) > Date.now() + 30 * 60000, 'review request is delayed (not sent immediately)');

      // =================================================================
      section('Car wash: analytics, staff control, advertising');
      const expectedToday = db.prepare("SELECT COALESCE(SUM(final_price),0) s FROM cw_visits WHERE company_id=? AND status='done' AND substr(finished_at,1,10)=?").get(washId, today).s;
      await W('POST', '/api/cw/ads', { channel: 'Instagram', amount: 100, date: today, note: 'Reels' });
      await W('POST', '/api/cw/ads', { channel: 'instagram ', amount: 50, date: today });
      r = await W('POST', '/api/cw/customers', { name: 'Fresh IG lead', source: 'Instagram', phone: '0170000000' });
      ok(r.status === 201, 'new customer from an advertising channel');
      r = await W('GET', `/api/cw/analytics?from=${addDays(today, -60)}&to=${today}`);
      const an = r.data;
      ok(an.periods.today.revenue === expectedToday, 'revenue for today matches finished visits');
      ok(an.periods.week.revenue >= an.periods.today.revenue && an.periods.month.revenue >= an.periods.week.revenue, 'week >= day, month >= week');
      ok(an.range.cars > 0 && Math.abs(an.range.avg_check - an.range.revenue / an.range.cars) < 0.01, 'cars count and average check');
      ok(an.by_service.some((s) => s.name === 'Обычная мойка' && s.count > 0 && s.revenue > 0), 'revenue per service');
      ok(an.daily.length === 61 && an.daily.find((d) => d.date === today).revenue === expectedToday, 'daily revenue series');
      ok(an.bays.length === 2 && an.staff.some((s) => s.name === 'Sam' && s.cars > 0) && an.bays.every((b) => b.utilization >= 0 && b.utilization <= 1), 'load of bays and staff');
      const ig = an.ads.channels.find((c) => c.channel.toLowerCase().trim() === 'instagram');
      ok(ig && ig.spend === 150 && ig.new_customers >= 1, 'ad spend is summed per channel (case-insensitive)');
      ok(an.ads.cac === Math.round((150 / an.ads.new_customers) * 100) / 100, 'cost per acquired customer = spend / new customers');
      ok(ig.roi !== null && Math.abs(ig.roi - (ig.revenue - 150) / 150) < 0.01, 'advertising payback (ROI)');
      r = await W('GET', '/api/cw/ads');
      ok(r.data.length === 2, 'ad expenses list');
      r = await W('GET', `/api/cw/staff-stats?from=${addDays(today, -60)}&to=${today}`);
      const sam = r.data.staff.find((s) => s.name === 'Sam');
      ok(sam.done >= 5 && sam.accepted >= 5 && sam.planned_minutes > 0 && sam.actual_minutes >= 0 && sam.avg_planned === 30, 'staff: accepted/done, planned vs actual time');
      ok(r.data.staff.find((s) => s.name === 'Sam').complaints >= 0 && r.data.staff.some((s) => s.reworks >= 1), 'staff: complaints and redo counters');

      r = await WE('GET', '/api/cw/overview');
      ok(r.status === 200 && r.data.revenue_today === undefined && r.data.done_today >= 1, 'employee overview hides revenue');
      r = await W('GET', '/api/cw/overview');
      ok(r.data.revenue_today === expectedToday && r.data.followups_due >= 1, 'owner overview shows revenue and follow-ups due');

      r = await W('PUT', '/api/cw/settings', { retention: { reminder: { enabled: true, days: 7 }, offer: { enabled: true, days: 21, text: 'free wax' }, review: { enabled: false } }, channels: ['Instagram', 'TikTok'], open_time: '08:00', close_time: '22:00', slot_minutes: 15 });
      ok(r.data.settings.retention.reminder.days === 7 && r.data.settings.retention.offer.text === 'free wax' && r.data.settings.channels.length === 2 && r.data.settings.slot_minutes === 15, 'win-back thresholds, channels and hours are configurable');
      r = await W('PUT', '/api/cw/settings', { retention: { reminder: { days: -5 }, offer: { days: 'abc' } }, open_time: '25:99' });
      ok(r.data.settings.retention.reminder.days === 7 && r.data.settings.open_time === '08:00', 'invalid settings are ignored');

      // =================================================================
      section('Positions, permissions, client statuses, editable messages');
      const T = mk();
      await W2('POST', '/api/auth/login', { email: 'oscar@o.com', password: 'secret123' });
      r = await W('POST', '/api/positions', { name: 'Кассир', permissions: ['customers.view', 'nonsense.key', 'settings.manage'.replace('settings.manage', 'customers.view')] });
      ok(r.status === 201, 'owner creates a position with any name');
      const cashierId = r.data.id;
      r = await W('POST', '/api/positions', { name: 'кассир', permissions: [] });
      ok(r.status === 409, 'duplicate position name is refused');
      r = await W('GET', '/api/positions');
      ok(JSON.stringify(r.data.find((x) => x.id === cashierId).permissions) === '["customers.view"]', 'unknown / duplicate permission keys are dropped');
      r = await W('PUT', `/api/users/${tomId}`, { position_id: cashierId });
      ok(r.status === 200, 'owner assigns the position to an employee');
      await T('POST', '/api/auth/login', { email: 'tom@w.com', password: 'secret123' });
      r = await T('GET', '/api/me');
      ok(r.data.permissions.length === 1 && JSON.stringify(r.data.company.modules) === '["cw-customers"]', 'employee only gets the modules his position allows');
      r = await T('GET', '/api/cw/customers');
      ok(r.status === 200, 'allowed permission: customers are readable');
      for (const [m, u, b] of [['GET', '/api/cw/visits'], ['GET', '/api/cw/queue'], ['POST', '/api/cw/visits', { kind: 'walkin', service_ids: [svc.id] }], ['PUT', '/api/cw/settings', {}], ['POST', '/api/cw/services', { name: 'x', price: 1, duration_min: 5 }], ['GET', '/api/cw/analytics'], ['GET', '/api/cw/staff-stats'], ['GET', '/api/cw/followups'], ['GET', '/api/cw/messages'], ['POST', '/api/cw/statuses', { name: 'Z' }], ['POST', '/api/positions', { name: 'Boss', permissions: ['customers.view'] }], ['GET', '/api/permissions'], ['POST', '/api/users', { name: 'Q', email: 'q@w.com', password: 'secret123', position_id: cashierId }]]) {
        r = await T(m, u, b);
        ok(r.status === 403, `server refuses ${m} ${u} without the permission`);
      }
      r = await T('PUT', `/api/cw/customers/${boot.customers?.[0]?.id || 1}`, { name: 'Hacked' });
      ok(r.status === 403, 'customer edit needs customers.edit');
      r = await W('PUT', `/api/positions/${cashierId}`, { name: 'Кассир', permissions: ['customers.view', 'queue.view'] });
      r = await T('GET', '/api/cw/queue');
      ok(r.status === 200, 'position change takes effect at once for existing sessions');
      r = await W('DELETE', `/api/positions/${cashierId}`);
      ok(r.status === 409 && r.data.error === 'position_in_use', 'a position with employees cannot be deleted');
      r = await W('PUT', `/api/users/${tomId}`, { position_id: 999999 });
      ok(r.status === 400, 'unknown position id is rejected');
      r = await W2('POST', '/api/positions', { name: 'Foreign', permissions: [] });
      const foreignPos = r.data.id;
      r = await W('PUT', `/api/users/${tomId}`, { position_id: foreignPos });
      ok(r.status === 400, "another company's position cannot be used");
      r = await WE('POST', '/api/positions', { name: 'Self-made boss', permissions: ['settings.manage'] });
      ok(r.status === 403, 'employee without team.manage cannot create positions');

      // a manager with team.manage can not hand out more than he has
      r = await W('POST', '/api/positions', { name: 'Менеджер', permissions: ['team.manage', 'customers.view'] });
      const mgrPos = r.data.id;
      await W('PUT', `/api/users/${tomId}`, { position_id: mgrPos });
      r = await T('POST', '/api/positions', { name: 'Escalation', permissions: ['analytics.view'] });
      ok(r.status === 403, 'team.manage cannot grant permissions it does not hold');
      r = await T('POST', '/api/positions', { name: 'Reader', permissions: ['customers.view'] });
      ok(r.status === 201, '…but may grant ones it holds');
      await W('PUT', `/api/users/${tomId}`, { position_id: cwEmp.id });

      // client statuses
      r = await W('POST', '/api/cw/statuses', { name: 'Особый', color: '#ff0000' });
      ok(r.status === 201, 'owner creates a client status');
      const vipId = r.data.id;
      r = await W('POST', '/api/cw/statuses', { name: 'особый' });
      ok(r.status === 409, 'duplicate status name is refused');
      r = await W('PUT', `/api/cw/statuses/${vipId}`, { name: 'Особый+', color: '#00aa00' });
      ok(r.status === 200, 'owner renames a status');
      r = await WE('POST', '/api/cw/statuses', { name: 'Mine' });
      ok(r.status === 403, 'employee cannot create statuses');
      r = await W('GET', '/api/cw/customers');
      const someCustomer = r.data[0];
      r = await W('PUT', `/api/cw/customers/${someCustomer.id}`, { name: someCustomer.name, phone: someCustomer.phone || '', status_id: vipId });
      ok(r.status === 200, 'status is assigned to a customer');
      r = await W('GET', `/api/cw/customers/${someCustomer.id}`);
      ok(r.data.customer.status_id === vipId && r.data.customer.status_name === 'Особый+', 'customer card shows the status');
      r = await W('PUT', `/api/cw/customers/${someCustomer.id}`, { name: someCustomer.name, phone: someCustomer.phone || '', status_id: foreignPos });
      ok(r.status === 400, 'a status that does not exist in this company is refused');
      r = await W('DELETE', `/api/cw/statuses/${vipId}`);
      ok(r.status === 200, 'owner deletes a status');
      r = await W('GET', `/api/cw/customers/${someCustomer.id}`);
      ok(!r.data.customer.status_id, 'customers of a deleted status are left without status');

      // editing, cancelling and sending queued messages by hand
      const cid = (await W('GET', '/api/me')).data.company.id;
      const qid = Number(db.prepare("INSERT INTO cw_messages (company_id, customer_id, kind, phone, text, status, send_after, created_at) VALUES (?,?,?,?,?,?,?,?)").run(cid, someCustomer.id, 'reminder', '60129999999', 'Original text', 'queued', new Date(Date.now() + 3600e3).toISOString(), new Date().toISOString()).lastInsertRowid);
      const qid2 = Number(db.prepare("INSERT INTO cw_messages (company_id, customer_id, kind, phone, text, status, send_after, created_at) VALUES (?,?,?,?,?,?,?,?)").run(cid, someCustomer.id, 'reminder', '60128888888', 'Second', 'queued', new Date(Date.now() - 1000).toISOString(), new Date().toISOString()).lastInsertRowid);
      r = await W('GET', '/api/cw/messages?status=queued');
      ok(r.data.some((m) => m.id === qid && m.wa_link.includes('60129999999')), 'scheduled messages are listed with a WhatsApp link');
      await W('PUT', `/api/users/${tomId}`, { position_id: cashierId });
      r = await T('PUT', `/api/cw/messages/${qid}`, { text: 'x' });
      ok(r.status === 403, 'editing messages needs followups.manage');
      await W('PUT', `/api/users/${tomId}`, { position_id: cwEmp.id });
      r = await W('PUT', `/api/cw/messages/${qid}`, { text: '  ' });
      ok(r.status === 400, 'empty text is refused');
      r = await W('PUT', `/api/cw/messages/${qid2}`, { text: 'Edited by hand' });
      ok(r.status === 200, 'manager edits a scheduled message');
      const waBefore = waCalls.length;
      await W('POST', '/api/cw/retention/run');
      ok(waCalls.length === waBefore, 'an edited message is never sent by the robot');
      r = await W('GET', '/api/cw/messages?status=queued');
      const edited = r.data.find((m) => m.id === qid2);
      ok(edited && edited.text === 'Edited by hand' && edited.edited === true, 'it stays scheduled, flagged as edited');
      r = await W('PATCH', `/api/cw/messages/${qid2}`, {});
      ok(r.status === 200, 'manager marks it as sent by hand');
      r = await W('GET', '/api/cw/messages?status=sent');
      ok(r.data.some((m) => m.id === qid2 && m.wa_message_id === 'manual'), 'it moves to "sent" and is marked as manual');
      r = await W('POST', `/api/cw/messages/${qid}/cancel`, {});
      ok(r.status === 200, 'manager cancels a scheduled message');
      r = await W('PUT', `/api/cw/messages/${qid}`, { text: 'again' });
      ok(r.status === 409, 'a cancelled message can no longer be edited');
      r = await W('POST', `/api/cw/messages/${qid}/cancel`, {});
      ok(r.status === 409, 'and cannot be cancelled twice');
      r = await W2('POST', `/api/cw/messages/${qid}/cancel`, {});
      ok(r.status === 409 || r.status === 404, "another company cannot touch the message");
      await W('POST', '/api/cw/retention/run');
      r = await W('GET', '/api/cw/messages?status=cancelled');
      ok(r.data.some((m) => m.id === qid) && !waCalls.some((c) => c.body.to === '60129999999'), 'a cancelled message is never sent');

      // =================================================================
      section('Subscription terms (admin) and automatic lock');
      const Sub = require('./lib/subscription');
      ok(Sub.addMonths('2026-01-01', 1) === '2026-02-01' && Sub.addMonths('2026-01-31', 1) === '2026-02-28' && Sub.addMonths('2026-11-15', 3) === '2027-02-15', 'adding months follows the calendar (clamped to month end)');
      const stEx = Sub.stateOf({ id: washId, paid_until: '2026-02-01' });
      ok(stEx.blocks_on === '2026-02-02', 'paid on 01.01 for a month -> last day 01.02, access closes on 02.02');
      r = await W('GET', '/api/admin/companies');
      ok(r.status === 401, 'a business owner cannot use the admin API');
      r = await Adm('POST', `/api/admin/companies/${washId}/subscription`, { action: 'extend' });
      ok(r.status === 400 && r.data.error === 'bad_period', 'a period is required');
      r = await Adm('POST', `/api/admin/companies/${washId}/subscription`, { action: 'set', paid_until: '2026-13-45' });
      ok(r.status === 400 && r.data.error === 'bad_date', 'invalid end date is refused');
      r = await Adm('POST', `/api/admin/companies/${washId}/subscription`, { action: 'extend', months: 1, amount: 50, note: 'cash' });
      ok(r.status === 200 && r.data.state.days_left >= 27 && r.data.state.blocks_on === Sub.stateOf({ id: washId, paid_until: r.data.state.paid_until }).blocks_on, 'one month paid from today: end date and days left are shown');
      const until1 = r.data.state.paid_until;
      r = await Adm('POST', `/api/admin/companies/${washId}/subscription`, { action: 'extend', months: 2 });
      ok(r.data.state.paid_until === Sub.addMonths(until1, 2), 'extending a running subscription continues from its end');
      r = await Adm('POST', `/api/admin/companies/${washId}/subscription`, { action: 'extend', days: 10 });
      ok(r.status === 200 && r.data.state.paid_until === addDays(Sub.addMonths(until1, 2), 10), 'an arbitrary number of days can be added');
      r = await W('GET', '/api/me');
      ok(r.data.subscription && r.data.subscription.paid_until && r.data.subscription.days_left > 80, 'owner sees the term in /api/me');
      r = await WE('GET', '/api/me');
      ok(r.data.subscription === null, 'employees are not told about the subscription');
      r = await Adm('GET', `/api/admin/companies/${washId}/subscription`);
      ok(r.data.events.length >= 3 && r.data.events[0].admin_email === 'boss@x.com', 'every payment is kept in the history');
      // the paid period ends: yesterday was the last day
      const yesterday = addDays(today, -1);
      r = await Adm('POST', `/api/admin/companies/${washId}/subscription`, { action: 'set', paid_until: yesterday });
      ok(r.status === 200 && r.data.state.expired === true, 'term can be changed manually (here: already over)');
      r = await W('GET', '/api/cw/bootstrap');
      ok(r.status === 403 && r.data.error === 'subscription_expired', 'owner is locked out when the paid period is over');
      r = await WE('GET', '/api/cw/queue');
      ok(r.status === 403 && r.data.error === 'subscription_expired', 'employees are locked out too');
      r = await Anon('POST', '/api/auth/login', { email: 'wendy@w.com', password: 'secret123' });
      ok(r.status === 403 && r.data.error === 'subscription_expired', 'login is refused after the term');
      r = await Adm('GET', '/api/admin/companies');
      ok(r.data.find((c) => c.id === washId).subscription.expired === true, 'admin list shows the lock state');
      // access is still open on the last paid day, closes the next day
      r = await Adm('POST', `/api/admin/companies/${washId}/subscription`, { action: 'set', paid_until: today });
      r = await W('GET', '/api/cw/bootstrap');
      ok(r.status === 200, 'the last paid day is still open');
      r = await Adm('POST', `/api/admin/companies/${washId}/subscription`, { action: 'extend', months: 1 });
      ok(r.status === 200, 'renewal after the end');
      const nextCo = await Adm('POST', '/api/admin/companies', { template: 'general', companyName: 'Timed', ownerName: 'T', email: 'timed@t.com', password: 'secret123', currency: 'KZT', language: 'kk', timezone: 'Asia/Almaty', country_code: '7', period_months: 3 });
      ok(nextCo.status === 201, 'a company can be created with a paid period');
      r = await Adm('GET', `/api/admin/companies/${nextCo.data.id}/subscription`);
      ok(r.data.state.days_left > 80 && !r.data.state.unlimited, 'the chosen period is stored');
      r = await Adm('POST', `/api/admin/companies/${nextCo.data.id}/subscription`, { action: 'unlimited' });
      ok(r.data.state.unlimited === true, 'the limit can be removed');
      // messages of a locked company are not sent
      const lockId = nextCo.data.id;
      await Adm('POST', `/api/admin/companies/${lockId}/subscription`, { action: 'set', paid_until: yesterday });
      ok(!Sub.isActive(lockId) && Sub.isActive(washId), 'background jobs can tell active from locked companies');
      await Adm('POST', `/api/admin/companies/${lockId}/subscription`, { action: 'unlimited' });

      // =================================================================
      section('Administrator inside a business: view mode and logged action mode');
      r = await Anon('POST', `/api/admin/companies/${washId}/impersonate`, { mode: 'view' });
      ok(r.status === 401, 'only a signed-in platform admin can enter a business');
      r = await Adm('POST', `/api/admin/companies/${washId}/impersonate`, { mode: 'view' });
      ok(r.status === 200 && r.data.mode === 'view', 'admin enters the business in view mode');
      r = await Adm('GET', '/api/me');
      ok(r.data.impersonation && r.data.impersonation.mode === 'view' && r.data.company.id === washId, '/api/me tells the page it is an admin session');
      r = await Adm('GET', '/api/cw/customers');
      ok(r.status === 200 && r.data.length > 0, 'view mode can read the business data');
      for (const [m, u, b] of [['POST', '/api/cw/services', { name: 'Nope', price: 1, duration_min: 5 }], ['PUT', '/api/cw/settings', { open_time: '01:00' }], ['POST', '/api/cw/ads', { channel: 'x', amount: 1 }], ['POST', '/api/users', { name: 'A', email: 'a@a.a', password: 'secret123' }], ['DELETE', `/api/cw/complaints/1`]]) {
        r = await Adm(m, u, b);
        ok(r.status === 403 && r.data.error === 'read_only_mode', `view mode refuses ${m} ${u}`);
      }
      const trackBefore = db.prepare('SELECT COUNT(*) n FROM cw_followups WHERE company_id = ?').get(washId).n;
      await Adm('GET', '/api/cw/followups');
      ok(db.prepare('SELECT COUNT(*) n FROM cw_followups WHERE company_id = ?').get(washId).n === trackBefore, 'looking at win-back in view mode writes nothing');
      await Adm('POST', '/api/auth/logout');
      r = await Adm('POST', `/api/admin/companies/${washId}/impersonate`, { mode: 'act' });
      ok(r.status === 400 && r.data.error === 'reason_required', 'action mode needs a written reason');
      r = await Adm('POST', `/api/admin/companies/${washId}/impersonate`, { mode: 'act', reason: 'Client asked to fix the price list' });
      ok(r.status === 200, 'action mode starts with a reason');
      r = await Adm('POST', '/api/cw/services', { name: 'Admin-made', price: 7, duration_min: 15 });
      ok(r.status === 201, 'action mode can change data');
      const adminSvc = r.data.id;
      await Adm('DELETE', `/api/cw/services/${adminSvc}`);
      await Adm('POST', '/api/auth/logout');
      r = await Adm('GET', '/api/admin/logs?q=Admin-made');
      ok(r.data.rows.some((x) => x.action === 'service.create' && x.actor_type === 'admin' && x.actor_name === 'boss@x.com' && x.company_name === 'Shine Wash'), 'an action made as the business is logged under the admin name');
      r = await Adm('GET', '/api/admin/logs?action=admin.impersonate_start');
      ok(r.data.rows.length >= 2 && r.data.rows.some((x) => x.suspicious === 1 && /режиме действий/.test(x.suspicious_reason)) && r.data.rows.some((x) => x.details?.mode === 'view' && x.suspicious === 0), 'entering is logged; action mode is flagged as suspicious, view mode is not');
      // an admin may inspect a locked company
      await Adm('POST', `/api/admin/companies/${washId}/subscription`, { action: 'set', paid_until: yesterday });
      await Adm('POST', `/api/admin/companies/${washId}/impersonate`, { mode: 'view' });
      r = await Adm('GET', '/api/me');
      ok(r.status === 200 && r.data.company.id === washId, 'view mode works even when the business is locked for non-payment');
      await Adm('POST', '/api/auth/logout');
      await Adm('POST', `/api/admin/companies/${washId}/subscription`, { action: 'unlimited' });

      // =================================================================
      section('Audit log: events, suspicious actions, filters, tamper protection');
      r = await W('GET', '/api/admin/logs');
      ok(r.status === 401, 'business users cannot read the log');
      r = await Adm('GET', '/api/admin/logs?limit=200');
      const acts = new Set(r.data.rows.map((x) => x.action));
      ok(['auth.login', 'auth.login_failed', 'auth.login_blocked', 'company.create', 'subscription.change', 'admin.impersonate_start'].every((a) => acts.has(a)), 'logins, blocked logins, admin actions and subscription changes are recorded');
      const e0 = r.data.rows.find((x) => x.action === 'auth.login');
      ok(e0 && e0.ts && e0.actor_name && e0.company_name && e0.actor_type, 'each event keeps time, user, business and action type');
      // deletions and complaints
      r = await W('GET', '/api/cw/customers');
      const custForLog = r.data[0];
      r = await W('POST', '/api/cw/complaints', { customer_id: custForLog.id, text: 'Scratch on the door' });
      const complId = r.data.id;
      r = await W('DELETE', `/api/cw/complaints/${complId}`);
      ok(r.status === 200, 'complaint deleted');
      r = await Adm('GET', '/api/admin/logs?action=complaint.delete');
      const delEv = r.data.rows[0];
      ok(delEv && delEv.suspicious === 1 && delEv.entity_type === 'complaint' && delEv.entity_id === complId && /Scratch/.test(JSON.stringify(delEv.details)), 'complaint deletion is logged as suspicious, with the deleted data');
      r = await W('POST', '/api/cw/services', { name: 'Log-me', price: 11, duration_min: 20 });
      const logSvc = r.data.id;
      await W('PUT', `/api/cw/services/${logSvc}`, { name: 'Log-me', price: 12, duration_min: 20, active: true });
      r = await Adm('GET', '/api/admin/logs?action=service.update&q=Log-me');
      ok(r.data.rows[0] && JSON.stringify(r.data.rows[0].details.changes.price) === '[11,12]', 'a data change keeps the old and the new value');
      await W('DELETE', `/api/cw/services/${logSvc}`);
      // a request without the right is itself a signal
      r = await WE('POST', '/api/cw/services', { name: 'Hack', price: 1, duration_min: 10 });
      r = await Adm('GET', '/api/admin/logs?action=access.denied');
      ok(r.data.rows.length >= 1 && r.data.rows[0].suspicious === 1, 'a forbidden request is logged as suspicious');
      // password guessing
      const guess = mk();
      for (let i = 0; i < 5; i++) await guess('POST', '/api/auth/login', { email: 'wendy@w.com', password: 'bad' + i });
      r = await Adm('GET', '/api/admin/logs?suspicious=1&q=wendy');
      ok(r.data.rows.some((x) => /Подбор пароля/.test(x.suspicious_reason || '')), 'five failed logins in a row are flagged as password guessing');
      r = await Adm('GET', '/api/admin/logs?suspicious=1');
      ok(r.data.total >= 3 && r.data.rows.every((x) => x.suspicious === 1), 'the suspicious filter shows only flagged events');
      // mass deletion
      const mass = [];
      for (let i = 0; i < 6; i++) mass.push((await W('POST', '/api/cw/bays', { name: 'Tmp' + i })).data.id);
      for (const id of mass) await W('DELETE', `/api/cw/bays/${id}`);
      r = await Adm('GET', '/api/admin/logs?suspicious=1&q=Массовое');
      ok(r.data.rows.length >= 1, 'many deletions in a few minutes are flagged');
      // filters
      r = await Adm('GET', `/api/admin/logs?company=${wash2Id}`);
      ok(r.data.rows.every((x) => x.company_id === wash2Id), 'filter by business');
      r = await Adm('GET', `/api/admin/logs?from=${today}&to=${today}&actor_type=admin`);
      ok(r.data.total > 0 && r.data.rows.every((x) => x.actor_type === 'admin'), 'filter by date and by actor type');
      r = await Adm('GET', '/api/admin/logs?from=2000-01-01&to=2000-01-02');
      ok(r.data.total === 0, 'date filter excludes other days');
      r = await Adm('GET', '/api/admin/logs/meta');
      ok(r.data.suspicious_total >= 3 && r.data.actions.length > 5, 'meta lists the action types and the suspicious counter');
      r = await Adm('GET', '/api/admin/logs?q=password');
      ok(!JSON.stringify(r.data.rows).includes('secret123'), 'passwords never reach the log');
      // tamper protection
      let blocked = 0;
      for (const sql of ["UPDATE audit_log SET action = 'x' WHERE id = 1", 'DELETE FROM audit_log WHERE id = 1', 'DELETE FROM audit_log']) { try { db.exec(sql); } catch { blocked++; } }
      ok(blocked === 3, 'the database itself refuses to edit or delete log entries');
      r = await Adm('GET', '/api/admin/logs/verify');
      ok(r.data.ok === true && r.data.checked > 20, 'the hash chain of the log is intact');
      r = await Adm('PUT', '/api/admin/logs/1', { action: 'x' });
      ok(r.status === 404, 'there is no API to edit the log');
      r = await Adm('DELETE', '/api/admin/logs/1');
      ok(r.status === 404, 'there is no API to delete the log');

      // =================================================================
      section('Working hours: opening, closing and break (server)');
      r = await W('GET', '/api/cw/bootstrap');
      const hs = r.data.settings;
      ok(hs.open_time && hs.close_time, 'hours are part of the settings');
      const svc30 = r.data.services.find((x) => x.duration_min === 30);
      const bk = (time, extra = {}, cli = W) => cli('POST', '/api/cw/visits', { kind: 'booking', scheduled_start: `${addDays(today, 5)} ${time}`, service_ids: [svc30.id], quick: { plate: 'HRS ' + time.replace(':', ''), name: 'Hours' }, force: true, ...extra });
      await W('PUT', '/api/cw/settings', { open_time: '09:00', close_time: '21:00', break_from: '13:00', break_to: '14:00' });
      r = await bk('08:59');
      ok(r.status === 400 && r.data.error === 'before_open' && r.data.open_time === '09:00', 'a booking before opening is refused (even with force)');
      r = await bk('07:00', {}, WE);
      ok(r.status === 400 && r.data.error === 'before_open', 'employees are bound by the same rule');
      r = await bk('20:45');
      ok(r.status === 400 && r.data.error === 'after_close', 'a service that would end after closing is refused');
      r = await bk('21:30');
      ok(r.status === 400 && r.data.error === 'after_close', 'a booking after closing is refused');
      r = await bk('13:30');
      ok(r.status === 400 && r.data.error === 'in_break' && r.data.break_from === '13:00', 'a booking inside the break is refused');
      r = await bk('12:45');
      ok(r.status === 400 && r.data.error === 'in_break', 'a service overlapping the break is refused');
      r = await bk('09:00');
      ok(r.status === 201, 'opening time itself is fine');
      const hv = r.data.id;
      r = await bk('14:00');
      ok(r.status === 201, 'right after the break is fine');
      r = await bk('20:30');
      ok(r.status === 201, 'a service ending exactly at closing is fine');
      r = await W('PATCH', `/api/cw/visits/${hv}/reschedule`, { scheduled_start: `${addDays(today, 5)} 06:00` });
      ok(r.status === 400 && r.data.error === 'before_open', 'moving a booking out of hours is refused');
      r = await W('PUT', `/api/cw/visits/${hv}`, { scheduled_start: `${addDays(today, 5)} 22:00`, service_ids: [svc30.id], kind: 'booking' });
      ok(r.status === 400 && r.data.error === 'after_close', 'editing a booking out of hours is refused');
      r = await W('PUT', '/api/cw/settings', { open_time: '10:00', close_time: '09:00' });
      r = await W('GET', '/api/cw/bootstrap');
      ok(r.data.settings.open_time === '09:00' && r.data.settings.close_time === '21:00', 'closing before opening is not accepted');
      r = await W('PUT', '/api/cw/settings', { break_from: '08:00', break_to: '09:30' });
      r = await W('GET', '/api/cw/bootstrap');
      ok(!r.data.settings.break_from, 'a break outside working hours is not accepted');
      await W('PUT', '/api/cw/settings', { open_time: '10:00', close_time: '18:00' });
      r = await bk('09:30');
      ok(r.status === 400 && r.data.error === 'before_open', 'a changed opening time works at once');
      await W('PUT', '/api/cw/settings', { open_time: '09:00', close_time: '21:00', break_from: '', break_to: '' });
      r = await bk('13:30', { quick: { plate: 'HRS 1330', name: 'Hours' } });
      ok(r.status === 201, 'without a break the lunch hour is bookable');

      // =================================================================
      section('Excel export for a period');
      const ExcelJS = require('exceljs');
      const xl = async (cli, qs) => {
        const jarCookie = null; // mk() keeps cookies itself, but binary needs a raw fetch with them
        return cli('GET', '/api/cw/export' + qs);
      };
      r = await W('GET', `/api/cw/export?from=${today}&to=${today}`);
      ok(r.status === 200, 'owner can export');
      const rawFetch = async (cli, qs) => {
        // cookies of a client: log in again through fetch to get a token
        return null;
      };
      // binary download needs the cookie of the session: sign in with fetch
      const tok = async (email, pw) => {
        const x = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw }) });
        return x.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      };
      const ck = await tok('wendy@w.com', 'secret123');
      const dl = async (cookie, qs) => {
        const x = await fetch(base + '/api/cw/export' + qs, { headers: { Cookie: cookie } });
        return { status: x.status, type: x.headers.get('content-type'), disp: x.headers.get('content-disposition'), buf: Buffer.from(await x.arrayBuffer()) };
      };
      let x = await dl(ck, `?from=${addDays(today, -30)}&to=${today}`);
      ok(x.status === 200 && /spreadsheetml/.test(x.type) && /crm-report_/.test(x.disp) && x.buf.slice(0, 2).toString() === 'PK', 'a real .xlsx file is returned');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(x.buf);
      ok(wb.worksheets.map((w) => w.name).join('|') === '1. Аналитика|2. Сотрудники|3. Реклама', 'three sheets named like the sample');
      const s1 = wb.getWorksheet('1. Аналитика'), s2 = wb.getWorksheet('2. Сотрудники'), s3 = wb.getWorksheet('3. Реклама');
      ok(s1.getCell('A1').value === 'ОТЧЁТ ПО АВТОМОЙКЕ — АНАЛИТИКА' && /^Период: \d{4}-\d{2}-\d{2} — \d{4}-\d{2}-\d{2} \| Все суммы в MYR$/.test(s1.getCell('A2').value), 'sheet 1 title and period line');
      ok(['Показатель', 'Значение', 'Единица'].every((h, i) => s1.getCell(5, 1 + i).value === h) && s1.getCell('A6').value === 'Выручка', 'sheet 1 key figures table');
      ok(s1.getCell('E5').value === 'Дата' && s1.getCell('F5').value === 'Выручка, MYR' && /^\d{4}-\d{2}-\d{2}$/.test(s1.getCell('E6').value), 'daily revenue with ГГГГ-ММ-ДД dates');
      const anx = (await W('GET', `/api/cw/analytics?from=${addDays(today, -30)}&to=${today}`)).data;
      ok(s1.getCell('B6').value === anx.range.revenue && s1.getCell('B7').value === anx.range.cars && s1.getCell('B8').value === anx.range.avg_check, 'exported numbers equal the analytics screen');
      ok(['Сотрудник', 'Назначено заказов', 'Выполнено', 'Принял авто', 'План. время, мин', 'Факт. время, мин', 'Эффективность, %', 'Выручка, MYR', 'Жалобы', 'Переделки'].every((h, i) => s2.getCell(5, 1 + i).value === h), 'sheet 2 columns as in the sample');
      ok(['Канал', 'Расходы, MYR', 'Новые клиенты', 'Цена клиента, MYR', 'Выручка, MYR', 'ROI, %'].every((h, i) => s3.getCell(13, 1 + i).value === h), 'sheet 3 channel table as in the sample');
      ok(s1.views[0].state === 'frozen' && s1.getCell('A1').fill.fgColor.argb === 'FF20232D' && s1.getCell('A5').fill.fgColor.argb === 'FFEEF1FF', 'colours and frozen header follow the sample');
      // only the period
      await W('POST', '/api/cw/ads', { date: addDays(today, -400), channel: 'OldAds', amount: 999 });
      x = await dl(ck, `?from=${addDays(today, -10)}&to=${today}`);
      const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(x.buf);
      let allText = ''; wb2.eachSheet((w) => w.eachRow((row) => row.eachCell((c) => (allText += ' ' + (c.value?.result ?? c.value)))));
      ok(!allText.includes('OldAds'), 'rows outside the chosen period are not exported');
      ok(wb2.getWorksheet('1. Аналитика').getCell('A2').value.includes(`${addDays(today, -10)} — ${today}`), 'the period is written in the file');
      x = await dl(ck, `?from=${today}&to=${addDays(today, -3)}`);
      ok(x.status === 200, 'reversed dates are tolerated (swapped)');
      x = await dl(ck, `?from=${addDays(today, -30)}&to=${today}&lang=kk`);
      const wk = new ExcelJS.Workbook(); await wk.xlsx.load(x.buf);
      ok(wk.worksheets[0].name === '1. Талдау' && wk.worksheets[0].getCell('A5').value === 'Көрсеткіш', 'Kazakh export has Kazakh sheets and headers');
      // other business / rights
      const ck2 = await tok('oscar@o.com', 'secret123');
      x = await dl(ck2, `?from=${addDays(today, -30)}&to=${today}`);
      const wo = new ExcelJS.Workbook(); await wo.xlsx.load(x.buf);
      let t2 = ''; wo.eachSheet((w) => w.eachRow((row) => row.eachCell((c) => (t2 += ' ' + c.value))));
      ok(!/Wendy|Воск|Sam|Tom|OldAds|Обычная/.test(t2) && wo.getWorksheet('1. Аналитика').getCell('B6').value === 0, "another business's export holds none of the first business's data");
      x = await dl(await tok('sam@w.com', 'secret123'), `?from=${today}&to=${today}`);
      ok(x.status === 403, 'an employee without reports rights cannot export');
      r = await W('POST', '/api/positions', { name: 'Контролёр', permissions: ['staff.view'] });
      const ctrlPos = r.data.id;
      r = await W('POST', '/api/users', { name: 'Ctrl', email: 'ctrl@w.com', password: 'secret123', position_id: ctrlPos });
      x = await dl(await tok('ctrl@w.com', 'secret123'), `?from=${today}&to=${today}`);
      const wc = new ExcelJS.Workbook(); await wc.xlsx.load(x.buf);
      ok(x.status === 200 && wc.worksheets.length === 1 && wc.worksheets[0].name === '2. Сотрудники', 'a user with only staff rights gets only the staff sheet');
      r = await Anon('GET', `/api/cw/export?from=${today}&to=${today}`);
      ok(r.status === 401, 'export needs a session');
      r = await Adm('GET', '/api/admin/logs?action=export.download');
      ok(r.data.rows.length >= 3, 'downloads are logged');

      // =================================================================
      section('Win-back ("Возврат клиентов"): detection, lifecycle, settling');
      const sv1 = (await W('GET', '/api/cw/bootstrap')).data;
      const hh = (n = 0) => String((new Date().getUTCHours() + 12) % 24).padStart(2, '0') + ':' + (n ? '59' : '30'); // a sending window far from now: messages stay queued
      const doneVisit = async (plate, name, daysAgo, phone) => {
        const day = addDays(today, -daysAgo);
        let v = await W('POST', '/api/cw/visits', { kind: 'booking', scheduled_start: `${day} 10:00`, service_ids: [sv1.services[0].id], bay_id: sv1.bays[0].id, quick: { plate, name, phone } });
        const id = v.data.id;
        await W('PATCH', `/api/cw/visits/${id}/status`, { status: 'arrived' });
        await W('PATCH', `/api/cw/visits/${id}/status`, { status: 'in_progress', bay_id: sv1.bays[0].id });
        await W('PATCH', `/api/cw/visits/${id}/status`, { status: 'done' });
        db.prepare('UPDATE cw_visits SET arrived_at=?, started_at=?, finished_at=? WHERE id=?').run(`${day} 10:00`, `${day} 10:05`, `${day} 10:35`, id);
        return id;
      };
      const wr1 = await doneVisit('WB 20', 'Back20', 20, '0121000020');
      const wr2 = await doneVisit('WB 40', 'Back40', 40, '0121000040');
      const wr3 = await doneVisit('WB 05', 'Back05', 5, '0121000005');
      const wr4 = await doneVisit('WB 25', 'Optout', 25, '0121000025');
      r = await W('GET', '/api/cw/customers?q=Optout');
      await W('PUT', `/api/cw/customers/${r.data[0].id}`, { name: 'Optout', phone: r.data[0].phone, marketing_opt_out: true });
      await W('PUT', '/api/cw/settings', { retention: { auto_send: true, send_from: hh(), send_to: hh(1), reminder: { enabled: true, days: 14 }, offer: { enabled: true, days: 30 }, regular: { enabled: true } } });
      r = await W('POST', '/api/cw/retention/run');
      ok(r.status === 200 && r.data.found.reminders >= 1 && r.data.found.offers >= 1, 'the check finds customers by the days since the last visit');
      r = await W('GET', '/api/cw/followups');
      const fl = Object.fromEntries(r.data.map((f) => [f.customer.name, f]));
      ok(fl.Back20 && fl.Back20.kind === 'reminder' && fl.Back20.days_since === 20, '20 days -> reminder');
      ok(fl.Back40 && fl.Back40.kind === 'offer', '40 days -> personal offer');
      ok(!fl.Back05, '5 days -> not yet');
      ok(!fl.Optout, 'a customer who opted out of advertising is not added');
      ok(fl.Back20.wa_link && fl.Back20.message.includes('Back20'), 'the follow-up carries the message text and a WhatsApp link');
      r = await W('GET', '/api/cw/messages?status=queued');
      ok(r.data.some((m) => m.customer_name === 'Back20' && m.kind === 'reminder') && r.data.some((m) => m.customer_name === 'Back40' && m.kind === 'offer'), 'auto-send puts the messages in the queue («Запланированы»)');
      r = await W('POST', '/api/cw/retention/run');
      ok(r.data.found.reminders === 0 && r.data.found.offers === 0, 'running it again does not duplicate anything');
      r = await W('GET', '/api/cw/followups');
      ok(r.data.filter((f) => f.customer.name === 'Back20').length === 1, 'one open follow-up per customer and stage');
      r = await W('PATCH', `/api/cw/followups/${fl.Back40.id}`, { status: 'done' });
      ok(r.status === 200, 'manager marks a follow-up as done');
      r = await W('GET', '/api/cw/followups');
      ok(!r.data.some((f) => f.customer.name === 'Back40'), 'done follow-ups leave the list');
      // the customer books again: the win-back is settled and unsent messages are cancelled
      const cust20 = fl.Back20.customer.id;
      r = await W('POST', '/api/cw/visits', { kind: 'booking', scheduled_start: `${addDays(today, 2)} 11:00`, service_ids: [sv1.services[0].id], customer_id: cust20, car_id: (await W('GET', `/api/cw/customers/${cust20}`)).data.cars[0].id });
      ok(r.status === 201, 'the customer books a new visit');
      await W('POST', '/api/cw/retention/run');
      r = await W('GET', '/api/cw/followups');
      ok(!r.data.some((f) => f.customer.name === 'Back20'), 'a customer with a planned visit disappears from the list');
      r = await W('GET', '/api/cw/messages?status=cancelled');
      ok(r.data.some((m) => m.customer_name === 'Back20' && m.kind === 'reminder'), 'and his unsent reminder is cancelled');
      r = await W('POST', '/api/cw/followups', { customer_id: cust20, note: 'call him', due_date: today });
      ok(r.status === 201, 'a manual follow-up can be added from the customer card');
      r = await W('GET', '/api/cw/followups');
      ok(r.data.some((f) => f.kind === 'manual' && f.customer.name === 'Back20'), 'manual follow-ups appear in the list');
      // opening the page runs the detection by itself
      const wr6 = await doneVisit('WB 30', 'Auto30', 30, '0121000030');
      await W('POST', '/api/cw/retention/run');
      r = await W('GET', '/api/cw/followups');
      ok(r.data.some((f) => f.customer.name === 'Auto30'), 'a customer who reaches the limit later is added by the next check');
      // statuses of the customer next to the follow-up
      r = await W('GET', '/api/cw/customers?q=Auto30');
      ok(r.data[0] && 'status_id' in r.data[0], 'customer statuses are available next to the follow-up');
      // retention switched off: nothing new
      await W('PUT', '/api/cw/settings', { retention: { reminder: { enabled: false }, offer: { enabled: false }, regular: { enabled: false } } });
      const wr7 = await doneVisit('WB 50', 'Off50', 50, '0121000050');
      await W('POST', '/api/cw/retention/run');
      r = await W('GET', '/api/cw/followups');
      ok(!r.data.some((f) => f.customer.name === 'Off50'), 'with every rule switched off nobody is added');
      await W('PUT', '/api/cw/settings', { retention: { reminder: { enabled: true }, offer: { enabled: true }, regular: { enabled: true } } });

      // =================================================================
      section('Languages: Kazakh interface is complete');
      const fsx = require('fs'), vmx = require('vm');
      const ctxI = vmx.createContext({ window: {} });
      for (const f of ['i18n.js', 'i18n-cw.js', 'i18n-kk.js']) vmx.runInContext(fsx.readFileSync(require('path').join(__dirname, 'public', f), 'utf8').replace('const I18N', 'var I18N'), ctxI);
      const { ru: dRu, kk: dKk, en: dEn } = ctxI.I18N;
      ok(Object.keys(dRu).filter((k) => !(k in dKk)).length === 0 && Object.keys(dKk).filter((k) => !(k in dRu)).length === 0, 'Kazakh has exactly the keys of the Russian interface');
      ok(Object.keys(dRu).every((k) => k in dEn), 'English is complete too');
      ok(Object.keys(dRu).every((k) => (dRu[k].match(/\{\w+\}/g) || []).sort().join() === (dKk[k].match(/\{\w+\}/g) || []).sort().join()), 'placeholders such as {n} are the same in every language');
      const stillRussian = Object.keys(dKk).filter((k) => dKk[k] === dRu[k] && /[а-яё]{4,}/i.test(dRu[k]));
      ok(stillRussian.every((k) => ['nav.team', 'team.title', 'permgroup.team', 'dash.conversion', 'dash.funnel', 'currency', 'cw.phone_wa', 'phone', 'organization', 'contact', 'cw.minutes', 'cw.min', 'cw.zoom', 'cw.open_customer'].includes(k)), 'no Russian text is left in the Kazakh dictionary (only words that are the same in Kazakh)');
      ok(!Object.values(dKk).some((v) => /[ёъэ]/i.test(v.replace(/экспорт\w*/gi, ''))), 'no Russian-only letters appear in Kazakh strings');
      const kkCo = await Adm('POST', '/api/admin/companies', { template: 'carwash', companyName: 'Таза Көлік', ownerName: 'Айдар', email: 'aidar@kk.kz', password: 'secret123', currency: 'KZT', language: 'kk', timezone: 'Asia/Almaty', country_code: '7' });
      ok(kkCo.status === 201, 'a Kazakh car wash can be created');
      const KK = mk();
      await KK('POST', '/api/auth/login', { email: 'aidar@kk.kz', password: 'secret123' });
      r = await KK('GET', '/api/cw/bootstrap');
      ok(r.data.services[0].name === 'Қарапайым жуу' && r.data.bays[0].name === 'Бекет 1' && r.data.settings.language === 'kk', 'a Kazakh car wash is seeded in Kazakh');
      r = await KK('GET', '/api/positions');
      ok(r.data.some((p) => p.name === 'Әкімші') && (await KK('GET', '/api/cw/statuses')).data.some((x) => x.name === 'Тұрақты'), 'positions and statuses are seeded in Kazakh');
      const M = require('./lib/messages');
      ok(/Сәлеметсіз бе, Асхат/.test(M.messageText('reminder', 'kk', { name: 'Асхат', car: 'Toyota' })) && M.messageText('offer', 'kk', { name: 'A', offer: 'x' }).includes('сағындық'), 'client messages exist in Kazakh');
      r = await KK('PUT', '/api/cw/settings', { language: 'en' });
      r = await KK('PUT', '/api/cw/settings', { language: 'kk' });
      r = await KK('GET', '/api/cw/bootstrap');
      ok(r.data.settings.language === 'kk', 'the message language can be switched');

      section('Tenant isolation and suspension');
      await W2('POST', '/api/auth/login', { email: 'oscar@o.com', password: 'secret123' });
      r = await W2('GET', '/api/cw/customers');
      ok(r.status === 200 && r.data.length === 0, 'other car wash sees none of the customers');
      r = await W2('GET', `/api/cw/visits/${v1}`);
      ok(r.status === 404, 'other car wash cannot read a visit');
      r = await W2('PATCH', `/api/cw/visits/${v1}/status`, { status: 'cancelled' });
      ok(r.status === 404, 'other car wash cannot change a visit');
      r = await W2('GET', '/api/cw/cars/lookup?plate=ABC123');
      ok(r.data.found === false, 'other car wash cannot look up plates');
      r = await W2('POST', '/api/cw/visits', { kind: 'booking', scheduled_start: `${tomorrow} 10:00`, service_ids: [svc.id], quick: { plate: 'X 1', name: 'X' } });
      ok(r.status === 400, 'other car wash cannot use foreign services');
      r = await W2('GET', '/api/cw/messages');
      ok(r.data.length === 0, 'other car wash sees no messages');
      r = await W2('GET', '/api/cw/bootstrap');
      ok(r.data.settings.language === 'en' && r.data.services[0].name === 'Standard wash', 'English template seeds English services');

      r = await Adm('PATCH', `/api/admin/companies/${wash2Id}`, { suspended: true });
      r = await W2('GET', '/api/me');
      ok(r.status === 403 && r.data.error === 'suspended', 'suspended company is locked out immediately');
      const W2b = mk();
      r = await W2b('POST', '/api/auth/login', { email: 'oscar@o.com', password: 'secret123' });
      ok(r.status === 403, 'suspended company cannot log in');
      await Adm('PATCH', `/api/admin/companies/${wash2Id}`, { suspended: false });
      r = await W2b('POST', '/api/auth/login', { email: 'oscar@o.com', password: 'secret123' });
      ok(r.status === 200, 'access returns after reactivation');
      r = await Adm('POST', `/api/admin/companies/${wash2Id}/reset-password`, { password: 'brand-new-pass' });
      ok(r.status === 200, 'admin resets an owner password');
      r = await mk()('POST', '/api/auth/login', { email: 'oscar@o.com', password: 'brand-new-pass' });
      ok(r.status === 200, 'owner can log in with the new password');

      console.log(`\nAll ${passed} checks passed.`);
    } catch (e) {
      console.error('\nFAILED:', e.message);
      if (e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
      process.exitCode = 1;
    } finally {
      server.close();
      waServer.close();
      fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
      setTimeout(() => process.exit(process.exitCode || 0), 200);
    }
  });
});
