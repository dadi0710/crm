// Car wash template: pages (overview, schedule, queue, customers, win-back, analytics, staff, settings).
(() => {
  const { $, esc, state, t, api, errText, toast, openModal, field, input, select, money, can } = CRM;
  const cw = CRM.cw;
  const V = CRM.views;
  const tile = (label, value, cls = '', route = '') => {
    if (route && !state.company.modules.includes(route)) route = ''; // no link to a page the user cannot open
    return `<div class="card stat ${route ? 'link' : ''}" ${route ? `data-go="${route}"` : ''}><div class="label">${esc(label)}</div><div class="value ${cls}">${value}</div></div>`;
  };
  const bindGo = (root) => root.querySelectorAll('[data-go]').forEach((el) => (el.onclick = () => CRM.go(el.dataset.go)));
  const bar = (v, max, cls = '') => `<div class="bar ${cls}"><span style="width:${max > 0 ? Math.min(100, (v / max) * 100) : 0}%"></span></div>`;
  const polling = (fn) => { clearInterval(CRM.render._poll); CRM.render._poll = setInterval(() => { if (!$('#modal-root').innerHTML) Promise.resolve(fn()).catch(() => {}); }, 30000); };
  const walkBtn = (cls = 'btn') => (can('visits.create') ? `<button class="${cls}" id="b-walk">+ ${t('cw.new_walkin')}</button>` : '');
  const bookBtn = (cls = 'btn secondary') => (can('visits.create') ? `<button class="${cls}" id="b-book">+ ${t('cw.new_booking')}</button>` : '');
  const onId = (view, id, fn) => { const el = view.querySelector(id); if (el) el.onclick = fn; };

  // ===================================================== overview
  V['cw-overview'] = async (view) => {
    await cw.boot();
    const o = await api('GET', '/cw/overview');
    if (!view.isConnected) return; // the page was re-rendered while this request was in flight
    view.innerHTML = `
      <div class="page-head"><div class="titleblock"><h1>${t('nav.cw-overview')}</h1><div class="pagedate" data-today>${esc(CRM.todayLabel())}</div></div>
        <div class="btns">${walkBtn('btn')}${bookBtn('btn secondary')}</div></div>
      <div class="stats">
        ${tile(t('cw.waiting'), o.waiting, '', 'cw-queue')}${tile(t('cw.in_work'), o.in_progress, '', 'cw-queue')}${tile(t('cw.done_today'), o.done_today)}
        ${can('analytics.view') ? tile(t('cw.revenue_today'), money(o.revenue_today)) : ''}
        ${tile(t('cw.followups_due'), o.followups_due, o.followups_due ? 'warn' : '', 'cw-followups')}
        ${can('staff.view') ? tile(t('cw.complaints_open'), o.complaints_open, o.complaints_open ? 'bad' : '', 'cw-staff') : ''}
        ${o.messages_manual ? tile(t('cw.messages_manual'), o.messages_manual, 'warn', 'cw-followups') : ''}
      </div>
      <div class="card"><h2>${t('cw.next_bookings')}</h2>
        ${o.next_up.length ? o.next_up.map((v) => cw.visitCard(v)).join('') : `<div class="empty">${t('cw.no_next')}</div>`}</div>`;
    bindGo(view);
    cw.bindCards(view);
    onId(view, '#b-walk', () => cw.openBooking({ kind: 'walkin' }));
    onId(view, '#b-book', () => cw.openBooking({ kind: 'booking' }));
    polling(() => V['cw-overview'](view));
  };

  // ===================================================== schedule
  V['cw-schedule'] = async (view) => {
    const B = await cw.boot();
    const day = (cw.day = cw.day || B.today);
    const visits = await api('GET', '/cw/visits?date=' + day);
    const mode = cw.mode || (window.innerWidth < 760 ? 'list' : 'grid');
    // calendar density (row height) and time step are remembered per browser
    const ZOOM = [16, 22, 30, 42, 56, 72];
    const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
    let zi = Number(store.get('cw.zoom')); zi = Number.isInteger(zi) && zi >= 0 && zi < ZOOM.length ? zi : 2;
    let slot = Number(store.get('cw.slot')); slot = [10, 15, 20, 30, 60].includes(slot) ? slot : B.settings.slot_minutes;
    const live = visits.filter((v) => v.status !== 'cancelled');
    const head = `
      <div class="page-head"><h1>${t('nav.cw-schedule')}</h1>
        <div class="btns">${bookBtn('btn')}${walkBtn('btn secondary')}</div></div>
      <div class="daynav">
        <button class="btn secondary" id="d-prev">‹</button>
        <button class="btn secondary" id="d-today">${t('cw.today')}</button>
        <input type="date" id="d-pick" value="${day}">
        <button class="btn secondary" id="d-next">›</button>
        <span class="daylabel">${esc(cw.dayLabel(day))}</span>
        <div class="seg"><button data-m="grid" class="${mode === 'grid' ? 'active' : ''}">${t('cw.grid')}</button><button data-m="list" class="${mode === 'list' ? 'active' : ''}">${t('cw.list')}</button></div>
      </div>
      ${mode === 'grid' ? `<div class="zoombar"><span class="meta">${t('cw.zoom')}</span>
        <button class="btn secondary small" id="z-out" ${zi <= 0 ? 'disabled' : ''} aria-label="${t('cw.zoom_out')}">−</button>
        <span class="zlabel">${t('cw.zoom_' + ['xs', 's', 'm', 'l', 'xl', 'xxl'][zi])}</span>
        <button class="btn secondary small" id="z-in" ${zi >= ZOOM.length - 1 ? 'disabled' : ''} aria-label="${t('cw.zoom_in')}">+</button>
        <label class="meta">${t('cw.interval')}</label>
        <select id="z-slot">${[10, 15, 20, 30, 60].map((n) => `<option value="${n}" ${n === slot ? 'selected' : ''}>${n} ${t('cw.min')}</option>`).join('')}</select></div>` : ''}`;
    let content;
    let a = 0;
    const rowH = ZOOM[zi];
    const bays = B.bays.filter((b) => b.active);
    if (mode === 'list') {
      content = `<div class="card">${visits.length ? visits.map((v) => cw.visitCard(v)).join('') : `<div class="empty">${t('cw.no_visits')}</div>`}</div>`;
    } else {
      let from = cw.min('2000-01-01 ' + B.settings.open_time), to = cw.min('2000-01-01 ' + B.settings.close_time);
      for (const v of live) {
        const s = cw.min(v.scheduled_start);
        from = Math.min(from, Math.floor(s / 60) * 60);
        to = Math.max(to, Math.min(1440, Math.ceil((s + v.duration_min) / 60) * 60));
      }
      a = Math.floor(from / slot) * slot;
      const rows = Math.max(1, Math.ceil((to - a) / slot));
      const ppm = rowH / slot;
      const col = (bayId) => live.filter((v) => (v.bay_id || '') === (bayId || '') && v.bay_id)
        .map((v) => `<div class="vblock st-${v.status}" data-vid="${v.id}" style="top:${(cw.min(v.scheduled_start) - a) * ppm}px;height:${Math.max(22, v.duration_min * ppm - 2)}px">
            <b>${esc(cw.hm(v.scheduled_start))} ${esc(cw.title(v))}</b><span>${esc(cw.svcNames(v))}</span>${v.staff_name ? `<span>${esc(v.staff_name)}</span>` : ''}</div>`).join('');
      const unassigned = live.filter((v) => !v.bay_id);
      const hours = [];
      for (let m = a; m < a + rows * slot; m += slot) hours.push(`<div class="tl" style="height:${rowH}px">${m % 60 === 0 || slot >= 60 ? cw.fmtMin(m) : ''}</div>`);
      const nowLine = day === B.today && cw.min(B.now) >= a && cw.min(B.now) <= a + rows * slot ? `<div class="nowline" style="top:${(cw.min(B.now) - a) * ppm}px"></div>` : '';
      content = bays.length
        ? `<div class="sched"><div class="sched-head"><div class="tcol"></div>${bays.map((b) => `<div class="bayh">${esc(b.name)}</div>`).join('')}</div>
            <div class="sched-body" style="height:${rows * rowH}px"><div class="tcol">${hours.join('')}</div>
            ${bays.map((b) => `<div class="bcol" data-bay="${b.id}" style="background-size:100% ${rowH * 2}px">${col(b.id)}${nowLine}</div>`).join('')}</div></div>
           ${unassigned.length ? `<div class="card" style="margin-top:12px"><h2>${t('cw.no_bay')} (${unassigned.length})</h2>${unassigned.map((v) => cw.visitCard(v)).join('')}</div>` : ''}`
        : `<div class="card empty">${t('cw.no_bays')}</div>`;
    }
    if (!view.isConnected) return; // the page was re-rendered while this request was in flight
    view.innerHTML = head + content;
    const after = () => V['cw-schedule'](view);
    const go = (d) => { cw.day = d; after(); };
    $('#d-prev').onclick = () => go(cw.addDays(day, -1));
    $('#d-next').onclick = () => go(cw.addDays(day, 1));
    $('#d-today').onclick = () => go(B.today);
    $('#d-pick').onchange = (e) => e.target.value && go(e.target.value);
    onId(view, '#z-out', () => { store.set('cw.zoom', Math.max(0, zi - 1)); after(); });
    onId(view, '#z-in', () => { store.set('cw.zoom', Math.min(ZOOM.length - 1, zi + 1)); after(); });
    if ($('#z-slot')) $('#z-slot').onchange = (e) => { store.set('cw.slot', e.target.value); after(); };
    view.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => { cw.mode = b.dataset.m; after(); }));
    onId(view, '#b-book', () => cw.openBooking({ kind: 'booking', date: day, after }));
    onId(view, '#b-walk', () => cw.openBooking({ kind: 'walkin', after }));
    cw.bindCards(view, after);
    if (can('visits.create')) view.querySelectorAll('.bcol').forEach((c) => (c.onclick = (e) => {
      if (e.target.closest('[data-vid]')) return;
      const y = e.clientY - c.getBoundingClientRect().top;
      cw.openBooking({ kind: 'booking', date: day, time: cw.fmtMin(a + Math.floor(y / rowH) * slot), bay_id: c.dataset.bay, after });
    }));
    polling(after);
  };

  // ===================================================== live queue
  V['cw-queue'] = async (view) => {
    const B = await cw.boot();
    const q = await api('GET', '/cw/queue');
    const after = () => V['cw-queue'](view);
    const work = can('visits.work') || can('visits.edit');
    const sec = (title, n, html, empty) => `<div class="card"><h2>${title} <span class="count">${n}</span></h2>${html || `<div class="empty">${empty}</div>`}</div>`;
    const waiting = q.waiting.map((v) => cw.visitCard(v, `<div class="meta wait">${v.waited_min >= 1 ? t('cw.waited') + ': ' + cw.dur(v.waited_min) + ' · ' : ''}${t('cw.est_wait')}: ${v.est_wait_min ? '~' + cw.dur(v.est_wait_min) : t('cw.now')}</div>
        ${work ? `<div class="qa"><button class="btn small" data-start="${v.id}">${t('cw.act_start')}</button></div>` : ''}`)).join('');
    const working = q.in_progress.map((v) => {
      const over = v.elapsed_min > v.duration_min + (v.delay_minutes || 0);
      return cw.visitCard(v, `<div class="meta">${t('cw.elapsed')}: ${cw.dur(v.elapsed_min)} / ${cw.dur(v.duration_min)}</div>${bar(v.elapsed_min, v.duration_min, over ? 'lost' : '')}
        ${work ? `<div class="qa"><button class="btn small" data-finish="${v.id}">${t('cw.act_finish')}</button></div>` : ''}`);
    }).join('');
    const upcoming = q.upcoming.map((v) => cw.visitCard(v, `${v.minutes_late > 5 ? `<div class="meta late">${t('cw.late_by')} ${cw.dur(v.minutes_late)}</div>` : ''}
        ${work ? `<div class="qa"><button class="btn small" data-arrive="${v.id}">${t('cw.act_arrived')}</button></div>` : ''}`)).join('');
    if (!view.isConnected) return; // the page was re-rendered while this request was in flight
    view.innerHTML = `
      <div class="page-head"><h1>${t('nav.cw-queue')}</h1>${walkBtn('btn')}</div>
      <div class="grid2">
        ${sec(t('cw.expected'), q.upcoming.length, upcoming, t('cw.none_expected'))}
        ${sec(t('cw.waiting'), q.waiting.length, waiting, t('cw.none_waiting'))}
        ${sec(t('cw.in_work'), q.in_progress.length, working, t('cw.none_in_work'))}
      </div>`;
    cw.bindCards(view, after);
    onId(view, '#b-walk', () => cw.openBooking({ kind: 'walkin', after }));
    const quick = (attr, status) => view.querySelectorAll(`[${attr}]`).forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      if (status === 'in_progress' || status === 'done') return cw.openVisit(+b.getAttribute(attr), after).then(() => {
        // open the dialog and trigger the primary action right away
        const next = document.querySelector('#modal-root [data-a=next]');
        if (next) next.click();
      });
      try { await api('PATCH', `/cw/visits/${b.getAttribute(attr)}/status`, { status }); after(); } catch (err) { toast(errText(err), true); }
    }));
    quick('data-start', 'in_progress');
    quick('data-finish', 'done');
    quick('data-arrive', 'arrived');
    polling(after);
  };

  // ===================================================== customers
  V['cw-customers'] = async (view) => {
    await cw.boot();
    const q = cw.q || '';
    const stf = cw.stFilter || '';
    const qs = [q ? 'q=' + encodeURIComponent(q) : '', stf ? 'status=' + encodeURIComponent(stf) : ''].filter(Boolean).join('&');
    const rows = await api('GET', '/cw/customers' + (qs ? '?' + qs : ''));
    const sts = cw.B.statuses || [];
    const after = () => V['cw-customers'](view);
    if (!view.isConnected) return; // the page was re-rendered while this request was in flight
    view.innerHTML = `
      <div class="page-head"><h1>${t('nav.cw-customers')}</h1>
        <div class="btns"><input id="q" type="search" placeholder="${esc(t('cw.search_ph'))}" value="${esc(q)}">
          ${sts.length ? `<select id="st-filter" class="st-filter"><option value="">${esc(t('cw.all_statuses'))}</option>${sts.map((x) => `<option value="${x.id}" ${String(x.id) === String(stf) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}<option value="none" ${stf === 'none' ? 'selected' : ''}>${esc(t('cw.no_status'))}</option></select>` : ''}
          ${can('customers.edit') ? `<button class="btn" id="b-new">+ ${t('cw.new_customer')}</button>` : ''}</div></div>
      <div class="card">${rows.length ? rows.map((c) => `
        <div class="crow" data-cid="${c.id}">
          <div class="cmain"><b>${esc(c.name)}</b>${c.status_name ? `<span class="st-chip" style="background:${esc(c.status_color)}">${esc(c.status_name)}</span>` : ''}${c.plates ? ` <span class="plate">${esc(c.plates)}</span>` : ''}
            <div class="meta">${esc(c.car_names || '')}${c.phone ? ' · ' + esc(c.phone) : ''}${c.instagram ? ' · ' + esc(c.instagram) : ''}</div></div>
          <div class="cstat"><b>${money(c.total)}</b><div class="meta">${c.visits} ${t('cw.visits_short')} · ${t('cw.avg')} ${money(c.avg_check)}</div><div class="meta">${c.last_visit ? esc(cw.dayLabel(c.last_visit)) : '—'}</div></div>
        </div>`).join('') : `<div class="empty">${t('cw.no_customers')}</div>`}</div>`;
    onId(view, '#b-new', () => cw.openCustomer(null, after));
    const stSel = view.querySelector('#st-filter');
    if (stSel) stSel.onchange = () => { cw.stFilter = stSel.value; after(); };
    let timer;
    $('#q').oninput = (e) => { clearTimeout(timer); timer = setTimeout(async () => { cw.q = e.target.value.trim(); await after(); const el = $('#q'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, 300); };
    view.querySelectorAll('[data-cid]').forEach((el) => (el.onclick = () => cw.openCustomer(+el.dataset.cid, after)));
  };

  // ===================================================== win-back + messages
  V['cw-followups'] = async (view) => {
    await cw.boot();
    const TABS = ['followups', 'manual', 'queued', 'sent', 'failed', 'cancelled'];
    const tab = TABS.includes(cw.fuTab) ? cw.fuTab : 'followups';
    const after = () => V['cw-followups'](view);
    const mgr = can('followups.manage');
    const stamp = (x) => (x || '').replace('T', ' ').slice(0, 16);
    const local = (iso) => {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? '' : CRM.fmtDate(d, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    };
    // explains WHEN a customer shows up here, so an empty list does not look like a broken one
    const emptyRules = () => {
      const R = cw.B.settings.retention;
      const parts = [];
      if (R.reminder.enabled) parts.push(t('cw.rule_reminder').replace('{n}', R.reminder.days));
      if (R.offer.enabled) parts.push(t('cw.rule_offer').replace('{n}', R.offer.days));
      if (R.regular.enabled) parts.push(t('cw.rule_regular'));
      return (parts.length ? parts.join(' ') + ' ' : t('cw.rule_off') + ' ') + t('cw.rule_note');
    };
    let body = '';
    if (tab === 'followups') {
      const list = await api('GET', '/cw/followups');
      body = list.length ? list.map((f) => `
        <div class="card fu ${f.due ? '' : 'future'}">
          <div class="fu-head"><div><b>${esc(f.customer.name)}</b> ${f.car ? `<span class="plate">${esc(f.car)}</span>` : ''}</div><span class="chip fk-${f.kind}">${esc(t('fk.' + f.kind))}</span></div>
          <div class="meta">${f.days_since !== null ? `${t('cw.days_ago')}: ${f.days_since}` : ''} ${f.last_visit ? '· ' + esc(cw.dayLabel(f.last_visit)) : ''} · ${esc(f.customer.phone || f.customer.whatsapp || '')}${f.due ? '' : ' · ' + esc(f.due_date)}</div>
          ${f.note ? `<div class="meta">${esc(f.note)}</div>` : ''}
          ${f.kind === 'lost_regular' ? `<div class="hint">${t('cw.lost_regular_hint')}</div>` : ''}
          ${f.customer.opt_out ? `<div class="warnbox">${t('cw.opted_out')}</div>` : !f.has_phone ? `<div class="warnbox">${t('cw.no_phone')}</div>` : `<div class="msg">${esc(f.message)}</div>`}
          <div class="actions">
            ${mgr && !f.customer.opt_out && f.wa_link ? `<a class="btn" href="${esc(f.wa_link)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
            ${can('customers.view') ? `<button class="btn secondary" data-open="${f.customer.id}">${t('cw.open_customer')}</button>` : ''}
            ${mgr ? `<button class="btn secondary" data-done="${f.id}">${t('cw.done')}</button>
            <button class="btn secondary danger-t" data-dismiss="${f.id}">${t('cw.dismiss')}</button>` : ''}
          </div></div>`).join('') : `<div class="card empty"><p>${t('cw.no_followups')}</p><p class="meta">${emptyRules()}</p></div>`;
    } else {
      const list = await api('GET', '/cw/messages?status=' + tab);
      body = list.length ? list.map((m) => {
        const open = ['queued', 'manual', 'failed'].includes(m.status);
        let when = stamp(m.sent_at || m.created_at);
        if (m.status === 'queued') when = m.edited ? t('cw.msg_hold') : m.send_after && Date.parse(m.send_after) > Date.now() ? `${t('cw.msg_scheduled')}: ${local(m.send_after)}` : t('cw.msg_soon');
        return `
        <div class="card fu"><div class="fu-head"><div><b>${esc(m.customer_name || m.phone)}</b> <span class="meta">${esc(m.phone)}</span></div>
            <span>${m.edited ? `<span class="chip warn">${t('cw.msg_edited')}</span> ` : ''}${m.wa_message_id === 'manual' ? `<span class="chip">${t('cw.msg_by_hand')}</span> ` : ''}<span class="chip">${esc(t('mk.' + m.kind))}</span></span></div>
          <div class="msg">${esc(m.text)}</div>${m.error ? `<div class="warnbox">${esc(m.error)}</div>` : ''}
          <div class="meta">${esc(when)}</div>
          ${mgr && open ? `<div class="actions">
            <button class="btn secondary" data-medit="${m.id}">${t('edit')}</button>
            ${m.wa_link ? `<a class="btn" href="${esc(m.wa_link)}" target="_blank" rel="noopener" data-msend="${m.id}">${t('cw.msg_send_now')}</a>` : ''}
            ${m.status !== 'queued' ? `<button class="btn secondary" data-sent="${m.id}">${t('cw.mark_sent')}</button>` : ''}
            <button class="btn secondary danger-t" data-mcancel="${m.id}">${t('cw.msg_cancel')}</button></div>` : ''}</div>`;
      }).join('') : `<div class="card empty">${t('cw.no_messages')}</div>`;
      if (tab === 'queued' && list.length) body = `<p class="meta" style="margin:0 0 10px">${t('cw.queued_hint')}</p>` + body;
    }
    if (!view.isConnected) return;
    view.innerHTML = `
      <div class="page-head"><h1>${t('nav.cw-followups')}</h1>
        <div class="btns">${can('settings.manage') ? `<button class="btn secondary" id="b-run">${t('cw.run_now')}</button>` : ''}</div></div>
      <div class="tabs">${TABS.map((k) => `<button data-tab="${k}" class="${tab === k ? 'active' : ''}">${t('tab.' + k)}</button>`).join('')}</div>
      ${body}`;
    view.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { cw.fuTab = b.dataset.tab; after(); }));
    const call = (attr, fn) => view.querySelectorAll(`[${attr}]`).forEach((b) => (b.onclick = async () => { try { await fn(b.getAttribute(attr)); after(); } catch (e) { toast(errText(e), true); } }));
    call('data-done', (id) => api('PATCH', '/cw/followups/' + id, { status: 'done' }));
    call('data-dismiss', (id) => api('PATCH', '/cw/followups/' + id, { status: 'dismissed' }));
    call('data-sent', (id) => api('PATCH', '/cw/messages/' + id, {}));
    call('data-mcancel', async (id) => { if (!confirm(t('cw.msg_cancel_confirm'))) return; await api('POST', `/cw/messages/${id}/cancel`, {}); toast(t('cw.msg_cancelled')); });
    // "send by hand": the chat opens in a new tab, the message is then marked as sent
    view.querySelectorAll('[data-msend]').forEach((a) => a.addEventListener('click', () => {
      api('PATCH', '/cw/messages/' + a.dataset.msend, {}).then(() => { toast(t('cw.msg_marked')); after(); }).catch((e) => toast(errText(e), true));
    }));
    view.querySelectorAll('[data-medit]').forEach((b) => (b.onclick = async () => {
      let m;
      try { m = (await api('GET', '/cw/messages?status=' + tab)).find((x) => x.id === +b.dataset.medit); } catch (e) { return toast(errText(e), true); }
      if (!m) return after();
      openModal({
        title: t('cw.msg_edit_title'),
        body: `<p class="meta">${esc(m.customer_name || '')} ${esc(m.phone)} · ${esc(t('mk.' + m.kind))}</p>
          ${field(t('cw.msg_text'), `<textarea name="text" class="msg-edit" required maxlength=1000>${esc(m.text)}</textarea>`)}
          <p class="meta">${t('cw.msg_edit_hint')}</p>`,
        onSubmit: async (d) => { await api('PUT', '/cw/messages/' + m.id, { text: d.text }); toast(t('saved')); after(); },
      });
    }));
    view.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => cw.openCustomer(+b.dataset.open, after)));
    onId(view, '#b-run', async () => {
      try { const r = await api('POST', '/cw/retention/run'); toast(`${t('cw.found')}: ${r.found.reminders + r.found.offers + r.found.lostRegular}`); after(); } catch (e) { toast(errText(e), true); }
    });
  };

  // ===================================================== analytics (owner)
  V['cw-analytics'] = async (view) => {
    const B = await cw.boot();
    const today = B.today;
    const r = (cw.range = cw.range || { from: today.slice(0, 8) + '01', to: today });
    const d = await api('GET', `/cw/analytics?from=${r.from}&to=${r.to}`);
    const ads = await api('GET', '/cw/ads');
    const after = () => V['cw-analytics'](view);
    const maxDay = Math.max(1, ...d.daily.map((x) => x.revenue));
    const maxSvc = Math.max(1, ...d.by_service.map((x) => x.revenue));
    const chips = [['today', today, today], ['week', cw.addDays(today, -((new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7)), today], ['month', today.slice(0, 8) + '01', today], ['d30', cw.addDays(today, -29), today]];
    if (!view.isConnected) return; // the page was re-rendered while this request was in flight
    view.innerHTML = `
      <div class="page-head"><h1>${t('nav.cw-analytics')}</h1><button class="btn secondary" id="b-export">⬇ ${t('cw.export')}</button></div>
      <div class="stats">
        ${tile(t('cw.today'), money(d.periods.today.revenue) + `<small>${d.periods.today.cars} ${t('cw.cars_short')}</small>`)}
        ${tile(t('cw.week'), money(d.periods.week.revenue) + `<small>${d.periods.week.cars} ${t('cw.cars_short')}</small>`)}
        ${tile(t('cw.month'), money(d.periods.month.revenue) + `<small>${d.periods.month.cars} ${t('cw.cars_short')}</small>`)}
      </div>
      <div class="rangebar">
        ${chips.map(([k, f, to]) => `<button data-r="${k}" data-f="${f}" data-t="${to}" class="${r.from === f && r.to === to ? 'active' : ''}">${t('rng.' + k)}</button>`).join('')}
        <span class="dates"><input type="date" id="r-from" value="${r.from}"><span>–</span><input type="date" id="r-to" value="${r.to}"></span>
      </div>
      <div class="stats">
        ${tile(t('cw.revenue'), money(d.range.revenue))}${tile(t('cw.cars'), d.range.cars)}${tile(t('cw.avg_check'), money(d.range.avg_check))}
      </div>
      <div class="grid2">
        <div class="card"><h2>${t('cw.revenue_by_day')}</h2>
          <div class="vbars">${d.daily.map((x) => `<i title="${esc(x.date)}: ${esc(money(x.revenue))} / ${x.cars}" style="height:${Math.max(2, (x.revenue / maxDay) * 100)}%"></i>`).join('')}</div>
          <div class="axis"><span>${esc(d.from)}</span><span>${esc(d.to)}</span></div></div>
        <div class="card"><h2>${t('cw.by_service')}</h2>
          ${d.by_service.length ? d.by_service.map((s) => `<div class="bar-row"><span>${esc(s.name)}</span>${bar(s.revenue, maxSvc, 'won')}<span class="muted">${money(s.revenue)} · ${s.count}</span></div>`).join('') : `<div class="empty">${t('cw.no_data')}</div>`}</div>
        <div class="card"><h2>${t('cw.bay_load')}</h2>
          ${d.bays.map((b) => `<div class="bar-row"><span>${esc(b.name)}</span>${bar(b.utilization, 1)}<span class="muted">${cw.pct(b.utilization)} · ${b.cars}</span></div>`).join('') || `<div class="empty">${t('cw.no_data')}</div>`}</div>
        <div class="card"><h2>${t('cw.staff_load')}</h2>
          ${d.staff.map((b) => `<div class="bar-row"><span>${esc(b.name)}</span>${bar(b.utilization, 1)}<span class="muted">${cw.pct(b.utilization)} · ${b.cars} · ${money(b.revenue)}</span></div>`).join('')}
          <p class="meta">${t('cw.load_note')}</p></div>
      </div>
      <div class="card" style="margin-top:14px"><div class="page-head" style="margin-bottom:10px"><h2 style="margin:0">${t('cw.ads')}</h2><button class="btn small" id="b-ad">+ ${t('cw.add_ad')}</button></div>
        <div class="stats mini">${tile(t('cw.ad_spend'), money(d.ads.spend))}${tile(t('cw.new_clients'), d.ads.new_customers)}${tile(t('cw.cac'), d.ads.cac === null ? '—' : money(d.ads.cac))}${tile(t('cw.roi'), d.ads.roi === null ? '—' : Math.round(d.ads.roi * 100) + '%', d.ads.roi !== null && d.ads.roi < 0 ? 'bad' : '')}</div>
        ${d.ads.channels.length ? `<div class="table-wrap"><table><thead><tr><th>${t('cw.channel')}</th><th>${t('cw.ad_spend')}</th><th>${t('cw.new_clients')}</th><th>${t('cw.cac')}</th><th>${t('cw.revenue')}</th><th>${t('cw.roi')}</th></tr></thead><tbody>
          ${d.ads.channels.map((c) => `<tr><td>${esc(c.channel)}</td><td>${money(c.spend)}</td><td>${c.new_customers}</td><td>${c.cac === null ? '—' : money(c.cac)}</td><td>${money(c.revenue)}</td><td>${c.roi === null ? '—' : Math.round(c.roi * 100) + '%'}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty">${t('cw.no_ads')}</div>`}
        <p class="meta">${t('cw.ads_note')}</p>
        ${ads.length ? `<details><summary>${t('cw.ad_log')} (${ads.length})</summary>${ads.map((a) => `<div class="hrow"><div><b>${esc(a.date)}</b> ${esc(a.channel)} <span class="meta">${esc(a.note)}</span></div><div class="right-col"><b>${money(a.amount)}</b><button class="btn secondary small danger-t" data-delad="${a.id}">✕</button></div></div>`).join('')}</details>` : ''}
      </div>`;
    onId(view, '#b-export', () => cw.openExport(cw.range));
    const setRange = (from, to) => { cw.range = { from, to }; after(); };
    view.querySelectorAll('[data-r]').forEach((b) => (b.onclick = () => setRange(b.dataset.f, b.dataset.t)));
    $('#r-from').onchange = (e) => e.target.value && setRange(e.target.value, $('#r-to').value);
    $('#r-to').onchange = (e) => e.target.value && setRange($('#r-from').value, e.target.value);
    $('#b-ad').onclick = () => openModal({
      title: t('cw.add_ad'),
      body: `${field(t('cw.date'), input('date', today, 'type=date required'))}
        ${field(t('cw.channel'), `<input name="channel" list="chlist" required maxlength=60><datalist id="chlist">${B.settings.channels.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`)}
        ${field(t('cw.amount'), input('amount', '', 'type=number min=0 step=any required inputmode=decimal'))}${field(t('notes'), input('note', '', 'maxlength=300'))}`,
      onSubmit: async (x) => { await api('POST', '/cw/ads', x); toast(t('saved')); after(); },
    });
    view.querySelectorAll('[data-delad]').forEach((b) => (b.onclick = async () => { if (confirm(t('confirmDelete'))) { await api('DELETE', '/cw/ads/' + b.dataset.delad); after(); } }));
  };

  // ===================================================== staff & quality (owner)
  V['cw-staff'] = async (view) => {
    const B = await cw.boot();
    const r = (cw.range = cw.range || { from: B.today.slice(0, 8) + '01', to: B.today });
    const [st, complaints] = await Promise.all([api('GET', `/cw/staff-stats?from=${r.from}&to=${r.to}`), api('GET', '/cw/complaints?status=all')]);
    const after = () => V['cw-staff'](view);
    if (!view.isConnected) return; // the page was re-rendered while this request was in flight
    view.innerHTML = `
      <div class="page-head"><h1>${t('nav.cw-staff')}</h1><button class="btn secondary" id="b-export">⬇ ${t('cw.export')}</button></div>
      <div class="rangebar"><span class="dates"><input type="date" id="r-from" value="${r.from}"><span>–</span><input type="date" id="r-to" value="${r.to}"></span></div>
      <div class="card table-wrap"><table><thead><tr><th>${t('cw.employee')}</th><th>${t('cw.assigned')}</th><th>${t('cw.done_n')}</th><th>${t('cw.accepted_n')}</th><th>${t('cw.avg_plan')}</th><th>${t('cw.avg_fact')}</th><th>${t('cw.efficiency')}</th><th>${t('cw.revenue')}</th><th>${t('cw.complaints')}</th><th>${t('cw.reworks')}</th></tr></thead><tbody>
        ${st.staff.map((u) => `<tr><td><b>${esc(u.name)}</b></td><td>${u.assigned}</td><td>${u.done}</td><td>${u.accepted}</td><td>${u.avg_planned === null ? '—' : u.avg_planned + t('cw.min')}</td><td>${u.avg_actual === null ? '—' : u.avg_actual + t('cw.min')}</td>
          <td class="${u.efficiency !== null && u.efficiency < 0.85 ? 'bad-t' : ''}">${u.efficiency === null ? '—' : Math.round(u.efficiency * 100) + '%'}</td><td>${money(u.revenue)}</td><td class="${u.complaints ? 'bad-t' : ''}">${u.complaints}</td><td class="${u.reworks ? 'bad-t' : ''}">${u.reworks}</td></tr>`).join('')}</tbody></table></div>
      <p class="meta">${t('cw.eff_note')}</p>
      <div class="card"><h2>${t('cw.complaints_list')}</h2>
        ${complaints.length ? complaints.map((c) => `<div class="hrow"><div><b>${esc(t('ctype.' + c.type))}</b> ${c.plate ? `<span class="plate">${esc(c.plate)}</span>` : ''} ${esc(c.customer_name || '')}
          <div class="meta">${esc(c.text)}</div><div class="meta">${esc(c.staff_name || '—')} · ${esc((c.created_at || '').slice(0, 16))}</div></div>
          <div class="right-col">${c.resolved ? `<span class="chip ok">${t('cw.resolved')}</span>` : !can('complaints.resolve') ? '' : `<button class="btn secondary small" data-res="${c.id}">${t('cw.resolve')}</button>`}</div></div>`).join('') : `<div class="empty">${t('cw.no_complaints')}</div>`}</div>`;
    const setRange = (from, to) => { cw.range = { from, to }; after(); };
    onId(view, '#b-export', () => cw.openExport(cw.range));
    $('#r-from').onchange = (e) => e.target.value && setRange(e.target.value, $('#r-to').value);
    $('#r-to').onchange = (e) => e.target.value && setRange($('#r-from').value, e.target.value);
    view.querySelectorAll('[data-res]').forEach((b) => (b.onclick = async () => { await api('PATCH', '/cw/complaints/' + b.dataset.res, { resolved: true }); after(); }));
  };

  // ===================================================== settings (owner)
  V['cw-settings'] = async (view) => {
    const B = await cw.boot();
    const sts = await api('GET', '/cw/statuses');
    const s = B.settings;
    const R = s.retention;
    const after = () => V['cw-settings'](view);
    const chk = (name, on) => `<label class="check one"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}><span></span></label>`;
    const row = (label, inner) => `<div class="setrow"><label>${label}</label>${inner}</div>`;
    if (!view.isConnected) return; // the page was re-rendered while this request was in flight
    view.innerHTML = `
      <div class="page-head"><h1>${t('nav.cw-settings')}</h1></div>
      <div class="grid2">
        <div class="card"><h2>${t('cw.services_list')}</h2>
          ${B.services.map((x) => `<form class="svc-row" data-svc="${x.id}">
            <div class="wide">${input('name', x.name, 'required maxlength=100 aria-label="' + esc(t('cw.service_name')) + '"')}</div>
            <label class="mini"><small>${t('cw.price')}</small><input name="price" type="number" min="0" step="any" value="${x.price}" inputmode="decimal"></label>
            <label class="mini"><small>${t('cw.minutes')}</small><input name="duration_min" type="number" min="5" max="720" value="${x.duration_min}" inputmode="numeric"></label>
            <div class="row-foot"><label class="check one"><input type="checkbox" name="active" ${x.active ? 'checked' : ''}><span>${t('cw.active')}</span></label>
              <div class="row-btns"><button class="btn small">${t('save')}</button><button type="button" class="btn secondary small danger-t" data-delsvc="${x.id}" aria-label="${esc(t('delete'))}">✕</button></div></div></form>`).join('')}
          <form class="svc-row new" data-svc="new">
            <div class="wide">${input('name', '', 'required maxlength=100 placeholder="' + esc(t('cw.service_name')) + '"')}</div>
            <label class="mini"><small>${t('cw.price')}</small><input name="price" type="number" min="0" step="any" inputmode="decimal" placeholder="0"></label>
            <label class="mini"><small>${t('cw.minutes')}</small><input name="duration_min" type="number" min="5" max="720" value="30" inputmode="numeric"></label>
            <div class="row-foot"><span></span><div class="row-btns"><button class="btn small">+ ${t('add')}</button></div></div></form>
          <p class="meta">${t('cw.services_hint')}</p></div>
        <div class="card"><h2>${t('cw.bays_list')}</h2>
          ${B.bays.map((x) => `<form class="bay-row" data-bay="${x.id}">
            <div class="wide">${input('name', x.name, 'required maxlength=60 aria-label="' + esc(t('cw.bay_name')) + '"')}</div>
            <div class="row-foot"><label class="check one"><input type="checkbox" name="active" ${x.active ? 'checked' : ''}><span>${t('cw.active')}</span></label>
              <div class="row-btns"><button class="btn small">${t('save')}</button><button type="button" class="btn secondary small danger-t" data-delbay="${x.id}" aria-label="${esc(t('delete'))}">✕</button></div></div></form>`).join('')}
          <form class="bay-row new" data-bay="new">
            <div class="wide">${input('name', '', 'required maxlength=60 placeholder="' + esc(t('cw.bay_name')) + '"')}</div>
            <div class="row-foot"><span></span><div class="row-btns"><button class="btn small">+ ${t('add')}</button></div></div></form></div>

        <div class="card"><h2>${t('cw.statuses_list')}</h2>
          <p class="meta" style="margin-top:0">${t('cw.statuses_hint')}</p>
          ${sts.map((x) => `<form class="st-row" data-st="${x.id}">
            <input type="color" name="color" value="${esc(x.color)}" aria-label="${esc(t('cw.status_color'))}">
            ${input('name', x.name, 'required maxlength=40 aria-label="' + esc(t('cw.status_name')) + '"')}
            <div class="row-foot"><span class="meta">${x.customers} ${t('cw.clients_short')}</span>
              <div class="row-btns"><button class="btn small">${t('save')}</button><button type="button" class="btn secondary small danger-t" data-delst="${x.id}" data-n="${x.customers}" aria-label="${esc(t('delete'))}">✕</button></div></div></form>`).join('')}
          <form class="st-row new" data-st="new">
            <input type="color" name="color" value="#2563eb" aria-label="${esc(t('cw.status_color'))}">
            ${input('name', '', 'required maxlength=40 placeholder="' + esc(t('cw.status_name')) + '"')}
            <div class="row-foot"><span></span><div class="row-btns"><button class="btn small">+ ${t('add')}</button></div></div></form></div>

        <form class="card" id="f-general"><h2>${t('cw.general')}</h2>
          ${row(t('cw.open_time'), input('open_time', s.open_time, 'type=time required'))}${row(t('cw.close_time'), input('close_time', s.close_time, 'type=time required'))}
          ${row(t('cw.break_time'), `<div class="row">${input('break_from', s.break_from || '', 'type=time')}${input('break_to', s.break_to || '', 'type=time')}</div>`)}
          <p class="meta">${t('cw.break_note')}</p>
          ${row(t('cw.slot'), select('slot_minutes', [10, 15, 20, 30, 60].map((x) => [x, x + ' ' + t('cw.min')]), s.slot_minutes))}
          ${row(t('cw.msg_lang'), select('language', [['ru', 'Русский'], ['kk', 'Қазақша'], ['en', 'English']], s.language))}
          ${row(t('cw.channels'), `<textarea name="channels" rows="4" placeholder="${esc(t('cw.channels_ph'))}">${esc(s.channels.join('\n'))}</textarea>`)}
          <button class="btn">${t('save')}</button></form>

        <form class="card" id="f-loyalty"><h2>${t('cw.loyalty')}</h2>
          ${row(t('cw.loy_on'), chk('enabled', s.loyalty.enabled))}${row(t('cw.loy_every'), input('every', s.loyalty.every, 'type=number min=2 max=100 inputmode=numeric'))}
          ${row(t('cw.loy_cap'), input('max_free_price', s.loyalty.max_free_price || 0, 'type=number min=0 step=any inputmode=decimal'))}
          <p class="meta">${t('cw.loy_hint')}</p><button class="btn">${t('save')}</button></form>

        <form class="card wide" id="f-ret"><h2>${t('cw.retention')}</h2>
          <p class="meta">${t('cw.ret_hint')}</p>
          ${row(t('cw.auto_send'), chk('auto_send', R.auto_send))}
          <div class="subcard"><b>${t('cw.ret_reminder')}</b>${row(t('cw.enabled'), chk('reminder_enabled', R.reminder.enabled))}${row(t('cw.after_days'), input('reminder_days', R.reminder.days, 'type=number min=1 max=365 inputmode=numeric'))}</div>
          <div class="subcard"><b>${t('cw.ret_offer')}</b>${row(t('cw.enabled'), chk('offer_enabled', R.offer.enabled))}${row(t('cw.after_days'), input('offer_days', R.offer.days, 'type=number min=1 max=365 inputmode=numeric'))}${row(t('cw.offer_text'), input('offer_text', R.offer.text, 'maxlength=200'))}</div>
          <div class="subcard"><b>${t('cw.ret_regular')}</b>${row(t('cw.enabled'), chk('regular_enabled', R.regular.enabled))}${row(t('cw.reg_min'), input('regular_min_visits', R.regular.min_visits, 'type=number min=2 max=50 inputmode=numeric'))}
            ${row(t('cw.reg_gap'), input('regular_gap', R.regular.usual_gap_days, 'type=number min=1 max=60 inputmode=numeric'))}${row(t('cw.reg_factor'), input('regular_factor', R.regular.miss_factor, 'type=number min=1.2 max=10 step=0.1 inputmode=decimal'))}</div>
          <div class="subcard"><b>${t('cw.ret_review')}</b>${row(t('cw.enabled'), chk('review_enabled', R.review.enabled))}${row(t('cw.review_delay'), input('review_delay', R.review.delay_min, 'type=number min=0 max=1440 inputmode=numeric'))}${row(t('cw.review_link'), input('review_link', R.review.link, 'type=url maxlength=300 placeholder="https://..."'))}</div>
          ${row(t('cw.send_window'), `<div class="row">${input('send_from', R.send_from, 'type=time')}${input('send_to', R.send_to, 'type=time')}</div>`)}
          <button class="btn">${t('save')}</button></form>

        <div class="card"><h2>WhatsApp</h2>
          <p>${s.whatsapp.configured ? `<span class="chip ok">${t('cw.wa_on')}</span>` : `<span class="chip warn">${t('cw.wa_off')}</span>`}</p>
          <p class="meta">${s.whatsapp.configured ? t('cw.wa_templates') + ': ' + (s.whatsapp.templates.map((k) => t('mk.' + k)).join(', ') || '—') : t('cw.wa_off_hint')}</p></div>
      </div>`;
    const save = async (fn, okMsg) => { try { await fn(); toast(okMsg || t('saved')); after(); } catch (e) { toast(errText(e), true); } };
    view.querySelectorAll('.svc-row').forEach((f) => (f.onsubmit = (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f).entries());
      const body = { name: d.name, price: d.price || 0, duration_min: d.duration_min || 30, active: !!d.active || f.dataset.svc === 'new' };
      save(() => (f.dataset.svc === 'new' ? api('POST', '/cw/services', body) : api('PUT', '/cw/services/' + f.dataset.svc, body)));
    }));
    view.querySelectorAll('[data-delsvc]').forEach((b) => (b.onclick = () => confirm(t('confirmDelete')) && save(() => api('DELETE', '/cw/services/' + b.dataset.delsvc))));
    view.querySelectorAll('.bay-row').forEach((f) => (f.onsubmit = (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f).entries());
      const body = { name: d.name, active: !!d.active || f.dataset.bay === 'new' };
      save(() => (f.dataset.bay === 'new' ? api('POST', '/cw/bays', body) : api('PUT', '/cw/bays/' + f.dataset.bay, body)));
    }));
    view.querySelectorAll('[data-delbay]').forEach((b) => (b.onclick = () => confirm(t('confirmDelete')) && save(() => api('DELETE', '/cw/bays/' + b.dataset.delbay))));
    view.querySelectorAll('.st-row').forEach((f) => (f.onsubmit = (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f).entries());
      save(() => (f.dataset.st === 'new' ? api('POST', '/cw/statuses', d) : api('PUT', '/cw/statuses/' + f.dataset.st, d)));
    }));
    view.querySelectorAll('[data-delst]').forEach((b) => (b.onclick = () => confirm(+b.dataset.n ? t('cw.status_delete_used').replace('{n}', b.dataset.n) : t('confirmDelete')) && save(() => api('DELETE', '/cw/statuses/' + b.dataset.delst))));
    const form = (id, fn) => ($(id).onsubmit = (e) => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target).entries()); save(() => api('PUT', '/cw/settings', fn(d))); });
    form('#f-general', (d) => ({ open_time: d.open_time, close_time: d.close_time, break_from: d.break_from || '', break_to: d.break_to || '', slot_minutes: d.slot_minutes, language: d.language, channels: d.channels.split('\n') }));
    form('#f-loyalty', (d) => ({ loyalty: { enabled: !!d.enabled, every: d.every, max_free_price: d.max_free_price } }));
    form('#f-ret', (d) => ({ retention: {
      auto_send: !!d.auto_send,
      reminder: { enabled: !!d.reminder_enabled, days: d.reminder_days },
      offer: { enabled: !!d.offer_enabled, days: d.offer_days, text: d.offer_text },
      regular: { enabled: !!d.regular_enabled, min_visits: d.regular_min_visits, usual_gap_days: d.regular_gap, miss_factor: d.regular_factor },
      review: { enabled: !!d.review_enabled, delay_min: d.review_delay, link: d.review_link },
      send_from: d.send_from, send_to: d.send_to,
    } }));
  };
})();
