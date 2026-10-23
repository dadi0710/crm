// Car wash template: shared helpers and the main dialogs (visit, booking, customer).
(() => {
  const { $, esc, state, t, api, errText, toast, openModal, field, input, select, money, can } = CRM;
  const cw = (CRM.cw = {});

  // ---------- small helpers ----------
  const pad = (n) => String(n).padStart(2, '0');
  cw.boot = async () => (cw.B = await api('GET', '/cw/bootstrap'));
  cw.addDays = (d, n) => {
    const x = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n));
    return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
  };
  cw.dayLabel = (d) =>
    CRM.fmtDate(new Date(d + 'T00:00:00Z'), { weekday: 'short', day: 'numeric', month: 'short' }, 'UTC');
  cw.hm = (dt) => (dt || '').slice(11, 16);
  cw.min = (dt) => +dt.slice(11, 13) * 60 + +dt.slice(14, 16);
  cw.fmtMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  cw.dur = (m) => (m >= 60 ? `${Math.floor(m / 60)}${t('cw.h')}${m % 60 ? ' ' + (m % 60) + t('cw.min') : ''}` : `${m}${t('cw.min')}`);
  // Excel export for a chosen period (the server only includes the sheets this user may see)
  cw.openExport = (range) => {
    const today = (cw.B || {}).today || '';
    const r = range || { from: today.slice(0, 8) + '01', to: today };
    openModal({
      title: t('cw.export_title'),
      submitLabel: t('cw.export_download'),
      body: `<p class="meta" style="margin-top:0">${t('cw.export_hint')}</p>
        <div class="row">${field(t('cw.export_from'), input('from', r.from, 'type=date required'))}${field(t('cw.export_to'), input('to', r.to, 'type=date required'))}</div>`,
      onSubmit: async (d) => {
        if (!d.from || !d.to || d.from > d.to) throw Object.assign(new Error('bad_period'), { code: 'bad_period' });
        const a = document.createElement('a');
        a.href = `/api/cw/export?from=${encodeURIComponent(d.from)}&to=${encodeURIComponent(d.to)}&lang=${state.lang}`;
        a.download = '';
        document.body.appendChild(a); a.click(); a.remove();
      },
    });
  };
  cw.pct = (x) => (x === null || x === undefined ? '—' : Math.round(x * 100) + '%');
  cw.STATUSES = ['new', 'confirmed', 'arrived', 'in_progress', 'done', 'cancelled'];
  cw.chip = (st) => `<span class="chip st-${st}">${esc(t('st.' + st))}</span>`;
  cw.carName = (v) => [v.make, v.model].filter(Boolean).join(' ');
  cw.title = (v) => v.plate || v.customer_name || t('cw.anon');
  cw.svcNames = (v) => (v.services || []).map((s) => s.name).join(', ');
  cw.closeModal = () => ($('#modal-root').innerHTML = '');
  cw.fail = (code) => Object.assign(new Error(code), { code });

  cw.visitCard = (v, extra = '') => `
    <div class="vcard st-${v.status}" data-vid="${v.id}">
      <div class="vtime">${esc(cw.hm(v.scheduled_start))}${v.delay_minutes ? `<small class="late">+${v.delay_minutes}</small>` : ''}</div>
      <div class="vbody">
        <div><b>${esc(cw.title(v))}</b> ${esc(cw.carName(v))}${v.is_rework ? ` <span class="chip warn">${t('cw.rework')}</span>` : ''}${v.kind === 'walkin' ? ` <span class="chip">${t('cw.walkin_short')}</span>` : ''}</div>
        <div class="meta">${esc(v.customer_name && v.plate ? v.customer_name + ' · ' : '')}${esc(cw.svcNames(v))} · ${cw.dur(v.duration_min)}${v.bay_name ? ' · ' + esc(v.bay_name) : ''}${v.staff_name ? ' · ' + esc(v.staff_name) : ''}</div>
        ${extra}
      </div>
      ${cw.chip(v.status)}
    </div>`;
  cw.bindCards = (root, after) => root.querySelectorAll('[data-vid]').forEach((el) => (el.onclick = () => cw.openVisit(+el.dataset.vid, after)));

  // Same working-hours rule as the server (the server is the judge); gives the dialog an instant answer.
  cw.hoursError = (dt, duration) => {
    const S = (cw.B || {}).settings || {};
    const m = (x) => (/^\d{2}:\d{2}$/.test(x || '') ? +x.slice(0, 2) * 60 + +x.slice(3) : null);
    const from = m(dt.slice(11, 16)), to = from + (duration || 0), open = m(S.open_time), close = m(S.close_time);
    const err = (code) => Object.assign(new Error(code), { code, data: { open_time: S.open_time, close_time: S.close_time, break_from: S.break_from, break_to: S.break_to } });
    if (open !== null && from < open) return err('before_open');
    if (close !== null && to > close) return err('after_close');
    const bf = m(S.break_from), bt = m(S.break_to);
    if (bf !== null && bt !== null && bt > bf && from < bt && to > bf) return err('in_break');
    return null;
  };

  const bayOptions = (withNone = true) => [...(withNone ? [['', t('cw.no_bay')]] : []), ...cw.B.bays.filter((b) => b.active).map((b) => [b.id, b.name])];
  const dateTimeInputs = (dt) => {
    const S = (cw.B || {}).settings || {};
    return `<div class="row">${field(t('cw.date'), input('date', dt.slice(0, 10), 'type=date required'))}${field(t('cw.time'), input('time', dt.slice(11, 16), `type=time required min="${S.open_time || ''}" max="${S.close_time || ''}"`))}</div>
      <p class="meta hours-hint">${t('cw.hours_hint').replace('{open}', S.open_time || '').replace('{close}', S.close_time || '')}${S.break_from ? ' ' + t('cw.break_hint').replace('{from}', S.break_from).replace('{to}', S.break_to) : ''}</p>`;
  };

  // ---------- booking / walk-in dialog ----------
  cw.openBooking = async (o = {}) => {
    const B = cw.B || (await cw.boot());
    const edit = o.visit || null;
    const kind = edit ? edit.kind : o.kind || 'booking';
    const services = B.services.filter((s) => s.active || (edit && (edit.services || []).some((x) => x.service_id === s.id)));
    const slot = B.settings.slot_minutes || 30;
    const nowMin = cw.min(B.now);
    const defMin = Math.min(23 * 60 + 30, Math.ceil(nowMin / slot) * slot);
    const startDT = edit ? edit.scheduled_start : `${o.date || B.today} ${o.time || cw.fmtMin(defMin)}`;
    const chosen = new Set(edit ? edit.services.map((s) => s.service_id) : o.service_ids || []);
    let found = null;
    let formRef = null;

    const body = `
      ${
        edit
          ? `<p><b>${esc(cw.title(edit))}</b> ${esc(cw.carName(edit))} ${edit.customer_name ? '· ' + esc(edit.customer_name) : ''}</p>`
          : `${field(t('cw.plate'), input('plate', o.plate || '', 'autocapitalize=characters autocomplete=off maxlength=15 placeholder="ABC 1234" autofocus'))}
             <div id="lk"></div>
             <div id="newc">
               <div class="row">${field(t('name'), input('name', '', 'maxlength=150'))}${field(t('cw.phone_wa'), input('phone', '', 'type=tel inputmode=tel maxlength=40'))}</div>
               <div class="row">${field(t('cw.make'), input('make', '', 'maxlength=60'))}${field(t('cw.model'), input('model', '', 'maxlength=60'))}</div>
               ${field(t('cw.source'), select('source', [['', t('none')], ...B.settings.channels.map((c) => [c, c])], ''))}
             </div>`
      }
      <div class="field"><label>${t('cw.services')}</label>
        <div class="svc-list">${services
          .map(
            (s) => `<label class="check"><input type="checkbox" name="svc" value="${s.id}" data-price="${s.price}" data-dur="${s.duration_min}" ${chosen.has(s.id) ? 'checked' : ''}>
              <span>${esc(s.name)}</span><small>${money(s.price)} · ${cw.dur(s.duration_min)}</small></label>`
          )
          .join('')}</div>
        <div id="sum" class="sum"></div>
      </div>
      ${kind === 'booking' || edit ? dateTimeInputs(startDT) : ''}
      <div class="row">
        ${field(t('cw.bay'), select('bay_id', bayOptions(), edit ? edit.bay_id : o.bay_id))}
        ${
          can('visits.edit')
            ? field(t('cw.staff'), select('staff_id', [['', t('none')], ...B.users.map((u) => [u.id, u.name])], edit ? edit.staff_id : ''))
            : `<div class="field"><label>${t('cw.staff')}</label><label class="check one"><input type="checkbox" name="me" ${edit && edit.staff_id === state.user.id ? 'checked' : ''}><span>${t('cw.me_staff')}</span></label></div>`
        }
      </div>
      ${can('visits.edit') ? field(t('cw.discount_override'), input('discount_percent', edit ? edit.discount_percent : '', 'type=number min=0 max=100 step=any inputmode=decimal placeholder="%"')) : ''}
      ${field(t('notes'), `<textarea name="notes" maxlength=2000>${esc(edit ? edit.notes : '')}</textarea>`)}`;

    const updateSum = () => {
      const f = formRef;
      if (!f) return;
      const on = [...f.querySelectorAll('input[name=svc]:checked')];
      const price = on.reduce((a, x) => a + Number(x.dataset.price), 0);
      const dur = on.reduce((a, x) => a + Number(x.dataset.dur), 0);
      const disc = found ? found.customer.discount_percent : 0;
      $('#sum', f).innerHTML = on.length
        ? `${t('cw.total')}: <b>${money(price * (1 - disc / 100))}</b>${disc ? ` <small>(−${disc}%)</small>` : ''} · ${cw.dur(dur)}`
        : `<span class="muted">${t('cw.pick_service')}</span>`;
    };

    let timer;
    const lookup = async (f) => {
      const plate = f.plate.value.trim();
      const lk = $('#lk', f);
      const newc = $('#newc', f);
      found = null;
      if (plate.length < 2) { lk.innerHTML = ''; newc.hidden = false; updateSum(); return; }
      try {
        const r = await api('GET', '/cw/cars/lookup?plate=' + encodeURIComponent(plate));
        if (r.found) {
          found = r;
          const l = r.loyalty;
          const loy = l.enabled ? (l.next_free ? `<span class="chip ok">★ ${t('cw.next_free')}</span>` : `<span class="chip">★ ${l.progress}/${l.every}</span>`) : '';
          lk.innerHTML = `<div class="found"><b>${esc(r.customer.name)}</b> ${esc(r.car.make)} ${esc(r.car.model)} ${loy}
            <div class="meta">${esc(r.customer.phone || r.customer.whatsapp || '')} · ${t('cw.visits')}: ${r.customer.visits} · ${t('cw.avg')}: ${money(r.customer.avg_check)}${r.customer.discount_percent ? ` · −${r.customer.discount_percent}%` : ''}</div>
            ${r.customer.preferences ? `<div class="meta">${esc(r.customer.preferences)}</div>` : ''}</div>`;
          newc.hidden = true;
        } else {
          lk.innerHTML = `<div class="meta">${t('cw.new_client')}</div>`;
          newc.hidden = false;
        }
      } catch { /* ignore lookup errors */ }
      updateSum();
    };

    openModal({
      title: edit ? t('cw.edit_visit') : kind === 'walkin' ? t('cw.new_walkin') : t('cw.new_booking'),
      submitLabel: edit ? t('save') : kind === 'walkin' ? t('cw.accept_car') : t('cw.book'),
      wide: true,
      body,
      onOpen: (form) => {
        formRef = form;
        form.querySelectorAll('input[name=svc]').forEach((x) => (x.onchange = updateSum));
        if (!edit) {
          form.plate.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => lookup(form), 350); });
          if (o.plate) lookup(form);
        }
        updateSum();
      },
      onSubmit: async (d) => {
        const f = formRef;
        const ids = [...f.querySelectorAll('input[name=svc]:checked')].map((x) => +x.value);
        if (!ids.length) throw cw.fail('no_services');
        const payload = { service_ids: ids, bay_id: d.bay_id || null, notes: d.notes || '' };
        payload.staff_id = can('visits.edit') ? d.staff_id || null : f.querySelector('[name=me]').checked ? state.user.id : null;
        if (can('visits.edit') && d.discount_percent !== undefined && d.discount_percent !== '') payload.discount_percent = d.discount_percent;
        if (edit || kind === 'booking') {
          payload.scheduled_start = `${d.date} ${d.time}`;
          if (!edit || edit.kind === 'booking') {
            const dur = d.duration_min ? Number(d.duration_min) : ids.reduce((a, id) => a + ((B.services.find((x) => x.id === id) || {}).duration_min || 0), 0);
            const bad = cw.hoursError(payload.scheduled_start, dur);
            if (bad) throw bad;
          }
        }
        if (!edit) {
          payload.kind = kind;
          if (found) payload.car_id = found.car.id;
          else payload.quick = { plate: d.plate, name: d.name, phone: d.phone, make: d.make, model: d.model, source: d.source };
        }
        const send = (extra) => (edit ? api('PUT', '/cw/visits/' + edit.id, { ...payload, ...extra }) : api('POST', '/cw/visits', { ...payload, ...extra }));
        try {
          await send();
        } catch (e) {
          if (e.code === 'bay_busy' && confirm(t('cw.bay_busy_confirm'))) await send({ force: true });
          else throw e;
        }
        toast(t('saved'));
        (o.after || CRM.refresh)();
      },
    });
  };

  // ---------- visit dialog ----------
  cw.openVisit = async (id, after) => {
    const B = cw.B || (await cw.boot());
    let v;
    try { v = await api('GET', '/cw/visits/' + id); } catch (e) { return toast(errText(e), true); }
    const done = () => (after || CRM.refresh)();
    const run = async (fn) => {
      try { await fn(); cw.closeModal(); done(); } catch (e) { if (e.code) toast(errText(e), true); }
    };
    const closed = v.status === 'done' || v.status === 'cancelled';
    const work = can('visits.work') || can('visits.edit');
    const next = { new: 'confirmed', confirmed: 'arrived', arrived: 'in_progress', in_progress: 'done' }[v.status];
    const nextLabel = { confirmed: 'cw.act_confirm', arrived: 'cw.act_arrived', in_progress: 'cw.act_start', done: 'cw.act_finish' }[next];
    const lo = v.loyalty;
    const actual = v.started_at && v.finished_at ? Math.max(0, cw.min(v.finished_at) - cw.min(v.started_at)) : null;

    const setStatus = async (status) => {
      let bay_id;
      if (status === 'in_progress' && !v.bay_id && B.bays.some((b) => b.active)) {
        const q = await api('GET', '/cw/queue');
        const busy = new Set(q.in_progress.map((x) => x.bay_id));
        const freeBay = B.bays.find((b) => b.active && !busy.has(b.id));
        bay_id = await new Promise((resolve) =>
          openModal({
            title: t('cw.pick_bay'),
            body: field(t('cw.bay'), select('bay_id', bayOptions(), freeBay ? freeBay.id : '')),
            submitLabel: t('cw.act_start'),
            onSubmit: async (d) => resolve(d.bay_id || null),
          })
        );
      }
      const r = await api('PATCH', `/cw/visits/${v.id}/status`, { status, ...(bay_id !== undefined ? { bay_id } : {}) });
      if (r.is_free) toast(t('cw.free_given'));
    };

    const body = `
      <div class="vhead"><div><b>${esc(cw.title(v))}</b> ${esc(cw.carName(v))}<div class="meta">${esc(v.customer_name || '')} ${v.customer_phone ? '· ' + esc(v.customer_phone) : ''}</div></div>${cw.chip(v.status)}</div>
      <div class="kv">
        <div><span>${t('cw.when')}</span><b>${esc(cw.dayLabel(v.scheduled_start.slice(0, 10)))}, ${esc(cw.hm(v.scheduled_start))}${v.delay_minutes ? ` <span class="late">(+${v.delay_minutes} ${t('cw.min')})</span>` : ''}</b></div>
        <div><span>${t('cw.bay')}</span><b>${esc(v.bay_name || '—')}</b></div>
        <div><span>${t('cw.staff')}</span><b>${esc(v.staff_name || '—')}</b></div>
        <div><span>${t('cw.accepted_by')}</span><b>${esc(v.accepted_name || '—')}</b></div>
      </div>
      <ul class="lines">${v.services.map((s) => `<li><span>${esc(s.name)}</span><b>${v.is_rework ? '—' : money(s.price)}</b></li>`).join('')}
        <li class="tot"><span>${t('cw.total')}${v.discount_percent ? ` (−${v.discount_percent}%)` : ''}${v.is_free ? ` · <span class="chip ok">${t('cw.free')}</span>` : ''}</span><b>${money(v.final_price)}</b></li></ul>
      ${lo && lo.enabled && v.status !== 'done' && !v.is_rework ? `<div class="meta">${lo.next_free ? '★ ' + t('cw.next_free') : `★ ${t('cw.loyalty')}: ${lo.progress}/${lo.every}`}</div>` : ''}
      ${v.arrived_at || v.started_at || v.finished_at ? `<div class="meta">${v.arrived_at ? t('cw.arrived_at') + ' ' + cw.hm(v.arrived_at) : ''}${v.started_at ? ' · ' + t('cw.started_at') + ' ' + cw.hm(v.started_at) : ''}${v.finished_at ? ' · ' + t('cw.finished_at') + ' ' + cw.hm(v.finished_at) : ''}${actual !== null ? ` · ${t('cw.actual')} ${cw.dur(actual)} / ${t('cw.plan')} ${cw.dur(v.duration_min)}` : ''}</div>` : ''}
      ${v.complaints.length ? `<div class="warnbox">${v.complaints.map((c) => `<div>⚠ ${esc(t('ctype.' + c.type))}: ${esc(c.text)}</div>`).join('')}</div>` : ''}
      <div class="actions" id="acts">
        ${next && work ? `<button type="button" class="btn big" data-a="next">${t(nextLabel)}</button>` : ''}
        ${!closed && work ? `<button type="button" class="btn secondary" data-a="me">${v.staff_id === state.user.id ? t('cw.unassign_me') : t('cw.assign_me')}</button>` : ''}
        ${!closed && work ? `<button type="button" class="btn secondary" data-a="delay">${t('cw.delay')}</button><button type="button" class="btn secondary" data-a="resched">${t('cw.resched')}</button>` : ''}
        ${work && v.status === 'done' && !v.is_rework ? `<button type="button" class="btn secondary" data-a="rework">${t('cw.redo')}</button>` : ''}
        ${work ? `<button type="button" class="btn secondary" data-a="complaint">${t('cw.complaint')}</button>` : ''}
        ${!closed && work ? `<button type="button" class="btn secondary danger-t" data-a="cancel">${t('cw.cancel_visit')}</button>` : ''}
      </div>
      ${can('visits.edit') ? field(t('cw.status'), select('status', cw.STATUSES.map((s) => [s, t('st.' + s)]), v.status)) : ''}
      ${field(t('notes'), `<textarea name="notes" maxlength=2000 ${work ? '' : 'disabled'}>${esc(v.notes || '')}</textarea>`)}`;

    openModal({
      title: t('cw.visit'),
      hideSubmit: !work,
      wide: true,
      body,
      submitLabel: t('save'),
      extraActions: can('visits.edit') ? `<button type="button" class="btn secondary" data-a="edit">${t('edit')}</button>` : '',
      onDelete: can('visits.delete') ? async () => { await api('DELETE', '/cw/visits/' + v.id); done(); } : null,
      onSubmit: async (d) => {
        if (d.notes !== (v.notes || '')) await api('PATCH', `/cw/visits/${v.id}/notes`, { notes: d.notes });
        if (can('visits.edit') && d.status && d.status !== v.status) await api('PATCH', `/cw/visits/${v.id}/status`, { status: d.status });
        done();
      },
      onOpen: (form) => {
        const on = (a, fn) => { const b = form.querySelector(`[data-a=${a}]`); if (b) b.onclick = fn; };
        on('next', () => run(() => setStatus(next)));
        on('me', () => run(() => api('PATCH', `/cw/visits/${v.id}/assign`, { staff_id: v.staff_id === state.user.id ? null : state.user.id })));
        on('cancel', () => confirm(t('cw.cancel_confirm')) && run(() => setStatus('cancelled')));
        on('edit', () => cw.openBooking({ visit: v, after: after }));
        on('delay', () =>
          openModal({
            title: t('cw.delay'),
            body: `${field(t('cw.delay_min'), input('minutes', 15, 'type=number min=1 max=600 required inputmode=numeric'))}
                   <label class="check one"><input type="checkbox" name="notify" checked><span>${t('cw.notify_client')}</span></label>`,
            onSubmit: async (d) => { const r = await api('POST', `/cw/visits/${v.id}/delay`, { minutes: d.minutes, notify: !!d.notify }); toast(r.notified ? t('cw.notified') : t('saved')); done(); },
          }));
        on('resched', () =>
          openModal({
            title: t('cw.resched'),
            body: `${dateTimeInputs(v.scheduled_start)}${field(t('cw.bay'), select('bay_id', bayOptions(), v.bay_id))}
                   <label class="check one"><input type="checkbox" name="notify" checked><span>${t('cw.notify_client')}</span></label>`,
            onSubmit: async (d) => {
              if (v.kind === 'booking') { const bad = cw.hoursError(`${d.date} ${d.time}`, v.duration_min); if (bad) throw bad; }
              const send = (extra) => api('PATCH', `/cw/visits/${v.id}/reschedule`, { scheduled_start: `${d.date} ${d.time}`, bay_id: d.bay_id || null, notify: !!d.notify, ...extra });
              let r;
              try { r = await send(); } catch (e) { if (e.code === 'bay_busy' && confirm(t('cw.bay_busy_confirm'))) r = await send({ force: true }); else throw e; }
              toast(r.notified ? t('cw.notified') : t('saved'));
              done();
            },
          }));
        on('complaint', () =>
          openModal({
            title: t('cw.complaint'),
            body: field(t('cw.complaint_text'), '<textarea name="text" required maxlength=1000></textarea>'),
            onSubmit: async (d) => { await api('POST', '/cw/complaints', { visit_id: v.id, text: d.text }); toast(t('saved')); done(); },
          }));
        on('rework', () =>
          openModal({
            title: t('cw.redo'),
            body: field(t('cw.complaint_text'), '<textarea name="text" required maxlength=1000></textarea>'),
            submitLabel: t('cw.redo'),
            onSubmit: async (d) => { await api('POST', `/cw/visits/${v.id}/rework`, { text: d.text }); toast(t('cw.redo_created')); done(); },
          }));
      },
    });
  };

  // ---------- customer dialog ----------
  cw.openCustomer = async (id, after) => {
    const B = cw.B || (await cw.boot());
    const done = () => (after || CRM.refresh)();
    let data = null;
    if (id) {
      try { data = await api('GET', '/cw/customers/' + id); } catch (e) { return toast(errText(e), true); }
    }
    const c = data ? data.customer : {};
    const editable = can('customers.edit');
    const reopen = () => cw.openCustomer(id, after);
    const loyBar = (l) => (l && l.enabled ? `<div class="bar"><span style="width:${(l.progress / l.every) * 100}%"></span></div><small>★ ${l.next_free ? t('cw.next_free') : `${l.progress}/${l.every}`}</small>` : '');

    const body = `
      ${data ? `<div class="chips4">
          <div><span>${t('cw.visits')}</span><b>${c.visits}</b></div><div><span>${t('cw.total_spent')}</span><b>${money(c.total)}</b></div>
          <div><span>${t('cw.avg')}</span><b>${money(c.avg_check)}</b></div><div><span>${t('cw.last_visit')}</span><b>${c.last_visit ? esc(cw.dayLabel(c.last_visit)) : '—'}</b></div></div>` : ''}
      ${field(t('name'), input('name', c.name, 'required maxlength=150'))}
      ${(B.statuses || []).length || c.status_id ? field(t('cw.client_status'), select('status_id', [['', t('none')], ...(B.statuses || []).map((x) => [x.id, x.name])], c.status_id || '')) : ''}
      <div class="row">${field(t('phone'), input('phone', c.phone, 'type=tel inputmode=tel maxlength=40'))}${field('WhatsApp', input('whatsapp', c.whatsapp, 'type=tel inputmode=tel maxlength=40'))}</div>
      <div class="row">${field('Instagram', input('instagram', c.instagram, 'maxlength=60 placeholder="@"'))}
        ${field(t('cw.source'), select('source', [['', t('none')], ...[...new Set([...B.settings.channels, c.source].filter(Boolean))].map((x) => [x, x])], c.source || ''))}</div>
      ${field(t('cw.preferences'), `<textarea name="preferences" maxlength=1000>${esc(c.preferences || '')}</textarea>`)}
      ${field(t('notes'), `<textarea name="notes" maxlength=3000>${esc(c.notes || '')}</textarea>`)}
      ${can('customers.discount') ? field(t('cw.personal_discount'), input('discount_percent', c.discount_percent || 0, 'type=number min=0 max=100 step=any inputmode=decimal')) : c.discount_percent ? `<p class="meta">${t('cw.personal_discount')}: ${c.discount_percent}%</p>` : ''}
      <label class="check one"><input type="checkbox" name="marketing_opt_out" ${c.marketing_opt_out ? 'checked' : ''}><span>${t('cw.opt_out')}</span></label>
      ${
        data
          ? `<h3>${t('cw.cars')}</h3>
             ${data.cars.map((k) => `<div class="carrow"><div><b>${esc(k.plate)}</b> ${esc(k.make)} ${esc(k.model)}${loyBar(k.loyalty)}</div>
                 <div>${editable ? `<button type="button" class="btn secondary small" data-car="${k.id}">${t('edit')}</button>` : ''}${can('customers.delete') ? ` <button type="button" class="btn secondary small danger-t" data-delcar="${k.id}">✕</button>` : ''}</div></div>`).join('') || `<p class="meta">${t('cw.no_cars')}</p>`}
             ${editable ? `<div class="row3">${input('n_plate', '', 'placeholder="' + esc(t('cw.plate')) + '" autocapitalize=characters maxlength=15')}${input('n_make', '', 'placeholder="' + esc(t('cw.make')) + '" maxlength=60')}${input('n_model', '', 'placeholder="' + esc(t('cw.model')) + '" maxlength=60')}</div>
             <button type="button" class="btn secondary small" data-a="addcar" style="margin-top:8px">+ ${t('cw.add_car')}</button>` : ''}
             ${data.followups.length ? `<h3>${t('cw.open_followups')}</h3>${data.followups.map((f) => `<div class="meta">${esc(t('fk.' + f.kind))} · ${esc(f.due_date)} ${esc(f.note || '')}</div>`).join('')}` : ''}
             <h3>${t('cw.history')}</h3>
             ${data.visits.length ? data.visits.map((v) => `<div class="hrow"><div><b>${esc(cw.dayLabel(v.scheduled_start.slice(0, 10)))}</b> ${esc(cw.hm(v.scheduled_start))} ${v.plate ? '· ' + esc(v.plate) : ''}
                 <div class="meta">${esc(cw.svcNames(v))}${v.staff_name ? ' · ' + esc(v.staff_name) : ''}</div></div><div class="right-col"><b>${v.is_rework ? t('cw.rework') : money(v.final_price)}</b>${cw.chip(v.status)}</div></div>`).join('') : `<p class="meta">${t('cw.no_history')}</p>`}`
          : `<h3>${t('cw.car')}</h3><div class="row3">${input('plate', '', 'placeholder="' + esc(t('cw.plate')) + '" autocapitalize=characters maxlength=15')}${input('make', '', 'placeholder="' + esc(t('cw.make')) + '" maxlength=60')}${input('model', '', 'placeholder="' + esc(t('cw.model')) + '" maxlength=60')}</div>`
      }`;

    openModal({
      title: data ? c.name : t('cw.new_customer'),
      wide: true,
      body,
      hideSubmit: !editable,
      extraActions: data ? `${can('visits.create') ? `<button type="button" class="btn secondary" data-a="book">${t('cw.new_booking')}</button>` : ''}${can('followups.manage') ? `<button type="button" class="btn secondary" data-a="follow">${t('cw.remind_me')}</button>` : ''}` : '',
      onDelete: data && can('customers.delete') ? async () => { await api('DELETE', '/cw/customers/' + id); done(); } : null,
      onOpen: (form) => {
        const on = (a, fn) => { const b = form.querySelector(`[data-a=${a}]`); if (b) b.onclick = fn; };
        on('book', () => { cw.closeModal(); cw.openBooking({ plate: data.cars[0]?.plate || '', after: done }); });
        on('follow', () =>
          openModal({
            title: t('cw.remind_me'),
            body: `${field(t('cw.date'), input('due_date', B.today, 'type=date required'))}${field(t('notes'), input('note', '', 'maxlength=500'))}`,
            onSubmit: async (d) => { await api('POST', '/cw/followups', { customer_id: id, ...d }); toast(t('saved')); done(); },
          }));
        on('addcar', async () => {
          try {
            await api('POST', `/cw/customers/${id}/cars`, { plate: form.n_plate.value, make: form.n_make.value, model: form.n_model.value });
            reopen();
          } catch (e) {
            if (e.code === 'plate_taken') toast(t('err.plate_taken'), true); else toast(errText(e), true);
          }
        });
        form.querySelectorAll('[data-car]').forEach((b) => (b.onclick = () => {
          const k = data.cars.find((x) => x.id === +b.dataset.car);
          openModal({
            title: k.plate,
            body: `${field(t('cw.plate'), input('plate', k.plate, 'required maxlength=15'))}<div class="row">${field(t('cw.make'), input('make', k.make))}${field(t('cw.model'), input('model', k.model))}</div>`,
            onSubmit: async (d) => { await api('PUT', '/cw/cars/' + k.id, d); reopen(); },
          });
        }));
        form.querySelectorAll('[data-delcar]').forEach((b) => (b.onclick = async () => {
          if (!confirm(t('confirmDelete'))) return;
          try { await api('DELETE', '/cw/cars/' + b.dataset.delcar); reopen(); } catch (e) { toast(errText(e), true); }
        }));
      },
      onSubmit: async (d) => {
        const payload = { ...d, marketing_opt_out: !!d.marketing_opt_out };
        if (id) {
          await api('PUT', '/cw/customers/' + id, payload);
        } else {
          payload.cars = d.plate ? [{ plate: d.plate, make: d.make, model: d.model }] : [];
          await api('POST', '/cw/customers', payload);
        }
        toast(t('saved'));
        done();
      },
    });
  };
})();
