// Интерфейс калькулятора. Все данные - только в этом браузере.
(function () {
  'use strict';
  const E = window.DebtEngine, P = window.DebtParser;
  const $ = id => document.getElementById(id);
  const fmt = n => Math.round(n).toLocaleString('ru-RU');
  const yrs = m => m == null ? '-' : (m < 12 ? m + ' мес.' : (m / 12).toFixed(1).replace('.', ',') + ' г.');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const KEY = 'debt-calc-v1';
  const GRACE_TYPES = ['card', 'installment', 'overdraft'];
  const LABELS = { type: 'тип', bank: 'банк', balance: 'остаток', amount: 'сумма кредита', limit: 'лимит', rate: 'ставка', psk: 'ПСК',
    dailyRate: 'ставка в день', minPaymentPct: 'мин. платёж', payment: 'платёж', minPayment: 'мин. платёж', months: 'срок, мес', graceEnd: 'конец льготы', graceDays: 'льготный период, дн' };
  let state = { income: '', expenses: '', extra: 0, cashback: 0, refi: { rate: '', months: 60, fee: 0 }, debts: [] };
  let seq = 1;

  // ---------- подгрузка библиотек по требованию (документы при этом никуда не отправляются) ----------
  const loaded = {};
  function lib(src) {
    if (!loaded[src]) loaded[src] = new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error('не загрузилась библиотека ' + src)); document.head.appendChild(s); });
    return loaded[src];
  }
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const PDFJS_W = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const TESS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  const MAMMOTH = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';

  let ocrWorker = null;
  async function ocr(source, say) {
    await lib(TESS);
    if (!ocrWorker) { say('Загружаю распознавание текста (один раз, ~15 МБ)…'); ocrWorker = await Tesseract.createWorker(['rus', 'eng']); }
    const r = await ocrWorker.recognize(source);
    return r.data.text;
  }

  async function fileToText(file, say) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.txt')) return await file.text();
    if (name.endsWith('.docx')) { await lib(MAMMOTH); const r = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() }); return r.value; }
    if (name.endsWith('.pdf') || file.type === 'application/pdf') {
      await lib(PDFJS); pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_W;
      const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      let text = '';
      for (let i = 1; i <= Math.min(pdf.numPages, 30); i++) {
        const page = await pdf.getPage(i);
        const c = await page.getTextContent();
        let pt = c.items.map(x => x.str + (x.hasEOL ? '\n' : ' ')).join('');
        if (pt.replace(/\s/g, '').length < 40) { // скан без текстового слоя
          say(`Страница ${i}: скан, распознаю…`);
          const vp = page.getViewport({ scale: 2 }), cv = document.createElement('canvas');
          cv.width = vp.width; cv.height = vp.height;
          await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
          pt = await ocr(cv, say);
        }
        text += pt + '\n';
      }
      return text;
    }
    if (/^image\//.test(file.type) || /\.(png|jpe?g|webp)$/.test(name)) { say('Распознаю изображение…'); return await ocr(file, say); }
    throw new Error('формат не поддерживается');
  }

  function addFromText(text, origin) {
    const f = P.parse(text);
    const d = P.toDebtDraft(f);
    const found = Object.keys(d._sources).filter(k => k !== 'type' && k !== 'bank').length;
    d.id = seq++; d.check = true; d.origin = origin; d.prepay = E.TYPES[d.type].prepay;
    state.debts.push(d);
    return found;
  }

  async function handleFiles(files) {
    const st = $('status'); const lines = [];
    const say = s => { st.textContent = lines.concat([s]).join('\n'); };
    for (const file of files) {
      try {
        say(file.name + ': читаю…');
        const text = await fileToText(file, s => say(file.name + ': ' + s));
        const n = addFromText(text, file.name);
        lines.push(`${file.name}: найдено полей - ${n}. Проверьте карточку.`);
      } catch (e) { lines.push(`${file.name}: не удалось прочитать (${e.message}). Заполните вручную.`); }
      say(''); render();
    }
    st.textContent = lines.join('\n');
  }

  // ---------- карточки долгов ----------
  const ICONS = { loan: '💵', card: '💳', installment: '🛍', bnpl: '🧩', mfo: '⚡', mortgage: '🏠', auto: '🚗', overdraft: '🏦', overdue: '⏰', private: '🤝' };
  function fld(label, k, val, unit, cls, extra) {
    return `<label class="fld">${label}<span class="box"><input class="${cls || ''}" data-k="${k}" type="number" min="0" inputmode="decimal" ${extra || ''} value="${esc(val)}">${unit ? `<span class="unit">${unit}</span>` : ''}</span></label>`;
  }
  function debtCard(d) {
    const t = E.TYPES[d.type];
    const opts = Object.keys(E.TYPES).map(k => `<option value="${k}"${k === d.type ? ' selected' : ''}>${E.TYPES[k].title}</option>`).join('');
    const s = d._sources || {};
    const lowCls = k => s[k] && s[k].confidence !== 'высокая' ? 'low' : '';
    const grace = GRACE_TYPES.includes(d.type)
      ? `<label class="chk"><input type="checkbox" data-k="grace"${d.grace ? ' checked' : ''}> Гашу весь долг в льготный период - проценты не плачу</label>`
      : '';
    const rateLabel = d.type === 'card' ? 'Ставка без льготы' : (d.type === 'mfo' ? 'Ставка годовых (0,8% в день = 292%)' : 'Ставка');
    const srcs = Object.keys(s).length ? '<div class="src">🔎 Откуда взято:' + Object.keys(s).map(k => `<div><b>${esc(LABELS[k] || k)}:</b> ${esc(k === 'type' && E.TYPES[s[k].value] ? E.TYPES[s[k].value].title : s[k].value)} - «${esc(s[k].quote)}»${s[k].note ? ' - ' + esc(s[k].note) : ''}${s[k].confidence !== 'высокая' ? ' (проверьте)' : ''}</div>`).join('') +
      (d._rateIsPsk ? '<div><b>Внимание:</b> ставка не найдена, подставлена ПСК - она выше реальной ставки, уточните.</div>' : '') + '</div>' : '';
    return `<div class="debt${d.check ? ' check' : ''}" data-id="${esc(d.id)}">
<div class="top"><b><span class="ico">${ICONS[d.type] || '💵'}</span>${esc(d.name || t.title)}${d.origin ? ' <span class="note">из файла ' + esc(d.origin) + '</span>' : ''}</b>
<span class="row">${d.check ? '<button class="btn" data-act="ok" style="padding:6px 12px">✓ Проверено</button>' : ''}<button class="x" data-act="del" title="Удалить">✕</button></span></div>
<div class="grid">
<label class="fld">Тип<span class="box"><select data-k="type">${opts}</select></span></label>
<label class="fld">Название<span class="box"><input data-k="name" style="padding-right:14px" value="${esc(d.name)}"></span></label>
${fld('Остаток долга', 'balance', d.balance, '₽', lowCls('balance'))}
${fld(rateLabel, 'rate', d.rate, '%', lowCls('rate'), 'step="0.01"')}
${fld('Платёж в месяц', 'payment', d.payment, '₽', lowCls('payment'))}
${fld('Осталось (если платёж неизвестен)', 'months', d.months, 'мес')}
</div>
${grace}
<label class="chk"><input type="checkbox" data-k="prepay"${d.prepay !== false ? ' checked' : ''}> Можно гасить досрочно</label>
${srcs}</div>`;
  }

  function renderDebts() {
    $('debts').innerHTML = state.debts.map(debtCard).join('');
  }

  $('debts').addEventListener('input', e => {
    const el = e.target, card = el.closest('.debt'); if (!card || !el.dataset.k) return;
    const d = state.debts.find(x => x.id == card.dataset.id), k = el.dataset.k;
    d[k] = el.type === 'checkbox' ? el.checked : el.value;
    if (k === 'type' || k === 'grace') {
      if (k === 'type') {
        const oldTitle = Object.values(E.TYPES).find(t => (d.name || '').endsWith(t.title));
        d.prepay = E.TYPES[d.type].prepay;
        if (!d.name) d.name = E.TYPES[d.type].title;
        else if (oldTitle) d.name = d.name.slice(0, d.name.length - oldTitle.title.length) + E.TYPES[d.type].title;
      }
      renderDebts();
    }
    if (k === 'rate' && d.type === 'mfo') delete d.dailyRate;
    if (k === 'rate') d._rateIsPsk = false;
    calc(); persist();
  });
  $('debts').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const card = b.closest('.debt'), id = card.dataset.id;
    if (b.dataset.act === 'del') state.debts = state.debts.filter(x => x.id != id);
    if (b.dataset.act === 'ok') state.debts.find(x => x.id == id).check = false;
    render(); persist();
  });

  // ---------- расчёт ----------
  const COLORS = ['#94a3b8', '#4f46e5', '#f59e0b', '#10b981'];
  function chart(strats) {
    const W = 640, H = 230, pad = 44;
    const maxM = Math.min(Math.max(...strats.map(s => s.balances.length)), 600);
    const maxB = Math.max(...strats.map(s => s.balances[0] || 0), 1);
    const x = m => pad + (W - pad - 10) * m / Math.max(maxM, 1), y = b => H - 26 - (H - 40) * b / maxB;
    const grid = [0.25, 0.5, 0.75, 1].map(f => `<line x1="${pad}" x2="${W - 10}" y1="${y(maxB * f)}" y2="${y(maxB * f)}" stroke="currentColor" opacity=".08"/><text x="2" y="${y(maxB * f) + 4}">${fmt(maxB * f / 1000)}к</text>`).join('');
    const paths = strats.map((s, i) => {
      const pts = [[x(0), y(s.balances[0] ? maxB : 0)]].concat(s.balances.map((b, m) => [x(m + 1), y(b)]));
      const line = pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
      const area = i === 1 ? `<polygon fill="url(#g)" points="${line} ${pts[pts.length - 1][0].toFixed(1)},${y(0)} ${x(0)},${y(0)}"/>` : '';
      return area + `<polyline fill="none" stroke="${COLORS[i % 4]}" stroke-width="${i === 1 ? 3 : 2}" stroke-linejoin="round" points="${line}"/>`;
    }).join('');
    const leg = strats.map((s, i) => `<span style="color:${COLORS[i % 4]}">●</span> ${esc(s.title)}`).join(' &nbsp; ');
    return `<div class="chart"><b style="font-size:14px">Как тает долг</b><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Остаток долга по месяцам" style="color:var(--ink)">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4f46e5" stop-opacity=".28"/><stop offset="1" stop-color="#4f46e5" stop-opacity="0"/></linearGradient></defs>
${grid}<line x1="${pad}" y1="${y(0)}" x2="${W - 10}" y2="${y(0)}" stroke="currentColor" opacity=".2"/>
<text x="${pad}" y="${H - 8}">сейчас</text><text x="${W - 60}" y="${H - 8}">${yrs(maxM)}</text>${paths}</svg><div class="note">${leg}</div></div>`;
  }

  function calc() {
    const debts = state.debts.map(d => ({ ...d, balance: +d.balance || 0, rate: +d.rate || 0, payment: +d.payment || 0, months: +d.months || 0 }));
    if (!debts.some(d => d.balance > 0)) {
      $('res').innerHTML = '<div class="empty"><div class="ic">🧭</div><b>Внесите первый долг - и увидите план</b><p class="note">Загрузите договор или добавьте долг вручную в шаге 1.</p></div>';
      $('freeNote').textContent = ''; return;
    }
    const refi = +state.refi.rate > 0 ? { rate: +state.refi.rate, months: +state.refi.months || 60, feePct: +state.refi.fee || 0 } : null;
    const extra = (+state.extra || 0);
    const c = E.compare({ debts, extra, income: +state.income || 0, cashback: +state.cashback || 0, expenses: +state.expenses || 0, refi });
    $('freeNote').textContent = c.free == null ? '' : (c.free >= 0
      ? `💡 После платежей по графику остаётся около ${fmt(c.free)} ₽ в месяц.` + (extra > c.free ? ' Доплата больше этой суммы - проверьте, хватит ли денег на жизнь.' : '')
      : `⚠️ Платежей больше, чем остаётся после расходов, на ${fmt(-c.free)} ₽ в месяц.`);
    const base = c.strategies[0];
    const hasM = debts.some(d => d.type === 'mortgage');
    const free = s => hasM ? s.monthsNonMortgage : s.months;
    const best = c.strategies.find(s => s.key === c.bestKey);
    let h = '';
    if (best && best.key !== 'base') {
      h += `<div class="hero-result"><div class="lbl">Лучший путь для вас</div><div class="big">${esc(best.title)}</div><div class="kpis">
<div><span>${hasM ? 'Без долгов, кроме ипотеки, через' : 'Без долгов через'}</span><b>${yrs(free(best))}</b></div>
<div><span>Сэкономите на процентах</span><b>${fmt(base.interest - best.interest)} ₽</b></div>
<div><span>Быстрее, чем по графику</span><b>${yrs(Math.max(0, free(base) - free(best)))}</b></div></div></div>`;
    } else if (extra <= 0) {
      h += `<div class="alert ok">Укажите в шаге 2, сколько готовы доплачивать в месяц, - и калькулятор покажет, как быстрее выйти из долгов.</div>`;
    }
    h += '<div class="kpi-row">';
    h += `<div class="kpi"><span>Всего долгов</span><b>${fmt(debts.reduce((s, d) => s + d.balance, 0))} ₽</b></div>`;
    h += `<div class="kpi"><span>Платежи в первый месяц</span><b>${fmt(base.firstPay)} ₽</b></div>`;
    if (c.pdn != null) h += `<div class="kpi"><span>Долговая нагрузка (ПДН)</span><b style="color:${c.pdn > 80 ? 'var(--bad)' : c.pdn > 50 ? 'var(--warn)' : 'var(--good)'}">${c.pdn.toFixed(0)}%</b></div>`;
    h += '</div><div class="opts">';
    for (const s of c.strategies) {
      const isBest = s.key === c.bestKey && s.key !== 'base';
      h += `<div class="opt${isBest ? ' best' : ''}">${isBest ? '<span class="rib">выгоднее всего</span>' : ''}
<h3>${esc(s.title)}</h3><div class="d">${esc(s.note)}</div><dl>
<dt>${hasM ? 'Без долгов (кроме ипотеки)' : 'Без долгов через'}</dt><dd>${s.finished || hasM ? yrs(free(s)) : 'больше 50 лет'}</dd>
<dt>Проценты</dt><dd>${fmt(s.interest)} ₽</dd>
${s.key !== 'base' ? `<dt>Экономия</dt><dd style="color:var(--good)">${fmt(base.interest - s.interest)} ₽</dd>` : ''}
<dt>Самый тяжёлый месяц</dt><dd>${fmt(s.maxPay)} ₽</dd></dl></div>`;
    }
    h += '</div>' + chart(c.strategies);
    const order = c.strategies.find(s => s.key === 'avalanche');
    if (order) {
      const seqd = order.debts.filter(d => d.prepay).sort((a, b) => (a.end || 1e9) - (b.end || 1e9));
      if (seqd.length) h += `<b style="font-size:14px">Порядок закрытия по лавине</b><div class="order">${seqd.map((d, i) => `<span>${i + 1}. ${esc(d.name)} - ${yrs(d.end)}</span>`).join('')}</div>`;
    }
    if (c.graceDebts.length) h += `<div class="alert ok"><span><b>Без процентов, пока соблюдаете льготный период:</b> ${c.graceDebts.map(d => esc(d.name) + ' ' + fmt(d.balance) + ' ₽').join(', ')}. Их не нужно гасить раньше дорогих кредитов.</span></div>`;
    for (const w of c.warnings) h += `<div class="alert"><span>${esc(w)}</span></div>`;
    if ((c.pdn != null && c.pdn > 80) || !base.finished || base.monthsNonMortgage > 84)
      h += '<div class="alert"><span><b>Нагрузка очень высокая.</b> Узнайте про кредитные каникулы и реструктуризацию в банке. Если выплатить невозможно - стоит оценить банкротство (калькулятор готовится).</span></div>';
    $('res').innerHTML = h;
  }
  // ---------- общие поля, сохранение ----------
  function bindTop() {
    const map = { income: 'income', expenses: 'expenses', extra: 'extra', cashback: 'cashback' };
    for (const id in map) { $(id).value = state[map[id]]; $(id).oninput = e => { state[map[id]] = e.target.value; calc(); persist(); }; }
    for (const [id, k] of [['refiRate', 'rate'], ['refiMonths', 'months'], ['refiFee', 'fee']]) { $(id).value = state.refi[k]; $(id).oninput = e => { state.refi[k] = e.target.value; calc(); persist(); }; }
  }
  // Приводит загруженные данные к безопасному виду: только известные поля и типы.
  function sanitize(raw) {
    const num = v => { const n = parseFloat(v); return isFinite(n) && n >= 0 && n < 1e12 ? n : ''; };
    const o = raw && typeof raw === 'object' ? raw : {};
    const debts = Array.isArray(o.debts) ? o.debts.slice(0, 100) : [];
    let id = 1;
    return {
      income: num(o.income), expenses: num(o.expenses), extra: num(o.extra) || 0, cashback: num(o.cashback) || 0,
      refi: { rate: num(o.refi && o.refi.rate), months: num(o.refi && o.refi.months) || 60, fee: num(o.refi && o.refi.fee) || 0 },
      debts: debts.filter(d => d && typeof d === 'object').map(d => {
        const type = Object.prototype.hasOwnProperty.call(E.TYPES, d.type) ? d.type : 'loan';
        return { id: id++, type, name: String(d.name || E.TYPES[type].title).slice(0, 120), balance: num(d.balance), rate: num(d.rate),
          payment: num(d.payment), months: num(d.months), grace: !!d.grace, prepay: d.prepay !== false, check: !!d.check,
          dailyRate: num(d.dailyRate) || undefined };
      }),
    };
  }
  function render() { renderDebts(); calc(); }
  function persist() { try { if ($('remember').checked) localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { } }

  $('newType').innerHTML = Object.keys(E.TYPES).map(k => `<option value="${k}">${E.TYPES[k].title}</option>`).join('');
  $('add').onclick = () => { const t = $('newType').value; state.debts.push({ id: seq++, type: t, name: E.TYPES[t].title, balance: '', rate: '', payment: '', months: '', grace: false, prepay: E.TYPES[t].prepay }); render(); persist(); };
  $('pick').onclick = () => $('file').click();
  $('file').onchange = e => { handleFiles([...e.target.files]); e.target.value = ''; };
  const drop = $('drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('on'); };
  drop.ondragleave = () => drop.classList.remove('on');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('on'); handleFiles([...e.dataTransfer.files]); };
  $('parsePaste').onclick = () => { const v = $('paste').value.trim(); if (!v) return; const n = addFromText(v, 'вставленного текста'); $('status').textContent = `Текст: найдено полей - ${n}. Проверьте карточку.`; $('paste').value = ''; render(); persist(); };
  $('save').onclick = () => { const b = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'мои долги.json'; a.click(); };
  $('load').onclick = () => $('loadFile').click();
  $('loadFile').onchange = async e => { try { state = sanitize(JSON.parse(await e.target.files[0].text())); seq = Math.max(0, ...state.debts.map(d => +d.id || 0)) + 1; bindTop(); render(); persist(); } catch (er) { alert('Не удалось прочитать файл'); } e.target.value = ''; };
  $('clear').onclick = () => { if (!confirm('Удалить все введённые данные?')) return; state = { income: '', expenses: '', extra: 0, cashback: 0, refi: { rate: '', months: 60, fee: 0 }, debts: [] }; try { localStorage.removeItem(KEY); } catch (e) { } bindTop(); render(); };
  $('remember').onchange = e => { try { if (e.target.checked) persist(); else localStorage.removeItem(KEY); } catch (er) { } };

  try { const s = localStorage.getItem(KEY); if (s) { state = sanitize(JSON.parse(s)); $('remember').checked = true; seq = Math.max(0, ...state.debts.map(d => +d.id || 0)) + 1; } } catch (e) { }
  bindTop(); render();
  window.__calc = { get state() { return state; }, addFromText, render };
})();
