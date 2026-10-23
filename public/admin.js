// Platform admin panel: create and manage client companies from templates.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ERR = {
    required: 'Заполните обязательные поля', bad_email: 'Некорректный email', weak_password: 'Пароль клиента: минимум 8 символов',
    weak_password_admin: 'Пароль администратора: минимум 10 символов', email_taken: 'Этот email уже используется', bad_credentials: 'Неверный email или пароль',
    bad_template: 'Выберите шаблон', bad_timezone: 'Неизвестный часовой пояс', forbidden: 'Недостаточно прав', unauthorized: 'Нужно войти',
    not_found: 'Не найдено', server_error: 'Ошибка сервера', error: 'Что-то пошло не так',
    bad_date: 'Укажите дату в формате ГГГГ-ММ-ДД', bad_period: 'Выберите срок оплаты', reason_required: 'Для режима действий укажите причину (не короче 5 символов)',
  };
  const state = { admin: null, templates: [], currencies: [], companies: [], setup: false, tab: 'companies', logs: { q: {}, offset: 0 } };
  const pad2 = (n) => String(n).padStart(2, '0');
  const ruDate = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '');
  const localTime = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
  const ACTIONS = {
    'auth.login': 'Вход в CRM', 'auth.login_failed': 'Неудачный вход', 'auth.login_blocked': 'Вход заблокирован',
    'admin.login': 'Вход администратора', 'admin.login_failed': 'Неудачный вход администратора', 'admin.setup': 'Создан администратор',
    'admin.impersonate_start': 'Админ вошёл в CRM бизнеса', 'admin.impersonate_end': 'Админ вышел из CRM бизнеса',
    'company.create': 'Создан бизнес', 'company.suspend': 'Бизнес приостановлен', 'company.activate': 'Бизнес включён', 'company.rename': 'Переименован бизнес',
    'company.settings': 'Настройки бизнеса (админ)', 'company.reset_password': 'Сброс пароля владельца', 'subscription.change': 'Изменена подписка',
    'access.denied': 'Отказ в доступе (нет права)',
    'visit.create': 'Создана запись', 'visit.update': 'Изменена запись', 'visit.status': 'Сменён статус записи', 'visit.delete': 'Удалена запись',
    'visit.reschedule': 'Перенос записи', 'visit.delay': 'Задержка записи', 'visit.rework': 'Переделка',
    'complaint.create': 'Создана жалоба', 'complaint.update': 'Изменена жалоба', 'complaint.delete': 'Удалена жалоба',
    'customer.create': 'Создан клиент', 'customer.update': 'Изменён клиент', 'customer.delete': 'Удалён клиент',
    'car.create': 'Добавлено авто', 'car.update': 'Изменено авто', 'car.delete': 'Удалено авто',
    'customer_status.create': 'Создан статус клиента', 'customer_status.update': 'Изменён статус клиента', 'customer_status.delete': 'Удалён статус клиента',
    'service.create': 'Создана услуга', 'service.update': 'Изменена услуга', 'service.delete': 'Удалена услуга',
    'bay.create': 'Создан пост', 'bay.update': 'Изменён пост', 'bay.delete': 'Удалён пост',
    'settings.update': 'Изменены настройки', 'user.create': 'Создан сотрудник', 'user.update': 'Изменён сотрудник', 'user.delete': 'Удалён сотрудник',
    'position.create': 'Создана должность', 'position.update': 'Изменена должность', 'position.delete': 'Удалена должность',
    'followup.create': 'Создана задача возврата', 'followup.update': 'Изменена задача возврата', 'message.edit': 'Изменено сообщение', 'message.sent': 'Сообщение отправлено вручную',
    'message.cancel': 'Сообщение отменено', 'retention.run': 'Запуск проверки возврата', 'ad.create': 'Добавлен рекламный расход', 'ad.delete': 'Удалён рекламный расход',
    'contact.create': 'Создан контакт', 'contact.update': 'Изменён контакт', 'contact.delete': 'Удалён контакт',
    'deal.create': 'Создана сделка', 'deal.update': 'Изменена сделка', 'deal.delete': 'Удалена сделка',
    'task.create': 'Создана задача', 'task.update': 'Изменена задача', 'task.delete': 'Удалена задача', 'export.download': 'Выгрузка данных (Excel)',
  };
  const actLabel = (a) => ACTIONS[a] || a;

  async function api(method, url, body) {
    const r = await fetch('/api/admin' + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401 && state.admin) { state.admin = null; render(); }
      throw Object.assign(new Error(d.error || 'error'), { code: d.error || 'error' });
    }
    return d;
  }
  const errText = (e) => ERR[e.code] || ERR.error;
  function toast(msg, isErr) {
    const el = $('#toast');
    el.textContent = msg; el.className = 'toast' + (isErr ? ' err' : ''); el.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (el.hidden = true), 3500);
  }
  const field = (label, html, hint = '') => `<div class="field"><label>${esc(label)}</label>${html}${hint ? `<div class="meta">${hint}</div>` : ''}</div>`;
  const input = (name, val = '', extra = '') => `<input name="${name}" value="${esc(val)}" ${extra}>`;
  const select = (name, options, selected) =>
    `<select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

  function openModal({ title, body, onSubmit, submitLabel = 'Сохранить', hideSubmit, onOpen }) {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-bg"><form class="modal wide" autocomplete="off"><h2>${esc(title)}</h2><div class="error" hidden></div>${body}
      <div class="modal-actions"><div class="right"><button type="button" class="btn secondary" data-act="cancel">${hideSubmit ? 'Закрыть' : 'Отмена'}</button>${hideSubmit ? '' : `<button type="submit" class="btn">${esc(submitLabel)}</button>`}</div></div></form></div>`;
    const close = () => (root.innerHTML = '');
    const bg = $('.modal-bg', root), form = $('form', root), box = $('.error', root);
    bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
    $('[data-act=cancel]', root).onclick = close;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      box.hidden = true;
      try { await onSubmit(Object.fromEntries(new FormData(form).entries()), close); } catch (err) { box.textContent = errText(err); box.hidden = false; }
    });
    if (onOpen) onOpen(form, close);
  }

  const genPassword = () => {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const a = new Uint32Array(12);
    crypto.getRandomValues(a);
    return [...a].map((n) => chars[n % chars.length]).join('');
  };
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast('Скопировано'); } catch { toast('Не удалось скопировать, выделите текст вручную', true); } };

  // ---------- screens ----------
  function renderAuth() {
    const setup = state.setup;
    $('#app').innerHTML = `
      <div class="auth-wrap"><form class="card auth-card" autocomplete="on">
        <h1>${setup ? 'Первый запуск: создайте администратора' : 'Админ-панель'}</h1>
        ${setup ? '<p class="meta">Это ваш личный вход для создания аккаунтов клиентов. Пароль не короче 10 символов.</p>' : ''}
        <div class="error" hidden></div>
        ${field('Email', input('email', '', 'type=email required autocomplete=username'))}
        ${field('Пароль', input('password', '', `type=password required minlength=${setup ? 10 : 1} autocomplete=${setup ? 'new-password' : 'current-password'}`))}
        <button class="btn" type="submit">${setup ? 'Создать и войти' : 'Войти'}</button>
      </form></div>`;
    $('form').onsubmit = async (e) => {
      e.preventDefault();
      const box = $('.error'); box.hidden = true;
      try { await api('POST', setup ? '/setup' : '/login', Object.fromEntries(new FormData(e.target).entries())); await boot(); }
      catch (err) { box.textContent = errText(err); box.hidden = false; }
    };
  }

  const tplName = (id) => state.templates.find((t) => t.id === id)?.name || id;
  const fmtDate = (s) => String(s || '').slice(0, 10);

  // subscription badge: how long the business still has access
  function subChip(sub) {
    if (!sub || sub.unlimited) return '<span class="chip">Без ограничения срока</span>';
    if (sub.expired) return `<span class="chip bad">Доступ закрыт: срок истёк ${esc(ruDate(sub.paid_until))}</span>`;
    const left = sub.days_left === 0 ? 'последний день' : `осталось ${sub.days_left} дн.`;
    return `<span class="chip ${sub.days_left <= 5 ? 'warn' : 'ok'}">Оплачено до ${esc(ruDate(sub.paid_until))} · ${left}</span>`;
  }
  const subLine = (sub) => (!sub || sub.unlimited ? '' : sub.expired
    ? `Закрыт с ${esc(ruDate(sub.blocks_on))} 00:00`
    : `Блокировка: ${esc(ruDate(sub.blocks_on))} в 00:00 (время бизнеса)`);

  function header(list) {
    return `<header class="adm-head"><div><h1>${state.tab === 'logs' ? 'Логи' : 'Клиенты'}</h1><div class="meta">${esc(state.admin.email)}${list ? ` · ${list.length} ${list.length === 1 ? 'аккаунт' : 'аккаунтов'}` : ''}</div></div>
      <div class="btns">${state.tab === 'companies' ? '<button class="btn" id="b-new">+ Создать клиента</button>' : ''}<button class="btn secondary" id="b-out">Выйти</button></div></header>
      <div class="tabs"><button data-tab="companies" class="${state.tab === 'companies' ? 'active' : ''}">Клиенты</button><button data-tab="logs" class="${state.tab === 'logs' ? 'active' : ''}">Логи${state.suspicious24 ? ` <span class="count bad">${state.suspicious24}</span>` : ''}</button></div>`;
  }
  function bindHeader() {
    $('#b-out').onclick = async () => { await api('POST', '/logout').catch(() => {}); state.admin = null; render(); };
    document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; render(); }));
    if ($('#b-new')) $('#b-new').onclick = openCreate;
  }

  async function render() {
    if (!state.admin) return renderAuth();
    if (state.tab === 'logs') return renderLogs();
    state.companies = await api('GET', '/companies');
    api('GET', '/logs/meta').then((m) => { if (m.suspicious_24h !== state.suspicious24) { state.suspicious24 = m.suspicious_24h; const t = document.querySelector('[data-tab=logs]'); if (t) t.innerHTML = 'Логи' + (m.suspicious_24h ? ` <span class="count bad">${m.suspicious_24h}</span>` : ''); } }).catch(() => {});
    const list = state.companies;
    $('#app').innerHTML = `
      <div class="adm">
        ${header(list)}
        ${list.length ? list.map((c) => `
          <div class="card co ${c.suspended || (c.subscription && c.subscription.expired) ? 'off' : ''}">
            <div class="co-main"><div><b>${esc(c.name)}</b> <span class="chip">${esc(tplName(c.template))}</span> ${c.suspended ? '<span class="chip warn">Приостановлен</span>' : '<span class="chip ok">Активен</span>'}</div>
              <div class="meta">${esc(c.owner_name || '')} · ${esc(c.owner_email || '')} · ${c.users} польз. · ${esc(c.currency)} · с ${esc(fmtDate(c.created_at))}</div>
              <div class="meta subline">${subChip(c.subscription)} <span>${subLine(c.subscription)}</span></div>
              ${c.template === 'carwash' ? `<div class="meta">WhatsApp: ${c.whatsapp.phone_number_id && c.whatsapp.token_set ? '<span class="chip ok">подключён</span>' : '<span class="chip">не подключён</span>'} · ${esc(c.timezone)}</div>` : ''}</div>
            <div class="actions">
              <button class="btn small" data-sub="${c.id}">Подписка</button>
              <button class="btn secondary small" data-imp="${c.id}">Открыть CRM</button>
              ${c.template === 'carwash' ? `<button class="btn secondary small" data-wa="${c.id}">WhatsApp</button>` : ''}
              <button class="btn secondary small" data-pw="${c.id}">Пароль</button>
              <button class="btn secondary small ${c.suspended ? '' : 'danger-t'}" data-sus="${c.id}">${c.suspended ? 'Включить' : 'Приостановить'}</button>
            </div></div>`).join('') : '<div class="card empty">Клиентов пока нет. Нажмите «Создать клиента» и выберите шаблон.</div>'}
      </div>`;
    bindHeader();
    document.querySelectorAll('[data-sus]').forEach((b) => (b.onclick = async () => {
      const c = list.find((x) => x.id === +b.dataset.sus);
      if (!c.suspended && !confirm(`Приостановить доступ для «${c.name}»? Сотрудники не смогут войти.`)) return;
      try { await api('PATCH', '/companies/' + c.id, { suspended: !c.suspended }); render(); } catch (e) { toast(errText(e), true); }
    }));
    document.querySelectorAll('[data-pw]').forEach((b) => (b.onclick = () => openReset(list.find((x) => x.id === +b.dataset.pw))));
    document.querySelectorAll('[data-wa]').forEach((b) => (b.onclick = () => openWhatsApp(list.find((x) => x.id === +b.dataset.wa))));
    document.querySelectorAll('[data-sub]').forEach((b) => (b.onclick = () => openSubscription(list.find((x) => x.id === +b.dataset.sub))));
    document.querySelectorAll('[data-imp]').forEach((b) => (b.onclick = () => openImpersonate(list.find((x) => x.id === +b.dataset.imp))));
  }

  // ---------- subscription ----------
  const PERIODS = [['1', '1 месяц'], ['2', '2 месяца'], ['3', '3 месяца'], ['6', '6 месяцев'], ['12', '12 месяцев'], ['days', 'Свой срок (в днях)']];
  async function openSubscription(c) {
    let data;
    try { data = await api('GET', `/companies/${c.id}/subscription`); } catch (e) { return toast(errText(e), true); }
    const st = data.state;
    openModal({
      title: `Подписка: ${c.name}`,
      submitLabel: 'Применить',
      body: `
        <div class="subbox">${subChip(st)}<div class="meta">${st.unlimited ? 'Срок не ограничен: доступ закрывается только вручную («Приостановить»).' : `Последний день доступа: <b>${esc(ruDate(st.paid_until))}</b> включительно. ${subLine(st)}.`}</div></div>
        ${field('Действие', select('action', [['extend', 'Продлить на период'], ['set', 'Изменить дату окончания'], ['unlimited', 'Снять ограничение срока']], 'extend'))}
        <div id="p-extend">
          ${field('Период оплаты', select('period', PERIODS, '1'))}
          <div id="p-days" hidden>${field('Количество дней', input('days', '30', 'type=number min=1 max=3650 inputmode=numeric'))}</div>
          ${field('Начало периода', input('from', '', 'type=date'), st.unlimited || st.expired ? 'Пусто = с сегодняшнего дня.' : 'Пусто = продолжить сразу после текущего срока. Дата окончания = дата начала + период (оплата 01.01 на месяц даёт доступ по 01.02, блокировка 02.02).')}
        </div>
        <div id="p-set" hidden>${field('Последний день доступа (включительно)', input('paid_until', st.paid_until || '', 'type=date'))}</div>
        <div class="row">${field('Сумма оплаты (необязательно)', input('amount', '', 'type=number min=0 step=any inputmode=decimal'))}${field('Комментарий', input('note', '', 'maxlength=300'))}</div>
        <h3>История</h3>
        ${data.events.length ? `<div class="subhist">${data.events.map((e) => `<div><b>${esc({ start: 'Старт', extend: 'Продление', set: 'Новая дата', unlimited: 'Без ограничения' }[e.kind] || e.kind)}</b> ${e.period ? esc(e.period) : ''} ${e.paid_until ? '→ до ' + esc(ruDate(e.paid_until)) : ''} ${e.amount !== null && e.amount !== undefined ? '· ' + esc(e.amount) : ''}
          <span class="meta">${esc(String(e.created_at).slice(0, 16))} · ${esc(e.admin_email || '')} ${e.note ? '· ' + esc(e.note) : ''}</span></div>`).join('')}</div>` : '<p class="meta">Записей пока нет.</p>'}`,
      onOpen: (f) => {
        const sync = () => {
          $('#p-extend', f).hidden = f.action.value !== 'extend';
          $('#p-set', f).hidden = f.action.value !== 'set';
          $('#p-days', f).hidden = f.period.value !== 'days';
        };
        f.action.onchange = sync; f.period.onchange = sync; sync();
      },
      onSubmit: async (d, close) => {
        const body = { action: d.action, amount: d.amount, note: d.note };
        if (d.action === 'extend') { if (d.period === 'days') body.days = d.days; else body.months = d.period; if (d.from) body.from = d.from; }
        if (d.action === 'set') body.paid_until = d.paid_until;
        await api('POST', `/companies/${c.id}/subscription`, body);
        close(); toast('Подписка обновлена'); render();
      },
    });
  }

  // ---------- sign in as the business ----------
  function openImpersonate(c) {
    openModal({
      title: `Открыть CRM: ${c.name}`,
      submitLabel: 'Открыть',
      body: `
        <p class="meta">Вход идёт под владельцем бизнеса, но с вашим именем в журнале. Доступ действует 2 часа, пароль владельца не нужен и не меняется. Вход и все действия записываются в «Логи».</p>
        <label class="check one"><input type="radio" name="mode" value="view" checked><span><b>Только просмотр (рекомендуется).</b> Данные менять нельзя: любое изменение блокируется сервером.</span></label>
        <label class="check one"><input type="radio" name="mode" value="act"><span><b>Режим действий.</b> Можно менять данные от имени бизнеса. Каждое изменение пишется в журнал под вашим именем и помечается как важное событие.</span></label>
        <div id="p-reason" hidden>${field('Причина (обязательно)', input('reason', '', 'maxlength=300 placeholder="Например: помощь клиенту с настройкой услуг"'))}</div>
        ${c.suspended || (c.subscription && c.subscription.expired) ? '<p class="meta">Бизнес приостановлен или срок истёк: вы всё равно можете его открыть для проверки.</p>' : ''}`,
      onOpen: (f) => {
        const sync = () => ($('#p-reason', f).hidden = f.mode.value !== 'act');
        f.querySelectorAll('[name=mode]').forEach((r) => (r.onchange = sync)); sync();
      },
      onSubmit: async (d) => {
        await api('POST', `/companies/${c.id}/impersonate`, { mode: d.mode, reason: d.reason });
        location.href = '/';
      },
    });
  }

  // ---------- logs ----------
  function detailsHtml(r) {
    const d = r.details;
    if (!d && !r.suspicious_reason) return '<span class="meta">Подробностей нет</span>';
    const fmt = (v) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    const rows = [];
    if (d?.changes) for (const [k, [o, n]] of Object.entries(d.changes)) rows.push(`<div><b>${esc(k)}</b>: ${esc(fmt(o))} → ${esc(fmt(n))}</div>`);
    if (d?.data) for (const [k, v] of Object.entries(d.data)) rows.push(`<div><b>${esc(k)}</b>: ${esc(fmt(v))}</div>`);
    for (const k of ['mode', 'reason', 'via', 'email', 'method', 'path', 'template', 'owner_email', 'paid_until', 'note', 'action']) if (d && d[k] !== undefined) rows.push(`<div><b>${esc(k)}</b>: ${esc(fmt(d[k]))}</div>`);
    if (d?.body) rows.push(`<div><b>данные</b>: ${esc(fmt(d.body))}</div>`);
    if (d?.fields) rows.push(`<div><b>поля</b>: ${esc(d.fields.join(', '))}</div>`);
    if (d?.query) rows.push(`<div><b>параметры</b>: ${esc(fmt(d.query))}</div>`);
    return rows.join('') || '<span class="meta">Без изменений полей</span>';
  }
  async function renderLogs() {
    const q = state.logs.q;
    const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(q).filter(([, v]) => v)), limit: 50, offset: state.logs.offset }).toString();
    const [res, meta, companies] = await Promise.all([api('GET', '/logs?' + qs), api('GET', '/logs/meta'), state.companies.length ? state.companies : api('GET', '/companies')]);
    state.companies = companies; state.suspicious24 = meta.suspicious_24h;
    const from = state.logs.offset + 1, to = Math.min(res.total, state.logs.offset + 50);
    $('#app').innerHTML = `
      <div class="adm">
        ${header(null)}
        <div class="card logfilter">
          <form id="lf" class="logform">
            ${field('С даты', input('from', q.from || '', 'type=date'))}${field('По дату', input('to', q.to || '', 'type=date'))}
            ${field('Бизнес', select('company', [['', 'Все'], ...companies.map((c) => [c.id, c.name])], q.company || ''))}
            ${field('Действие', select('action', [['', 'Любое'], ...meta.actions.map((a) => [a.action, `${actLabel(a.action)} (${a.n})`])], q.action || ''))}
            ${field('Кто', select('actor_type', [['', 'Все'], ['user', 'Пользователи бизнеса'], ['admin', 'Администраторы'], ['system', 'Система']], q.actor_type || ''))}
            ${field('Поиск', input('q', q.q || '', 'placeholder="имя, объект, IP, причина…"'))}
            <label class="check one"><input type="checkbox" name="suspicious" ${q.suspicious === '1' ? 'checked' : ''}><span>Только подозрительные (${meta.suspicious_total})</span></label>
            <div class="btns"><button class="btn" type="submit">Найти</button><button class="btn secondary" type="button" id="lf-reset">Сбросить</button><button class="btn secondary" type="button" id="lf-verify">Проверить целостность журнала</button></div>
          </form>
        </div>
        <div class="meta" style="margin:8px 2px">${res.total ? `Записи ${from}–${to} из ${res.total}` : 'Записей нет'} · журнал только дополняется: изменить или удалить запись нельзя</div>
        <div class="card table-wrap"><table class="logtable"><thead><tr><th>Дата и время</th><th>Кто</th><th>Бизнес</th><th>Действие</th><th>Объект</th><th></th></tr></thead><tbody>
          ${res.rows.map((r) => `<tr class="${r.suspicious ? 'susp' : ''}" data-log="${r.id}">
            <td class="nowrap">${esc(localTime(r.ts))}</td>
            <td><b>${esc(r.actor_name || '—')}</b><div class="meta">${r.actor_type === 'admin' ? 'администратор' : r.actor_type === 'system' ? 'система' : esc(r.actor_role === 'owner' ? 'владелец' : r.actor_role ? 'сотрудник' : 'пользователь')}${r.ip ? ' · ' + esc(r.ip) : ''}</div></td>
            <td>${esc(r.company_name || '—')}</td>
            <td>${r.suspicious ? '<span class="chip bad">Подозрительно</span> ' : ''}${esc(actLabel(r.action))}${r.suspicious_reason ? `<div class="meta warnline">${esc(r.suspicious_reason)}</div>` : ''}</td>
            <td>${esc(r.entity_label || '')}${r.entity_id ? `<div class="meta">${esc(r.entity_type || '')} #${r.entity_id}</div>` : ''}</td>
            <td><button class="btn secondary small" data-open="${r.id}">Подробнее</button></td></tr>
            <tr class="detail" id="d-${r.id}" hidden><td colspan="6"><div class="detailbox">${detailsHtml(r)}</div></td></tr>`).join('')}
        </tbody></table></div>
        <div class="btns pager"><button class="btn secondary" id="pg-prev" ${state.logs.offset <= 0 ? 'disabled' : ''}>‹ Новее</button><button class="btn secondary" id="pg-next" ${to >= res.total ? 'disabled' : ''}>Старее ›</button></div>
      </div>`;
    bindHeader();
    $('#lf').onsubmit = (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target).entries());
      state.logs.q = { from: d.from, to: d.to, company: d.company, action: d.action, actor_type: d.actor_type, q: d.q, suspicious: d.suspicious ? '1' : '' };
      state.logs.offset = 0; renderLogs();
    };
    $('#lf-reset').onclick = () => { state.logs = { q: {}, offset: 0 }; renderLogs(); };
    $('#lf-verify').onclick = async () => {
      try { const v = await api('GET', '/logs/verify'); toast(v.ok ? `Журнал цел: проверено записей ${v.checked}` : `ВНИМАНИЕ: цепочка нарушена на записи №${v.brokenAt}`, !v.ok); } catch (e) { toast(errText(e), true); }
    };
    $('#pg-prev').onclick = () => { state.logs.offset = Math.max(0, state.logs.offset - 50); renderLogs(); };
    $('#pg-next').onclick = () => { state.logs.offset += 50; renderLogs(); };
    document.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => { const row = $('#d-' + b.dataset.open); row.hidden = !row.hidden; b.textContent = row.hidden ? 'Подробнее' : 'Скрыть'; }));
  }

  function openCreate() {
    const t0 = state.templates[0]?.id;
    openModal({
      title: 'Новый клиент',
      submitLabel: 'Создать аккаунт',
      body: `
        ${field('Шаблон', select('template', state.templates.map((t) => [t.id, t.name]), t0), '<span id="tpl-desc"></span>')}
        ${field('Название компании', input('companyName', '', 'required maxlength=100'))}
        <div class="row">${field('Имя владельца', input('ownerName', '', 'required maxlength=100'))}${field('Email владельца (логин)', input('email', '', 'type=email required'))}</div>
        ${field('Пароль', `<div class="pwrow">${input('password', genPassword(), 'required minlength=8 autocomplete=off')}<button type="button" class="btn secondary small" id="gen">Новый</button></div>`, 'Запишите пароль: после создания он больше не отображается. Позже его можно сбросить.')}
        <div class="row">${field('Оплаченный период', select('period', [['1', '1 месяц'], ['2', '2 месяца'], ['3', '3 месяца'], ['6', '6 месяцев'], ['12', '12 месяцев'], ['days', 'Свой срок (дни)'], ['date', 'До даты'], ['none', 'Без ограничения']], '1'), 'Считается с сегодняшнего дня. Позже можно продлить или изменить.')}<div id="cp-extra">${field('Дней', input('period_days', '30', 'type=number min=1 max=3650'))}${field('Последний день доступа', input('paid_until', '', 'type=date'))}</div></div>
        <div class="row">${field('Валюта', select('currency', state.currencies.map((c) => [c, c]), 'MYR'))}${field('Язык интерфейса', select('language', [['ru', 'Русский'], ['kk', 'Қазақша'], ['en', 'English']], 'ru'))}</div>
        <div class="row">${field('Часовой пояс', input('timezone', 'Asia/Kuala_Lumpur', 'list=tzlist required') + '<datalist id="tzlist">' + (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : ['Asia/Kuala_Lumpur', 'Europe/Moscow', 'Asia/Almaty', 'UTC']).map((z) => `<option value="${esc(z)}">`).join('') + '</datalist>')}
          ${field('Код страны для телефонов', input('country_code', '60', 'inputmode=numeric maxlength=4'), 'Малайзия 60, Россия 7, Казахстан 7')}</div>`,
      onOpen: (form) => {
        const desc = () => ($('#tpl-desc', form).textContent = state.templates.find((t) => t.id === form.template.value)?.description || '');
        form.template.onchange = desc; desc();
        const syncP = () => {
          const v = form.period.value;
          $('#cp-extra', form).hidden = !(v === 'days' || v === 'date');
          form.period_days.closest('.field').hidden = v !== 'days';
          form.paid_until.closest('.field').hidden = v !== 'date';
        };
        form.period.onchange = syncP; syncP();
        $('#gen', form).onclick = () => (form.password.value = genPassword());
      },
      onSubmit: async (d, close) => {
        const body = { ...d };
        if (d.period === 'none') { delete body.period_days; delete body.paid_until; }
        else if (d.period === 'days') { body.period_days = d.period_days; delete body.paid_until; }
        else if (d.period === 'date') { delete body.period_days; }
        else { body.period_months = d.period; delete body.period_days; delete body.paid_until; }
        await api('POST', '/companies', body);
        close();
        await render();
        openModal({
          title: 'Аккаунт создан', hideSubmit: true,
          body: `<p>Передайте клиенту данные для входа:</p>
            <div class="creds"><div><span>Адрес</span><b>${esc(location.origin)}/</b></div><div><span>Логин</span><b>${esc(String(d.email).toLowerCase())}</b></div><div><span>Пароль</span><b>${esc(d.password)}</b></div></div>
            <button type="button" class="btn" id="cp">Скопировать</button>`,
          onOpen: (f) => ($('#cp', f).onclick = () => copy(`Вход: ${location.origin}/\nЛогин: ${String(d.email).toLowerCase()}\nПароль: ${d.password}`)),
        });
      },
    });
  }

  function openReset(c) {
    openModal({
      title: `Новый пароль: ${c.name}`,
      body: `<p class="meta">Владелец: ${esc(c.owner_email)}</p>${field('Новый пароль', `<div class="pwrow">${input('password', genPassword(), 'required minlength=8 autocomplete=off')}<button type="button" class="btn secondary small" id="gen">Новый</button></div>`)}`,
      onOpen: (f) => ($('#gen', f).onclick = () => (f.password.value = genPassword())),
      onSubmit: async (d, close) => {
        await api('POST', `/companies/${c.id}/reset-password`, d);
        close();
        toast('Пароль изменён');
        copy(`Вход: ${location.origin}/\nЛогин: ${c.owner_email}\nПароль: ${d.password}`);
      },
    });
  }

  const WA_KINDS = [
    ['reminder', 'Напоминание о мойке', '{{1}} имя, {{2}} автомобиль'],
    ['offer', 'Персональное предложение', '{{1}} имя, {{2}} текст предложения'],
    ['review', 'Запрос отзыва', '{{1}} имя, {{2}} ссылка'],
    ['reschedule', 'Перенос записи', '{{1}} имя, {{2}} новое время'],
    ['delay', 'Задержка', '{{1}} имя, {{2}} минут'],
  ];
  function openWhatsApp(c) {
    const w = c.whatsapp;
    openModal({
      title: `WhatsApp: ${c.name}`,
      body: `
        <p class="meta">Нужен аккаунт WhatsApp Business Platform (Cloud API) этого бизнеса. Сообщения клиентам уходят только по заранее одобренным в Meta шаблонам. Без настройки CRM готовит тексты, а менеджер отправляет их вручную в один клик.</p>
        ${field('Phone number ID', input('phone_number_id', w.phone_number_id, 'inputmode=numeric'))}
        ${field('Access token', input('access_token', '', 'type=password autocomplete=new-password placeholder="' + (w.token_set ? 'сохранён, оставьте пустым чтобы не менять' : 'вставьте токен') + '"'))}
        ${w.token_set ? '<label class="check one"><input type="checkbox" name="clear_token"><span>Удалить сохранённый токен</span></label>' : ''}
        <h3>Шаблоны сообщений</h3>
        ${WA_KINDS.map(([k, label, vars]) => `<div class="tplrow"><b>${label}</b><div class="meta">Переменные тела шаблона: ${vars}</div>
          <div class="row">${input('tpl_' + k, w.templates[k]?.name || '', 'placeholder="имя_шаблона" pattern="[a-z0-9_]*"')}${input('lang_' + k, w.templates[k]?.lang || 'ru', 'placeholder="ru" maxlength=10')}</div></div>`).join('')}`,
      onSubmit: async (d, close) => {
        const templates = {};
        for (const [k] of WA_KINDS) if (d['tpl_' + k]) templates[k] = { name: d['tpl_' + k], lang: d['lang_' + k] || 'ru' };
        await api('PATCH', '/companies/' + c.id, { whatsapp: { phone_number_id: d.phone_number_id, access_token: d.access_token, clear_token: !!d.clear_token, templates } });
        close(); toast('Сохранено'); render();
      },
    });
  }

  async function boot() {
    try {
      const st = await api('GET', '/status');
      state.setup = st.setupRequired;
      if (!state.setup) {
        const me = await api('GET', '/me');
        state.admin = me.admin;
        const t = await api('GET', '/templates');
        state.templates = t.templates; state.currencies = t.currencies;
      }
    } catch { state.admin = null; }
    render();
  }
  boot();
})();
