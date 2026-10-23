// Excel report for a chosen period. The layout follows the supplied sample workbook:
//   1. Аналитика  2. Сотрудники  3. Реклама
// (same titles, column names, colours, text dates "ГГГГ-ММ-ДД", plain numbers, "—" for "no data").
const ExcelJS = require('exceljs');

const L = {
  ru: {
    sheets: ['1. Аналитика', '2. Сотрудники', '3. Реклама'],
    t1: 'ОТЧЁТ ПО АВТОМОЙКЕ — АНАЛИТИКА', t2: 'ОТЧЁТ ПО СОТРУДНИКАМ И КАЧЕСТВУ', t3: 'ОТЧЁТ ПО РЕКЛАМЕ',
    period: (f, t, c, money) => `Период: ${f} — ${t}${money ? ` | Все суммы в ${c}` : ''}`,
    sec1: '1. Главные показатели', sec2: '2. Выручка по дням', sec3: '3. Какие услуги принесли выручку', sec4: '4. Загрузка постов', sec5: '5. Выручка по сотрудникам',
    indicator: 'Показатель', value: 'Значение', unit: 'Единица', date: 'Дата', revenueC: (c) => `Выручка, ${c}`, cars: 'Автомобилей',
    revenue: 'Выручка', served: 'Обслужено автомобилей', avg: 'Средний чек', carsUnit: 'авто', perCar: (c) => `${c} / авто`,
    service: 'Услуга', qty: 'Количество', bay: 'Пост', load: 'Загрузка, %', staff: 'Сотрудник',
    staffTitle: 'Работа сотрудников за выбранный период',
    assigned: 'Назначено заказов', done: 'Выполнено', accepted: 'Принял авто', planMin: 'План. время, мин', factMin: 'Факт. время, мин', eff: 'Эффективность, %', complaints: 'Жалобы', reworks: 'Переделки',
    howTo: 'Как читать показатели', what: 'Что означает',
    help: [
      ['Назначено заказов', 'Сколько заказов назначили сотруднику.'],
      ['Выполнено', 'Сколько заказов сотрудник завершил.'],
      ['Принял авто', 'Сколько автомобилей сотрудник принял и оформил.'],
      ['Плановое / фактическое время', 'Плановое время сравнивается с фактическим временем выполнения.'],
      ['Эффективность', 'Плановое время ÷ фактическое × 100%. Если фактическое время неизвестно или равно 0, показывается «—».'],
      ['Жалобы / переделки', 'Количество жалоб клиентов и заказов, которые пришлось переделывать.'],
    ],
    adsSec1: '1. Итоги рекламы за период', expl: 'Пояснение', spend: 'Расходы', newClients: 'Новые клиенты', cac: 'Цена нового клиента', chRev: 'Выручка от каналов', roi: 'Окупаемость (ROI), %',
    spendE: 'Сумма всех рекламных затрат', newE: 'Уникальные клиенты, впервые пришедшие из рекламы', cacE: 'Расходы ÷ новые клиенты', chRevE: 'Выручка, отнесённая к рекламным каналам', roiE: '(Выручка − расходы) ÷ расходы × 100%',
    adsSec2: '2. Сравнение рекламных каналов', channel: 'Канал', spendC: (c) => `Расходы, ${c}`, cacC: (c) => `Цена клиента, ${c}`, roiC: 'ROI, %',
    adsSec3: '3. Журнал рекламных расходов', dateIso: 'Дата (ГГГГ-ММ-ДД)', amountC: (c) => `Расход, ${c}`,
    rule: 'Правило:', ruleText: 'ROI считается по выручке, а не по прибыли. Для расчёта настоящей прибыльности можно отдельно учитывать себестоимость услуг.',
  },
  kk: {
    sheets: ['1. Талдау', '2. Қызметкерлер', '3. Жарнама'],
    t1: 'КӨЛІК ЖУУ ОРНЫ БОЙЫНША ЕСЕП — ТАЛДАУ', t2: 'ҚЫЗМЕТКЕРЛЕР ЖӘНЕ САПА БОЙЫНША ЕСЕП', t3: 'ЖАРНАМА БОЙЫНША ЕСЕП',
    period: (f, t, c, money) => `Кезең: ${f} — ${t}${money ? ` | Барлық сомалар ${c}` : ''}`,
    sec1: '1. Басты көрсеткіштер', sec2: '2. Күн бойынша түсім', sec3: '3. Қандай қызметтер түсім әкелді', sec4: '4. Бекеттердің жүктемесі', sec5: '5. Қызметкерлер бойынша түсім',
    indicator: 'Көрсеткіш', value: 'Мәні', unit: 'Бірлік', date: 'Күні', revenueC: (c) => `Түсім, ${c}`, cars: 'Көлік саны',
    revenue: 'Түсім', served: 'Қызмет көрсетілген көліктер', avg: 'Орташа чек', carsUnit: 'көлік', perCar: (c) => `${c} / көлік`,
    service: 'Қызмет', qty: 'Саны', bay: 'Бекет', load: 'Жүктеме, %', staff: 'Қызметкер',
    staffTitle: 'Таңдалған кезеңдегі қызметкерлер жұмысы',
    assigned: 'Тағайындалған тапсырыс', done: 'Орындалды', accepted: 'Көлікті қабылдады', planMin: 'Жоспар. уақыт, мин', factMin: 'Нақты уақыт, мин', eff: 'Тиімділік, %', complaints: 'Шағымдар', reworks: 'Қайта орындау',
    howTo: 'Көрсеткіштерді қалай оқу керек', what: 'Нені білдіреді',
    help: [
      ['Тағайындалған тапсырыс', 'Қызметкерге қанша тапсырыс тағайындалды.'],
      ['Орындалды', 'Қызметкер қанша тапсырысты аяқтады.'],
      ['Көлікті қабылдады', 'Қызметкер қанша көлікті қабылдап, ресімдеді.'],
      ['Жоспарлы / нақты уақыт', 'Жоспарлы уақыт орындаудың нақты уақытымен салыстырылады.'],
      ['Тиімділік', 'Жоспарлы уақыт ÷ нақты уақыт × 100%. Нақты уақыт белгісіз немесе 0 болса, «—» көрсетіледі.'],
      ['Шағымдар / қайта орындау', 'Клиент шағымдарының және қайта орындалған тапсырыстардың саны.'],
    ],
    adsSec1: '1. Кезеңдегі жарнама қорытындысы', expl: 'Түсіндірме', spend: 'Шығыстар', newClients: 'Жаңа клиенттер', cac: 'Жаңа клиенттің бағасы', chRev: 'Арналардан түскен түсім', roi: 'Өтелім (ROI), %',
    spendE: 'Барлық жарнама шығындарының сомасы', newE: 'Жарнамадан алғаш рет келген бірегей клиенттер', cacE: 'Шығыстар ÷ жаңа клиенттер', chRevE: 'Жарнама арналарына жатқызылған түсім', roiE: '(Түсім − шығыстар) ÷ шығыстар × 100%',
    adsSec2: '2. Жарнама арналарын салыстыру', channel: 'Арна', spendC: (c) => `Шығыстар, ${c}`, cacC: (c) => `Клиент бағасы, ${c}`, roiC: 'ROI, %',
    adsSec3: '3. Жарнама шығыстарының журналы', dateIso: 'Күні (ЖЖЖЖ-АА-КК)', amountC: (c) => `Шығыс, ${c}`,
    rule: 'Ереже:', ruleText: 'ROI пайда бойынша емес, түсім бойынша есептеледі. Нақты табыстылықты есептеу үшін қызметтің өзіндік құнын бөлек ескеруге болады.',
  },
  en: {
    sheets: ['1. Analytics', '2. Staff', '3. Advertising'],
    t1: 'CAR WASH REPORT — ANALYTICS', t2: 'STAFF AND QUALITY REPORT', t3: 'ADVERTISING REPORT',
    period: (f, t, c, money) => `Period: ${f} — ${t}${money ? ` | All amounts in ${c}` : ''}`,
    sec1: '1. Key figures', sec2: '2. Revenue by day', sec3: '3. Revenue by service', sec4: '4. Bay utilization', sec5: '5. Revenue by employee',
    indicator: 'Indicator', value: 'Value', unit: 'Unit', date: 'Date', revenueC: (c) => `Revenue, ${c}`, cars: 'Cars',
    revenue: 'Revenue', served: 'Cars served', avg: 'Average check', carsUnit: 'cars', perCar: (c) => `${c} / car`,
    service: 'Service', qty: 'Quantity', bay: 'Bay', load: 'Utilization, %', staff: 'Employee',
    staffTitle: 'Employee work for the selected period',
    assigned: 'Orders assigned', done: 'Completed', accepted: 'Cars received', planMin: 'Planned time, min', factMin: 'Actual time, min', eff: 'Efficiency, %', complaints: 'Complaints', reworks: 'Redos',
    howTo: 'How to read the figures', what: 'Meaning',
    help: [
      ['Orders assigned', 'How many orders were assigned to the employee.'],
      ['Completed', 'How many orders the employee finished.'],
      ['Cars received', 'How many cars the employee received and registered.'],
      ['Planned / actual time', 'Planned time is compared with the actual time taken.'],
      ['Efficiency', 'Planned time ÷ actual time × 100%. If the actual time is unknown or 0, “—” is shown.'],
      ['Complaints / redos', 'Number of customer complaints and of orders that had to be redone.'],
    ],
    adsSec1: '1. Advertising summary for the period', expl: 'Explanation', spend: 'Spend', newClients: 'New customers', cac: 'Cost per new customer', chRev: 'Revenue from channels', roi: 'Payback (ROI), %',
    spendE: 'Total advertising spend', newE: 'Unique customers who first came from advertising', cacE: 'Spend ÷ new customers', chRevE: 'Revenue attributed to advertising channels', roiE: '(Revenue − spend) ÷ spend × 100%',
    adsSec2: '2. Advertising channel comparison', channel: 'Channel', spendC: (c) => `Spend, ${c}`, cacC: (c) => `Cost per customer, ${c}`, roiC: 'ROI, %',
    adsSec3: '3. Advertising expense log', dateIso: 'Date (YYYY-MM-DD)', amountC: (c) => `Spend, ${c}`,
    rule: 'Rule:', ruleText: 'ROI is based on revenue, not profit. For true profitability the cost of services can be tracked separately.',
  },
};

const FONT = 'Arial';
const INK = 'FF252936';
const BORDER = { style: 'thin', color: { argb: 'FFD5D9E6' } };
const BOX = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const DASH = '—';
const round1 = (n) => Math.round(n * 10) / 10;

function title(ws, text, lastCol, sub) {
  ws.mergeCells(1, 1, 1, lastCol);
  const a = ws.getCell(1, 1);
  a.value = text; a.font = { name: FONT, size: 16, bold: true, color: { argb: 'FFFFFFFF' } }; a.fill = fill('FF20232D');
  a.alignment = { vertical: 'middle', wrapText: true };
  ws.getRow(1).height = 32;
  ws.mergeCells(2, 1, 2, lastCol);
  const b = ws.getCell(2, 1);
  b.value = sub; b.font = { name: FONT, size: 10, color: { argb: 'FF687083' } }; b.alignment = { vertical: 'middle', wrapText: true };
}
function section(ws, row, col, span, text) {
  if (span > 1) ws.mergeCells(row, col, row, col + span - 1);
  const c = ws.getCell(row, col);
  c.value = text; c.font = { name: FONT, size: 11, bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = fill('FF4A5060');
  c.alignment = { vertical: 'middle', wrapText: true };
  ws.getRow(row).height = 24;
}
// header cells + data rows (zebra); `center` lists 0-based columns that are centred
function table(ws, row, col, headers, rows, center = []) {
  headers.forEach((h, i) => {
    const c = ws.getCell(row, col + i);
    c.value = h; c.font = { name: FONT, size: 10, bold: true, color: { argb: INK } }; c.fill = fill('FFEEF1FF'); c.border = BOX;
    c.alignment = { horizontal: center.includes(i) ? 'center' : undefined, vertical: 'middle', wrapText: true };
  });
  ws.getRow(row).height = 30;
  rows.forEach((vals, r) => {
    vals.forEach((v, i) => {
      const c = ws.getCell(row + 1 + r, col + i);
      c.value = v; c.font = { name: FONT, size: 10, color: { argb: INK } }; c.border = BOX;
      if (r % 2 === 0) c.fill = fill('FFF7F8FB');
      c.alignment = { horizontal: center.includes(i) ? 'center' : undefined, vertical: 'middle', wrapText: true };
    });
  });
  return row + 1 + rows.length; // first free row after the table
}
const widths = (ws, w) => Object.entries(w).forEach(([k, v]) => (ws.getColumn(k).width = v));
const sheet = (wb, name, freeze) => {
  const ws = wb.addWorksheet(name, { views: [{ showGridLines: false, state: 'frozen', ySplit: freeze }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  return ws;
};

/**
 * data: { company: {name, currency}, range: {from, to}, lang, analytics?, staff?, ads? }
 * A sheet is only built when its data is present (the caller checks the user's permissions).
 */
async function build(data) {
  const T = L[data.lang] || L.ru;
  const cur = data.company.currency || '';
  const { from, to } = data.range;
  const wb = new ExcelJS.Workbook();
  wb.creator = data.company.name;
  wb.created = new Date();

  // ----- 1. Analytics -----
  if (data.analytics) {
    const a = data.analytics;
    const ws = sheet(wb, T.sheets[0], 4);
    widths(ws, { A: 28, B: 18, C: 17, D: 4, E: 25, F: 18, G: 16, H: 4, I: 22, J: 17, K: 15 });
    title(ws, T.t1, 11, T.period(from, to, cur, true));
    section(ws, 4, 1, 3, T.sec1);
    const end1 = table(ws, 5, 1, [T.indicator, T.value, T.unit], [
      [T.revenue, a.range.revenue, cur], [T.served, a.range.cars, T.carsUnit], [T.avg, a.range.avg_check, T.perCar(cur)],
    ], [1]);
    section(ws, 4, 5, 3, T.sec2);
    table(ws, 5, 5, [T.date, T.revenueC(cur), T.cars], a.daily.map((d) => [d.date, d.revenue, d.cars]), [1, 2]);
    section(ws, 4, 9, 3, T.sec4);
    table(ws, 5, 9, [T.bay, T.load, T.cars], a.bays.map((b) => [b.name, round1(b.utilization * 100), b.cars]), [1, 2]);
    const r3 = end1 + 1;
    section(ws, r3, 1, 3, T.sec3);
    const end3 = table(ws, r3 + 1, 1, [T.service, T.revenueC(cur), T.qty], a.by_service.map((s) => [s.name, s.revenue, s.count]), [1, 2]);
    const r5 = end3 + 1;
    section(ws, r5, 1, 3, T.sec5);
    table(ws, r5 + 1, 1, [T.staff, T.cars, T.revenueC(cur)], a.staff.filter((x) => x.cars || x.revenue).map((x) => [x.name, x.cars, x.revenue]), [1, 2]);
  }

  // ----- 2. Staff -----
  if (data.staff) {
    const ws = sheet(wb, T.sheets[1], 3);
    widths(ws, { A: 22, B: 16, C: 14, D: 15, E: 18, F: 18, G: 17, H: 16, I: 13, J: 13 });
    title(ws, T.t2, 10, T.period(from, to, cur, false));
    section(ws, 4, 1, 10, T.staffTitle);
    const rows = data.staff.map((s) => {
      const known = s.actual_minutes > 0 && s.planned_minutes > 0;
      return [s.name, s.assigned, s.done, s.accepted, s.planned_minutes > 0 ? s.planned_minutes : DASH, s.actual_minutes > 0 ? s.actual_minutes : DASH, known ? round1((s.planned_minutes / s.actual_minutes) * 100) : DASH, s.revenue, s.complaints, s.reworks];
    });
    const end = table(ws, 5, 1, [T.staff, T.assigned, T.done, T.accepted, T.planMin, T.factMin, T.eff, T.revenueC(cur), T.complaints, T.reworks], rows, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const r = end + 2;
    section(ws, r, 1, 3, T.howTo);
    ws.getRow(r + 1).height = 30;
    [[T.indicator, 1], [T.what, 2]].forEach(([h, i]) => {
      const c = ws.getCell(r + 1, i === 1 ? 1 : 2);
      c.value = h; c.font = { name: FONT, size: 10, bold: true, color: { argb: INK } }; c.fill = fill('FFEEF1FF'); c.alignment = { vertical: 'middle', wrapText: true };
    });
    ws.mergeCells(r + 1, 2, r + 1, 10);
    T.help.forEach(([k, v], i) => {
      const row = r + 2 + i;
      ws.mergeCells(row, 2, row, 10);
      for (const [col, val] of [[1, k], [2, v]]) {
        const c = ws.getCell(row, col);
        c.value = val; c.font = { name: FONT, size: 10, color: { argb: INK } }; c.alignment = { vertical: 'middle', wrapText: true };
        if (i % 2 === 0) c.fill = fill('FFF7F8FB');
      }
      ws.getRow(row).height = 30;
    });
  }

  // ----- 3. Advertising -----
  if (data.analytics) {
    const ads = data.analytics.ads;
    const ws = sheet(wb, T.sheets[2], 3);
    widths(ws, { A: 24, B: 18, C: 22, D: 22, E: 20, F: 18, G: 4 });
    title(ws, T.t3, 6, T.period(from, to, cur, true).replace(' | ', ' | ') );
    section(ws, 4, 1, 3, T.adsSec1);
    table(ws, 5, 1, [T.indicator, T.value, T.expl], [
      [T.spend, ads.spend, T.spendE], [T.newClients, ads.new_customers, T.newE],
      [T.cac, ads.cac === null ? DASH : ads.cac, T.cacE], [T.chRev, ads.revenue, T.chRevE],
      [T.roi, ads.roi === null ? DASH : round1(ads.roi * 100), T.roiE],
    ], [1]);
    section(ws, 12, 1, 6, T.adsSec2);
    const first = 14;
    const channels = ads.channels.filter((c) => c.channel !== DASH); // customers without a source are not an advertising channel
    const chRows = channels.map((c) => [c.channel, c.spend, c.new_customers, null, c.revenue, null]);
    const end = table(ws, 13, 1, [T.channel, T.spendC(cur), T.newClients, T.cacC(cur), T.revenueC(cur), T.roiC], chRows, [1, 2, 3, 4, 5]);
    channels.forEach((c, i) => {
      const row = first + i;
      ws.getCell(row, 4).value = { formula: `IF(C${row}=0,"${DASH}",B${row}/C${row})`, result: c.new_customers === 0 ? DASH : Math.round((c.spend / c.new_customers) * 100) / 100 };
      ws.getCell(row, 6).value = { formula: `IF(B${row}=0,"${DASH}",(E${row}-B${row})/B${row}*100)`, result: c.spend === 0 ? DASH : round1(((c.revenue - c.spend) / c.spend) * 100) };
    });
    const r3 = Math.max(end, 17) + 2;
    section(ws, r3, 1, 3, T.adsSec3);
    const end3 = table(ws, r3 + 1, 1, [T.dateIso, T.channel, T.amountC(cur)], data.ads.map((a) => [a.date, a.channel, a.amount]), [2]);
    const rr = end3 + 1;
    ws.getCell(rr, 1).value = T.rule; ws.getCell(rr, 1).font = { name: FONT, size: 11, bold: true, color: { argb: 'FF6D86F7' } };
    ws.mergeCells(rr, 2, rr, 6);
    ws.getCell(rr, 2).value = T.ruleText; ws.getCell(rr, 2).font = { name: FONT, size: 10, color: { argb: INK } };
    ws.getCell(rr, 2).alignment = { vertical: 'middle', wrapText: true };
    ws.getRow(rr).height = 32;
  }
  return wb.xlsx.writeBuffer();
}

module.exports = { build };
