const CRM = window.CRM = { views: {} };
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    user: null,
    perms: [],
    company: null,
    stages: [],
    lang: (['ru', 'kk', 'en'].includes(localStorage.getItem('lang')) ? localStorage.getItem('lang') : 'ru'),
    subscription: null,
    impersonation: null,
    authNote: null,
    route: 'dashboard',
    authMode: 'login',
    taskFilter: 'open',
    contactQuery: '',
    cache: { contacts: [], users: [], deals: [], tasks: [] },
  };

  const LANGS = [['ru', 'RU'], ['kk', 'ҚАЗ'], ['en', 'EN']];
  const LOCALES = { ru: 'ru-RU', kk: 'kk-KZ', en: 'en-GB' };
  const loc = () => LOCALES[state.lang] || 'ru-RU';
  // Some browsers have no Kazakh date data and silently print English month names; use our own names then.
  const KK = {
    month: ['қаңтар', 'ақпан', 'наурыз', 'сәуір', 'мамыр', 'маусым', 'шілде', 'тамыз', 'қыркүйек', 'қазан', 'қараша', 'желтоқсан'],
    monthShort: ['қаң.', 'ақп.', 'нау.', 'сәу.', 'мам.', 'мау.', 'шіл.', 'там.', 'қыр.', 'қаз.', 'қар.', 'жел.'],
    weekdayShort: ['жс', 'дс', 'сс', 'ср', 'бс', 'жм', 'сб'],
  };
  const kkNative = (() => { try { return new Intl.DateTimeFormat('kk-KZ', { month: 'long' }).resolvedOptions().locale.startsWith('kk') && new Intl.DateTimeFormat('kk-KZ', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 5))) === 'қаңтар'; } catch { return false; } })();
  // fmtDate(date, options, timeZone): like toLocaleDateString, but correct for Kazakh everywhere
  const fmtDate = (date, o, tz) => {
    const opts = { ...o, ...(tz ? { timeZone: tz } : {}) };
    if (state.lang !== 'kk' || kkNative) return date.toLocaleString(loc(), opts);
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { ...opts, month: 'numeric', weekday: undefined, day: '2-digit', year: 'numeric', hour: undefined, minute: undefined, hour12: false }).formatToParts(date).map((x) => [x.type, x.value]));
    const wd = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: opts.timeZone }).format(date);
    const wdi = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
    const mi = +p.month - 1;
    const bits = [];
    if (opts.weekday) bits.push(KK.weekdayShort[wdi] + ',');
    if (opts.day) bits.push(String(+p.day));
    if (opts.month) bits.push((opts.month === 'long' ? KK.month : KK.monthShort)[mi]);
    if (opts.year) bits.push(p.year);
    let out = bits.join(' ');
    if (opts.hour) out += ' ' + date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: opts.timeZone });
    return out;
  };
  const langButtons = () => LANGS.map(([c, label]) => `<button type="button" data-lang="${c}" class="${state.lang === c ? 'active' : ''}">${label}</button>`).join('');
  const t = (k) => (I18N[state.lang] && I18N[state.lang][k]) ?? I18N.ru[k] ?? k;
  const isOwner = () => state.user && state.user.role === 'owner';
  const can = (k) => state.perms.includes(k); // UI only: the server checks every request again
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const money = (n) => {
    try {
      return new Intl.NumberFormat(state.lang === 'en' ? 'en-US' : loc(), {
        style: 'currency',
        currency: state.company?.currency || 'USD',
        maximumFractionDigits: 0,
      }).format(n || 0);
    } catch {
      return String(Math.round(n || 0));
    }
  };

  async function api(method, url, body) {
    const fail = (code, extra = {}) => Object.assign(new Error(code), { code, method, url: '/api' + url }, extra);
    let r;
    try {
      r = await fetch('/api' + url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw fail('network');
    }
    const raw = await r.text().catch(() => '');
    let d = {};
    let parsed = true;
    try { d = raw ? JSON.parse(raw) : {}; } catch { parsed = false; }
    if (!r.ok) {
      if (r.status === 401 && state.user) {
        state.user = null;
        render();
      }
      // the subscription ended (or the account was suspended) while the page was open: lock the screen
      if (r.status === 403 && parsed && ['subscription_expired', 'suspended'].includes(d.error) && state.user) {
        state.user = null;
        state.authNote = d.error;
        render();
      }
      // a reply that is not our JSON (proxy page, rate limit, ...) must not look like a code bug
      throw fail((parsed && d.error) || (r.status === 429 ? 'too_many' : parsed ? 'error' : 'bad_response'), { status: r.status, data: parsed ? d : {} });
    }
    if (!parsed) throw fail('bad_response', { status: r.status });
    return d;
  }
  const errText = (e) => {
    const k = 'err.' + (e.code || 'error');
    const txt = (I18N[state.lang] && I18N[state.lang][k]) ?? I18N.ru[k] ?? t('err.error');
    // server details such as working hours are filled into {open} / {close}
    const d = e.data || {};
    return txt.replace(/\{(\w+)\}/g, (m, key) => (d[key] !== undefined && d[key] !== '' ? d[key] : m));
  };
  // Technical details for the error card, so that a failure can be named exactly.
  const errTech = (e) =>
    [e.status ? 'HTTP ' + e.status : '', e.method && e.url ? `${e.method} ${e.url}` : '', e.code && e.code !== 'error' ? e.code : `${e.name || 'Error'}: ${e.message}`]
      .filter(Boolean).join(' · ');

  function toast(msg, isErr) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (isErr ? ' err' : '');
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (el.hidden = true), 3000);
  }

  // ---------- modal ----------
  function openModal({ title, body, onSubmit, submitLabel, onDelete, hideSubmit, onOpen, wide, extraActions = '' }) {
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal-bg">
        <form class="modal${wide ? ' wide' : ''}" autocomplete="off">
          <h2>${esc(title)}</h2>
          <div class="error" hidden></div>
          ${body}
          <div class="modal-actions">
            ${onDelete ? `<button type="button" class="btn danger" data-act="delete">${t('delete')}</button>` : ''}
            ${extraActions}
            <div class="right">
              <button type="button" class="btn secondary" data-act="cancel">${t('cancel')}</button>
              ${hideSubmit ? '' : `<button type="submit" class="btn">${esc(submitLabel || t('save'))}</button>`}
            </div>
          </div>
        </form>
      </div>`;
    const bg = $('.modal-bg', root);
    const form = $('form', root);
    const errBox = $('.error', root);
    const close = () => (root.innerHTML = '');
    bg.addEventListener('mousedown', (e) => {
      if (e.target === bg) close();
    });
    $('[data-act=cancel]', root).onclick = close;
    if (onDelete) {
      $('[data-act=delete]', root).onclick = async () => {
        if (!confirm(t('confirmDelete'))) return;
        try {
          await onDelete();
          close();
        } catch (e) {
          errBox.textContent = errText(e);
          errBox.hidden = false;
        }
      };
    }
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      errBox.hidden = true;
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        await onSubmit(data);
        close();
      } catch (e) {
        errBox.textContent = errText(e);
        errBox.hidden = false;
      }
    });
    if (onOpen) onOpen(form, close);
    const first = !window.matchMedia('(pointer: coarse)').matches && form.querySelector('input:not([disabled]):not([type=checkbox]), select:not([disabled]), textarea:not([disabled])');
    if (first) first.focus();
    return close;
  }

  const field = (label, html) => `<div class="field"><label>${esc(label)}</label>${html}</div>`;
  const input = (name, val = '', extra = '') => `<input name="${name}" value="${esc(val)}" ${extra}>`;
  const select = (name, options, selected, extra = '') =>
    `<select name="${name}" ${extra}>${options
      .map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(selected ?? '') ? 'selected' : ''}>${esc(l)}</option>`)
      .join('')}</select>`;

  // ---------- data loaders ----------
  async function loadRefs() {
    if (state.company.template !== 'general') return;
    const [contacts, users] = await Promise.all([
      can('contacts.view') || can('deals.create') || can('tasks.create') ? api('GET', '/contacts') : [],
      api('GET', '/users'),
    ]);
    state.cache.contacts = contacts;
    state.cache.users = users;
  }
  const contactOptions = () => [['', t('none')], ...state.cache.contacts.map((c) => [c.id, c.name])];
  const userOptions = () => state.cache.users.map((u) => [u.id, u.name]);
  const stageName = (s) => t('stage.' + s.key);

  // ---------- auth screen ----------
  function renderAuth() {
    const reg = false;
    $('#app').innerHTML = `
      <div class="auth-wrap">
        <form class="card auth-card" autocomplete="on">
          <h1>${t(reg ? 'auth.registerTitle' : 'auth.loginTitle')}</h1>
          <div class="error" ${state.authNote ? '' : 'hidden'}>${state.authNote ? esc(errText({ code: state.authNote })) : ''}</div>
          ${reg ? field(t('companyName'), input('companyName', '', 'required maxlength=100')) : ''}
          ${reg ? field(t('yourName'), input('name', '', 'required maxlength=100')) : ''}
          ${field(t('email'), input('email', '', 'type=email required autocomplete=username'))}
          ${field(t('password'), input('password', '', `type=password required minlength=${reg ? 8 : 1} autocomplete=${reg ? 'new-password' : 'current-password'} placeholder="${reg ? esc(t('passwordHint')) : ''}"`))}
          ${reg ? field(t('currency'), select('currency', ['USD', 'MYR', 'EUR', 'RUB', 'KZT', 'UAH', 'GBP', 'SGD', 'AED', 'TRY'].map((c) => [c, c]), 'USD')) : ''}
          <button class="btn" type="submit">${t(reg ? 'register' : 'login')}</button>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span class="muted" style="font-size:13px;margin-top:14px">${t('auth.closed')}</span>
            <span class="lang" style="padding:0;margin-top:14px">
              ${langButtons()}
            </span>
          </div>
        </form>
      </div>`;
    document.querySelectorAll('[data-lang]').forEach((b) => (b.onclick = () => setLang(b.dataset.lang)));
    $('form').onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      const box = $('.error');
      box.hidden = true;
      state.authNote = null;
      try {
        await api('POST', reg ? '/auth/register' : '/auth/login', data);
        await boot();
      } catch (err) {
        box.textContent = errText(err);
        box.hidden = false;
      }
    };
  }

  function setLang(l) {
    state.lang = l;
    localStorage.setItem('lang', l);
    document.documentElement.lang = l;
    render();
  }

  // "19 октября 2026": day and year in digits, month in words, in the company's time zone
  function todayLabel() {
    const tz = state.company?.timezone || undefined;
    try {
      if (state.lang === 'kk' && !kkNative) return fmtDate(new Date(), { day: 'numeric', month: 'long', year: 'numeric' }, tz);
      const parts = new Intl.DateTimeFormat(loc(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: tz }).formatToParts(new Date());
      const g = (type) => parts.find((p) => p.type === type)?.value || '';
      return `${g('day')} ${g('month')} ${g('year')}`;
    } catch {
      return new Date().toLocaleDateString();
    }
  }
  // Platform administrator inside a business: a permanent, unmissable strip
  const adminBanner = () => {
    const i = state.impersonation;
    if (!i) return '';
    return `<div class="imp-banner ${i.mode}"><span>${t(i.mode === 'act' ? 'imp.act' : 'imp.view').replace('{email}', esc(i.admin_email))}</span>
      <button type="button" class="btn small secondary" data-act="imp-exit">${t('imp.exit')}</button></div>`;
  };
  // The owner is warned a week before the paid period ends
  const subBanner = () => {
    const sb = state.subscription;
    if (state.impersonation && sb && !sb.unlimited) return '';
    if (!sb || sb.unlimited || sb.days_left === null || sb.days_left > 7) return '';
    const fmt = fmtDate(new Date(sb.paid_until + 'T00:00:00Z'), { day: 'numeric', month: 'long', year: 'numeric' }, 'UTC');
    return `<div class="sub-banner ${sb.days_left <= 2 ? 'urgent' : ''}">${t('sub.warn').replace('{date}', fmt).replace('{days}', sb.days_left + 1)}</div>`;
  };
  const roleLabel = () => (state.user.role === 'owner' ? t('role.owner') : state.user.position_name || t('role.employee'));
  // keep the date correct when the page stays open past midnight
  setInterval(() => document.querySelectorAll('[data-today]').forEach((el) => (el.textContent = todayLabel())), 30000);

  // ---------- shell ----------
  const GENERAL_VIEWS = {
    dashboard: (v) => viewDashboard(v),
    pipeline: (v) => viewPipeline(v),
    contacts: (v) => viewContacts(v),
    tasks: (v) => viewTasks(v),
    team: (v) => viewTeam(v),
  };
  const NAV_ICONS = {
    dashboard: '▦', pipeline: '⇄', contacts: '☺', tasks: '✓', team: '⚑',
    'cw-overview': '▦', 'cw-schedule': '▤', 'cw-queue': '⏱', 'cw-customers': '☺', 'cw-followups': '✆',
    'cw-analytics': '▲', 'cw-staff': '★', 'cw-settings': '⚙',
  };
  const navKey = (m) => (m === 'team' ? 'nav.team' : m.startsWith('cw-') ? 'nav.' + m : 'nav.' + m);

  function render() {
    document.documentElement.lang = state.lang;
    // the page carries the name of the business that uses the CRM, never a product name
    document.title = state.user && state.company ? state.company.name : t('app');
    const at = document.querySelector('meta[name=apple-mobile-web-app-title]'); if (at) at.content = document.title;
    clearInterval(render._poll);
    if (!state.user) return renderAuth();
    const modules = state.company.modules;
    if (!modules.length) {
      $('#app').innerHTML = `<div class="auth-wrap"><div class="card auth-card"><h1>${t('noaccess.title')}</h1><p class="muted">${t('noaccess.text')}</p>
        <button class="btn secondary" data-act="logout">${t('logout')}</button></div></div>`;
      $('[data-act=logout]').onclick = async () => { await api('POST', '/auth/logout').catch(() => {}); state.user = null; render(); };
      return;
    }
    if (!modules.includes(state.route)) state.route = modules[0];
    const main = modules.slice(0, 4);
    const more = modules.slice(4);
    const navBtn = (m) => `<button class="nav-btn ${state.route === m ? 'active' : ''}" data-route="${m}"><i>${NAV_ICONS[m] || '•'}</i><span>${t(navKey(m))}${m === 'cw-overview' ? `<small class="navdate" data-today>${esc(todayLabel())}</small>` : ''}</span></button>`;
    $('#app').innerHTML = `
      ${adminBanner()}${subBanner()}
      <div class="layout">
        <aside class="sidebar">
          <div class="brand">${esc(state.company.name)}</div>
          ${modules.map(navBtn).join('')}
          <div class="spacer"></div>
          <div class="lang">
            ${langButtons()}
          </div>
          <div class="userbox"><b>${esc(state.user.name)}</b>${esc(roleLabel())}<br>
            <button class="btn secondary small" data-act="logout" style="margin-top:8px">${t('logout')}</button></div>
        </aside>
        <header class="topbar"><b>${esc(state.company.name)}</b><span class="muted">${esc(t(navKey(state.route)))}${state.route === 'cw-overview' ? ` · <span data-today>${esc(todayLabel())}</span>` : ''}</span></header>
        <main id="view"></main>
        <nav class="tabbar">
          ${main.map(navBtn).join('')}
          ${more.length ? `<button class="nav-btn ${more.includes(state.route) ? 'active' : ''}" id="more-btn"><i>☰</i><span>${t('more')}</span></button>` : `<button class="nav-btn" id="more-btn"><i>☰</i><span>${t('more')}</span></button>`}
        </nav>
        <div class="sheet-bg" id="sheet" hidden>
          <div class="sheet">
            ${more.map(navBtn).join('')}
            <div class="lang" style="padding:10px 4px">
              ${langButtons()}
            </div>
            <div class="muted" style="padding:4px 4px 8px">${esc(state.user.name)} · ${esc(roleLabel())}</div>
            <button class="btn secondary" data-act="logout" style="width:100%">${t('logout')}</button>
          </div>
        </div>
      </div>`;
    document.querySelectorAll('[data-route]').forEach((b) => (b.onclick = () => go(b.dataset.route)));
    document.querySelectorAll('[data-lang]').forEach((b) => (b.onclick = () => setLang(b.dataset.lang)));
    const sheet = $('#sheet');
    $('#more-btn').onclick = () => (sheet.hidden = false);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.hidden = true; });
    document.querySelectorAll('[data-act=logout]').forEach((b) => (b.onclick = async () => {
      await api('POST', '/auth/logout').catch(() => {});
      state.user = null;
      render();
    }));
    document.querySelectorAll('[data-act=imp-exit]').forEach((b) => (b.onclick = async () => {
      await api('POST', '/auth/logout').catch(() => {});
      location.href = '/admin';
    }));
    renderView();
  }

  function go(r) {
    state.route = r;
    window.scrollTo(0, 0);
    render();
  }

  async function renderView() {
    const view = $('#view');
    if (!view) return;
    try {
      await loadRefs();
      const fn = state.company.template === 'general' || state.route === 'team' ? GENERAL_VIEWS[state.route] : CRM.views[state.route];
      if (fn) await fn(view);
    } catch (e) {
      // the page was replaced while this one was loading: nobody is looking at it any more
      if (!view.isConnected || e.code === 'unauthorized') return;
      console.error('view failed:', state.route, e);
      view.innerHTML = `<div class="card errview"><h2>${t('err.view_title')}</h2><p>${esc(errText(e))}</p>
        <p class="meta techline">${esc(errTech(e))}</p><button class="btn" id="retry">${t('retry')}</button></div>`;
      $('#retry').onclick = () => renderView();
      toast(errText(e), true);
    }
  }
  const refresh = () => renderView();

  // ---------- dashboard ----------
  async function viewDashboard(view) {
    const d = await api('GET', '/dashboard?today=' + todayStr());
    const maxFunnel = Math.max(1, ...d.funnel.map((f) => f.count));
    const maxMonth = Math.max(1, ...d.monthly.map((m) => m.sum));
    const maxMgr = Math.max(1, ...d.byManager.map((m) => m.won_sum));
    const stat = (label, value, cls = '') => `<div class="card stat"><div class="label">${esc(label)}</div><div class="value ${cls}">${value}</div></div>`;
    if (!view.isConnected) return;
    view.innerHTML = `
      <div class="page-head"><h1>${t('dash.title')}</h1></div>
      <div class="stats">
        ${stat(t('dash.wonMonth'), money(d.wonMonthSum))}
        ${stat(t('dash.wonSum'), money(d.wonSum))}
        ${stat(t('dash.openSum'), money(d.openSum))}
        ${stat(t('dash.openDeals'), d.openDeals)}
        ${stat(t('dash.conversion'), d.conversion === null ? t('none') : Math.round(d.conversion * 100) + '%')}
        ${stat(t('dash.contacts'), d.contacts)}
        ${stat(t('dash.tasksOpen'), d.tasksOpen)}
        ${stat(t('dash.dueToday'), d.dueToday)}
        ${stat(t('dash.overdue'), d.overdue, d.overdue > 0 ? 'bad' : '')}
      </div>
      <div class="grid2">
        <div class="card"><h2>${t('dash.funnel')}</h2>
          ${d.funnel
            .map(
              (f) => `<div class="bar-row"><span>${esc(t('stage.' + f.key))}</span>
                <div class="bar ${f.kind}"><span style="width:${(f.count / maxFunnel) * 100}%"></span></div>
                <span class="muted">${f.count} · ${money(f.sum)}</span></div>`
            )
            .join('')}
        </div>
        <div class="card"><h2>${t('dash.monthly')}</h2>
          ${
            d.monthly.length
              ? d.monthly
                  .map(
                    (m) => `<div class="bar-row"><span>${esc(m.month)}</span>
                <div class="bar won"><span style="width:${(m.sum / maxMonth) * 100}%"></span></div>
                <span class="muted">${money(m.sum)}</span></div>`
                  )
                  .join('')
              : `<div class="muted">${t('dash.noData')}</div>`
          }
        </div>
        <div class="card"><h2>${t('dash.managers')}</h2>
          ${d.byManager
            .map(
              (m) => `<div class="bar-row"><span>${esc(m.name)}</span>
                <div class="bar won"><span style="width:${(m.won_sum / maxMgr) * 100}%"></span></div>
                <span class="muted">${t('dash.won')}: ${m.won_count} · ${money(m.won_sum)} · ${t('dash.inWork')}: ${m.open_count}</span></div>`
            )
            .join('')}
        </div>
      </div>`;
  }

  // ---------- pipeline ----------
  async function viewPipeline(view) {
    const deals = await api('GET', '/deals');
    state.cache.deals = deals;
    if (!view.isConnected) return;
    view.innerHTML = `
      <div class="page-head"><h1>${t('deals.title')}</h1><button class="btn" id="new-deal" ${can('deals.create') ? '' : 'hidden'}>+ ${t('deals.new')}</button></div>
      <div class="board">
        ${state.stages
          .map((s) => {
            const items = deals.filter((d) => d.stage_id === s.id);
            const sum = items.reduce((a, d) => a + d.amount, 0);
            return `<div class="col" data-stage="${s.id}">
              <div class="col-head ${s.kind}"><span>${esc(stageName(s))}</span><small>${items.length} · ${money(sum)}</small></div>
              <div class="col-body">
                ${items
                  .map(
                    (d) => `<div class="deal-card" draggable="true" data-deal="${d.id}">
                      <div class="t">${esc(d.title)}</div>
                      <div class="a">${money(d.amount)}</div>
                      <div class="m">${esc(d.contact_name || '')}${d.contact_name && d.owner_name ? ' · ' : ''}${esc(d.owner_name || '')}</div>
                    </div>`
                  )
                  .join('')}
              </div></div>`;
          })
          .join('')}
      </div>`;
    $('#new-deal').onclick = () => dealModal(null);
    view.querySelectorAll('.deal-card').forEach((card) => {
      const id = Number(card.dataset.deal);
      card.onclick = () => dealModal(deals.find((d) => d.id === id));
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', String(id));
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
    });
    view.querySelectorAll('.col').forEach((col) => {
      col.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        col.classList.add('over');
      });
      col.addEventListener('dragleave', () => col.classList.remove('over'));
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('over');
        const id = Number(e.dataTransfer.getData('text/plain'));
        const stageId = Number(col.dataset.stage);
        const deal = deals.find((d) => d.id === id);
        if (!deal || deal.stage_id === stageId) return;
        try {
          await api('PATCH', `/deals/${id}/stage`, { stage_id: stageId });
          refresh();
        } catch (err) {
          toast(errText(err), true);
        }
      });
    });
  }

  function dealModal(deal) {
    const editing = !!deal;
    const ro = editing && !can('deals.edit'); // without edit rights the fields are read-only; the stage can still be moved
    const dis = ro ? 'disabled' : '';
    const body = `
      ${field(t('deal.title'), input('title', deal?.title, `required maxlength=200 ${dis}`))}
      <div class="row">
        ${field(t('amount'), input('amount', deal?.amount ?? 0, `type=number min=0 step=any ${dis}`))}
        ${field(t('stage'), select('stage_id', state.stages.map((s) => [s.id, stageName(s)]), deal?.stage_id ?? state.stages[0].id))}
      </div>
      ${field(t('contact'), select('contact_id', contactOptions(), deal?.contact_id, dis))}
      ${can('deals.edit') ? field(t('owner'), select('owner_id', userOptions(), deal?.owner_id ?? state.user.id)) : ''}
      ${field(t('notes'), `<textarea name="notes" maxlength=5000 ${dis}>${esc(deal?.notes || '')}</textarea>`)}`;
    openModal({
      title: editing ? deal.title : t('deals.new'),
      body,
      onSubmit: async (data) => {
        if (!editing) await api('POST', '/deals', data);
        else if (can('deals.edit')) await api('PUT', `/deals/${deal.id}`, data);
        else await api('PATCH', `/deals/${deal.id}/stage`, { stage_id: data.stage_id });
        refresh();
      },
      onDelete: editing && can('deals.delete') ? async () => { await api('DELETE', `/deals/${deal.id}`); refresh(); } : null,
    });
  }

  // ---------- contacts ----------
  async function viewContacts(view) {
    const q = state.contactQuery;
    const contacts = await api('GET', '/contacts' + (q ? '?q=' + encodeURIComponent(q) : ''));
    if (!view.isConnected) return;
    view.innerHTML = `
      <div class="page-head"><h1>${t('contacts.title')}</h1>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input id="q" placeholder="${esc(t('search'))}" value="${esc(q)}" style="width:220px">
          <button class="btn" id="new-contact" ${can('contacts.create') ? '' : 'hidden'}>+ ${t('contacts.new')}</button>
        </div>
      </div>
      <div class="card table-wrap">
        ${
          contacts.length
            ? `<table><thead><tr><th>${t('name')}</th><th>${t('organization')}</th><th>${t('email')}</th><th>${t('phone')}</th><th>${t('tags')}</th></tr></thead><tbody>
          ${contacts
            .map(
              (c) => `<tr class="click" data-id="${c.id}"><td><b>${esc(c.name)}</b></td><td>${esc(c.organization)}</td><td>${esc(c.email)}</td><td>${esc(c.phone)}</td>
              <td>${(c.tags || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</td></tr>`
            )
            .join('')}</tbody></table>`
            : `<div class="empty">${t('contacts.empty')}</div>`
        }
      </div>`;
    $('#new-contact').onclick = () => contactModal(null);
    let timer;
    $('#q').oninput = (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.contactQuery = e.target.value.trim();
        viewContacts(view).then(() => {
          const el = $('#q');
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        });
      }, 300);
    };
    view.querySelectorAll('tr.click').forEach((tr) => (tr.onclick = () => contactModal(contacts.find((c) => c.id === Number(tr.dataset.id)))));
  }

  function contactModal(c) {
    const editing = !!c;
    const ro = editing && !can('contacts.edit');
    const dis = ro ? 'disabled' : '';
    openModal({
      title: editing ? c.name : t('contacts.new'),
      hideSubmit: ro,
      body: `
        ${field(t('name'), input('name', c?.name, `required maxlength=150 ${dis}`))}
        <div class="row">
          ${field(t('email'), input('email', c?.email, `type=email maxlength=200 ${dis}`))}
          ${field(t('phone'), input('phone', c?.phone, `maxlength=50 ${dis}`))}
        </div>
        ${field(t('organization'), input('organization', c?.organization, `maxlength=150 ${dis}`))}
        ${field(t('tags'), input('tags', c?.tags, `maxlength=200 ${dis}`))}
        ${field(t('notes'), `<textarea name="notes" maxlength=5000 ${dis}>${esc(c?.notes || '')}</textarea>`)}`,
      onSubmit: async (data) => {
        if (editing) await api('PUT', `/contacts/${c.id}`, data);
        else await api('POST', '/contacts', data);
        refresh();
      },
      onDelete: editing && can('contacts.delete') ? async () => { await api('DELETE', `/contacts/${c.id}`); refresh(); } : null,
    });
  }

  // ---------- tasks ----------
  async function viewTasks(view) {
    const [all, deals] = await Promise.all([api('GET', '/tasks'), can('deals.view') ? api('GET', '/deals') : []]);
    state.cache.deals = deals;
    const f = state.taskFilter;
    const tasks = all.filter((x) => (f === 'open' ? !x.done : f === 'done' ? x.done : true));
    const today = todayStr();
    if (!view.isConnected) return;
    view.innerHTML = `
      <div class="page-head"><h1>${t('tasks.title')}</h1><button class="btn" id="new-task" ${can('tasks.create') ? '' : 'hidden'}>+ ${t('tasks.new')}</button></div>
      <div class="tabs">
        ${['open', 'done', 'all'].map((k) => `<button data-f="${k}" class="${f === k ? 'active' : ''}">${t('tasks.' + k)}</button>`).join('')}
      </div>
      <div class="card" style="padding:0">
        ${
          tasks.length
            ? tasks
                .map((x) => {
                  const over = !x.done && x.due_date && x.due_date < today;
                  const canToggle = can('tasks.complete') && (can('tasks.edit') || x.assignee_id === state.user.id || x.created_by === state.user.id);
                  return `<div class="task ${x.done ? 'done' : ''}" data-id="${x.id}">
                    <input type="checkbox" ${x.done ? 'checked' : ''} ${canToggle ? '' : 'disabled'}>
                    <div class="body">
                      <div class="title"><b>${esc(x.title)}</b></div>
                      <div class="meta">
                        ${x.due_date ? `<span class="${over ? 'badge-overdue' : ''}">${esc(x.due_date)}${over ? ' · ' + t('overdueTag') : ''}</span> · ` : ''}
                        ${esc(x.assignee_name || t('none'))}
                        ${x.contact_name ? ' · ' + esc(x.contact_name) : ''}${x.deal_title ? ' · ' + esc(x.deal_title) : ''}
                      </div>
                      ${x.description ? `<div class="meta">${esc(x.description)}</div>` : ''}
                    </div>
                    ${can('tasks.edit') ? `<button class="btn secondary small" data-edit="${x.id}">${t('edit')}</button>` : ''}
                  </div>`;
                })
                .join('')
            : `<div class="empty">${t('tasks.empty')}</div>`
        }
      </div>`;
    $('#new-task').onclick = () => taskModal(null);
    view.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { state.taskFilter = b.dataset.f; viewTasks(view); }));
    view.querySelectorAll('.task input[type=checkbox]').forEach((cb) => {
      cb.onchange = async () => {
        const id = cb.closest('.task').dataset.id;
        try {
          await api('PATCH', `/tasks/${id}/done`, { done: cb.checked });
        } catch (e) {
          toast(errText(e), true);
        }
        refresh();
      };
    });
    view.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => taskModal(all.find((x) => x.id === Number(b.dataset.edit)))));
  }

  function taskModal(task) {
    const editing = !!task;
    const dealOpts = [['', t('none')], ...state.cache.deals.map((d) => [d.id, d.title])];
    openModal({
      title: editing ? t('edit') : t('tasks.new'),
      body: `
        ${field(t('task.title'), input('title', task?.title, 'required maxlength=200'))}
        ${field(t('description'), `<textarea name="description" maxlength=5000>${esc(task?.description || '')}</textarea>`)}
        <div class="row">
          ${field(t('dueDate'), input('due_date', task?.due_date || '', 'type=date'))}
          ${field(t('assignee'), select('assignee_id', userOptions(), task?.assignee_id ?? state.user.id, can('tasks.edit') ? '' : 'disabled'))}
        </div>
        <div class="row">
          ${field(t('contact'), select('contact_id', contactOptions(), task?.contact_id))}
          ${field(t('deal'), select('deal_id', dealOpts, task?.deal_id))}
        </div>`,
      onSubmit: async (data) => {
        if (!can('tasks.edit') && !editing) data.assignee_id = data.assignee_id || state.user.id;
        if (editing) await api('PUT', `/tasks/${task.id}`, data);
        else await api('POST', '/tasks', data);
        refresh();
      },
      onDelete: editing && can('tasks.delete') ? async () => { await api('DELETE', `/tasks/${task.id}`); refresh(); } : null,
    });
  }

  // ---------- team: employees + positions ----------
  function permPicker(cat, selected) {
    const mine = new Set(cat.mine);
    return cat.groups
      .map(
        ([g, keys]) => `<fieldset class="permgroup"><legend>${esc(t('permgroup.' + g))}</legend>
          ${keys
            .map(
              (k) => `<label class="check"><input type="checkbox" name="perm" value="${k}" ${selected.has(k) ? 'checked' : ''} ${mine.has(k) ? '' : 'disabled'}>
                <span>${esc(t('perm.' + k))}</span></label>`
            )
            .join('')}</fieldset>`
      )
      .join('');
  }

  async function viewTeam(view) {
    const [users, positions, cat] = await Promise.all([api('GET', '/users'), api('GET', '/positions'), api('GET', '/permissions')]);
    const posOptions = positions.map((p) => [p.id, p.name]);
    const permLabels = (p) => {
      const l = p.permissions.map((k) => t('perm.' + k));
      return l.length ? l.slice(0, 4).join(', ') + (l.length > 4 ? ` +${l.length - 4}` : '') : t('pos.none');
    };
    if (!view.isConnected) return;
    view.innerHTML = `
      <div class="page-head"><h1>${t('team.title')}</h1><button class="btn" id="new-user">+ ${t('team.add')}</button></div>
      <p class="muted" style="max-width:720px">${t('team.info2')}</p>
      <div class="card table-wrap"><table class="stack"><thead><tr><th>${t('name')}</th><th>${t('email')}</th><th>${t('position')}</th><th></th></tr></thead><tbody>
        ${users
          .map(
            (u) => `<tr><td data-l="${t('name')}"><b>${esc(u.name)}</b></td><td data-l="${t('email')}">${esc(u.email)}</td>
            <td data-l="${t('position')}">${u.role === 'owner' ? `<span class="chip ok">${t('role.owner')}</span>` : esc(u.position_name || '—')}</td>
            <td class="acts" style="text-align:right;white-space:nowrap">${u.role === 'employee' ? `<button class="btn secondary small" data-edituser="${u.id}">${t('edit')}</button> <button class="btn danger small" data-del="${u.id}">${t('delete')}</button>` : ''}</td></tr>`
          )
          .join('')}
      </tbody></table></div>

      <div class="page-head" style="margin-top:26px"><h2 style="margin:0">${t('pos.title')}</h2><button class="btn" id="new-pos">+ ${t('pos.add')}</button></div>
      <p class="muted" style="max-width:720px">${t('pos.info')}</p>
      <div class="grid2 poslist">
        ${positions
          .map(
            (p) => `<div class="card pos">
              <div class="pos-head"><b>${esc(p.name)}</b><span class="count">${p.users}</span></div>
              <div class="meta">${esc(permLabels(p))}</div>
              <div class="actions"><button class="btn secondary small" data-editpos="${p.id}">${t('edit')}</button><button class="btn secondary small danger-t" data-delpos="${p.id}">${t('delete')}</button></div>
            </div>`
          )
          .join('')}
      </div>`;

    const userModal = (u) =>
      openModal({
        title: u ? u.name : t('team.add'),
        body: `
          ${field(t('name'), input('name', u?.name, 'required maxlength=100'))}
          ${u ? '' : field(t('email'), input('email', '', 'type=email required'))}
          ${field(t('position'), select('position_id', posOptions, u?.position_id ?? positions[0]?.id))}
          ${field(u ? t('team.newPassword') : t('password'), input('password', '', `type=password ${u ? '' : 'required'} minlength=8 autocomplete=new-password placeholder="${esc(t('passwordHint'))}"`))}`,
        onSubmit: async (data) => {
          if (u) await api('PUT', '/users/' + u.id, data);
          else await api('POST', '/users', data);
          refresh();
        },
      });
    const posModal = (p) =>
      openModal({
        title: p ? p.name : t('pos.add'),
        wide: true,
        body: `${field(t('pos.name'), input('name', p?.name, 'required maxlength=60'))}
          <div class="field"><label>${t('pos.perms')}</label><p class="meta">${t('pos.permsHint')}</p>${permPicker(cat, new Set(p ? p.permissions : []))}</div>`,
        onSubmit: async (data) => {
          const permissions = [...document.querySelectorAll('#modal-root input[name=perm]:checked')].map((x) => x.value);
          if (p) await api('PUT', '/positions/' + p.id, { name: data.name, permissions });
          else await api('POST', '/positions', { name: data.name, permissions });
          refresh();
        },
      });
    $('#new-user').onclick = () => (positions.length ? userModal(null) : toast(t('team.needPosition'), true));
    $('#new-pos').onclick = () => posModal(null);
    view.querySelectorAll('[data-edituser]').forEach((b) => (b.onclick = () => userModal(users.find((u) => u.id === Number(b.dataset.edituser)))));
    view.querySelectorAll('[data-editpos]').forEach((b) => (b.onclick = () => posModal(positions.find((p) => p.id === Number(b.dataset.editpos)))));
    const del = (attr, path) =>
      view.querySelectorAll(`[${attr}]`).forEach(
        (b) =>
          (b.onclick = async () => {
            if (!confirm(t('confirmDelete'))) return;
            try {
              await api('DELETE', `${path}/${b.getAttribute(attr)}`);
              refresh();
            } catch (e) {
              toast(errText(e), true);
            }
          })
      );
    del('data-del', '/users');
    del('data-delpos', '/positions');
  }

  // ---------- boot ----------
  async function boot() {
    try {
      const me = await api('GET', '/me');
      state.user = me.user;
      state.perms = me.permissions || [];
      state.company = me.company;
      state.stages = me.stages;
      state.subscription = me.subscription || null;
      state.impersonation = me.impersonation || null;
    } catch {
      state.user = null;
    }
    render();
  }
  Object.assign(CRM, {
    loc, fmtDate, LANGS, $, esc, state, t, api, errText, errTech, toast, openModal, field, input, select, money, todayStr, todayLabel, isOwner, can, go, refresh, setLang, render,
  });
  window.addEventListener('load', boot);
})();
