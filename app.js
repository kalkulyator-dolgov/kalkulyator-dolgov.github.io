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
  function debtCard(d) {
    const t = E.TYPES[d.type];
    const opts = Object.keys(E.TYPES).map(k => `<option value="${k}"${k === d.type ? ' selected' : ''}>${E.TYPES[k].title}</option>`).join('');
    const s = d._sources || {};
    const lowCls = k => s[k] && s[k].confidence !== 'высокая' ? ' low' : '';
    const grace = GRACE_TYPES.includes(d.type)
      ? `<label class="chk"><input type="checkbox" data-k="grace"${d.grace ? ' checked' : ''}> Гашу весь долг в льготный период (проценты не платятся)</label>`
      : '';
    const rateLabel = d.type === 'card' ? 'Ставка вне льготного периода, % годовых' : (d.type === 'mfo' ? 'Ставка, % годовых (0,8% в день = 292%)' : 'Ставка, % годовых');
    const srcs = Object.keys(s).length ? '<div class="src">' + Object.keys(s).map(k => `<div><b>${esc(LABELS[k] || k)}:</b> ${esc(k === 'type' && E.TYPES[s[k].value] ? E.TYPES[s[k].value].title : s[k].value)} - «${esc(s[k].quote)}»${s[k].note ? ' - ' + esc(s[k].note) : ''}${s[k].confidence !== 'высокая' ? ' (проверьте)' : ''}</div>`).join('') +
      (d._rateIsPsk ? '<div><b>Внимание:</b> ставка не найдена, подставлена ПСК - она выше реальной ставки, уточните.</div>' : '') + '</div>' : '';
    return `<div class="debt${d.check ? ' check' : ''}" data-id="${esc(d.id)}">
<h3><span>${esc(d.name || t.title)}${d.origin ? ' <span class="note">из файла ' + esc(d.origin) + '</span>' : ''}</span>
<span class="row">${d.check ? '<button data-act="ok">Проверено</button>' : ''}<button data-act="del" title="Удалить">✕</button></span></h3>
<div class="grid">
<label class="f">Тип<select data-k="type">${opts}</select></label>
<label class="f">Название<input data-k="name" value="${esc(d.name)}"></label>
<label class="f">Остаток долга, ₽<input class="${lowCls('balance')}" data-k="balance" type="number" min="0" value="${esc(d.balance)}"></label>
<label class="f">${rateLabel}<input class="${lowCls('rate')}" data-k="rate" type="number" min="0" step="0.01" value="${esc(d.rate)}"></label>
<label class="f">Платёж в месяц, ₽<input class="${lowCls('payment')}" data-k="payment" type="number" min="0" value="${esc(d.payment)}"></label>
<label class="f">Осталось месяцев (если платёж неизвестен)<input data-k="months" type="number" min="0" value="${esc(d.months)}"></label>
</div>
<div class="row" style="margin-top:8px">${grace}
<label class="chk"><input type="checkbox" data-k="prepay"${d.prepay !== false ? ' checked' : ''}> Можно гасить досрочно</label></div>
${srcs}</div>`;
  }

  function renderDebts() {
    $('debts').innerHTML = state.debts.map(debtCard).join('');
  }

  $('debts').addEventListener('input', e => {
    const el = e.target, card = el.closest('.debt'); if (!card || !el.dataset.k) return;
    const d = state.debts.find(x => x.id == card.dataset.id), k = el.dataset.k;
    d[k] = el.type === 'checkbox' ? el.checked : el.value;
    if (k === 'type') {
      const oldTitle = Object.values(E.TYPES).find(t => (d.name || '').endsWith(t.title));
      d.prepay = E.TYPES[d.type].prepay;
      if (!d.name) d.name = E.TYPES[d.type].title;
      else if (oldTitle) d.name = d.name.slice(0, d.name.length - oldTitle.title.length) + E.TYPES[d.type].title;
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
  function chart(strats) {
    const W = 640, H = 220, pad = 36;
    const maxM = Math.min(Math.max(...strats.map(s => s.balances.length)), 600);
    const maxB = Math.max(...strats.map(s => s.balances[0] || 0), 1);
    const colors = ['#8b949e', '#1f6feb', '#bf8700', '#1a7f37'];
    const x = m => pad + (W - pad - 8) * m / Math.max(maxM, 1), y = b => H - 22 - (H - 34) * b / maxB;
    const lines = strats.map((s, i) => `<polyline fill="none" stroke="${colors[i % 4]}" stroke-width="2" points="${s.balances.map((b, m) => x(m + 1).toFixed(1) + ',' + y(b).toFixed(1)).join(' ')}"/>`).join('');
    const leg = strats.map((s, i) => `<span style="color:${colors[i % 4]}">■</span> ${esc(s.title)}`).join(' &nbsp; ');
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Остаток долга по месяцам">
<line x1="${pad}" y1="${H - 22}" x2="${W - 8}" y2="${H - 22}" stroke="currentColor" opacity=".2"/>
<text x="0" y="14">${fmt(maxB / 1000)} тыс.</text><text x="${pad}" y="${H - 6}">сейчас</text><text x="${W - 70}" y="${H - 6}">${yrs(maxM)}</text>${lines}</svg><div class="note">${leg}</div>`;
  }

  function calc() {
    const debts = state.debts.map(d => ({ ...d, balance: +d.balance || 0, rate: +d.rate || 0, payment: +d.payment || 0, months: +d.months || 0 }));
    if (!debts.some(d => d.balance > 0)) { $('res').innerHTML = '<p class="note">Добавьте хотя бы один долг.</p>'; $('freeNote').textContent = ''; return; }
    const refi = +state.refi.rate > 0 ? { rate: +state.refi.rate, months: +state.refi.months || 60, feePct: +state.refi.fee || 0 } : null;
    const extra = (+state.extra || 0);
    const c = E.compare({ debts, extra, income: +state.income || 0, cashback: +state.cashback || 0, expenses: +state.expenses || 0, refi });
    $('freeNote').textContent = c.free == null ? '' : (c.free >= 0
      ? `После платежей по графику остаётся около ${fmt(c.free)} ₽ в месяц.` + (extra > c.free ? ' Доплата больше этой суммы - проверьте, хватит ли денег на жизнь.' : '')
      : `Платежей больше, чем остаётся после расходов, на ${fmt(-c.free)} ₽ в месяц.`);
    const base = c.strategies[0];
    const hasM = debts.some(d => d.type === 'mortgage');
    let h = '<div class="stat">';
    h += `<div><span>Платежи в первый месяц</span><b>${fmt(base.firstPay)} ₽</b></div>`;
    if (c.pdn != null) h += `<div><span>Долговая нагрузка (ПДН)</span><b style="color:${c.pdn > 80 ? 'var(--bad)' : c.pdn > 50 ? 'var(--warn)' : 'var(--good)'}">${c.pdn.toFixed(0)}%</b></div>`;
    h += `<div><span>Всего долгов</span><b>${fmt(debts.reduce((s, d) => s + d.balance, 0))} ₽</b></div></div>`;
    h += `<div class="tbl"><table class="st"><tr><th>Стратегия</th><th class="n">Без долгов через</th>${hasM ? '<th class="n">Без долгов кроме ипотеки</th>' : ''}<th class="n">Процентов заплатите</th><th class="n">Самый тяжёлый месяц</th></tr>`;
    for (const s of c.strategies) {
      const best = s.key === c.bestKey;
      h += `<tr${best ? ' class="best"' : ''}><td><b>${esc(s.title)}</b>${best ? ' <span class="tag">меньше всего процентов</span>' : ''}<div class="note">${esc(s.note)}</div></td>
<td class="n" data-l="Без долгов через">${s.finished ? yrs(s.months) : 'больше 50 лет'}</td>${hasM ? `<td class="n" data-l="Без долгов кроме ипотеки">${yrs(s.monthsNonMortgage)}</td>` : ''}
<td class="n" data-l="Процентов заплатите">${fmt(s.interest)} ₽${s.key !== 'base' ? `<div class="note">экономия ${fmt(base.interest - s.interest)} ₽</div>` : ''}</td><td class="n" data-l="Самый тяжёлый месяц">${fmt(s.maxPay)} ₽</td></tr>`;
    }
    h += '</table></div>' + chart(c.strategies);
    const order = c.strategies.find(s => s.key === 'avalanche');
    if (order) {
      const seqd = order.debts.filter(d => d.prepay).sort((a, b) => (a.end || 1e9) - (b.end || 1e9));
      h += `<p><b>Порядок закрытия по лавине:</b> ${seqd.map(d => esc(d.name) + ' (' + yrs(d.end) + ')').join(' → ')}</p>`;
    }
    if (c.graceDebts.length) h += `<div class="warn"><b>Не входят в план - без процентов, пока соблюдаете льготный период:</b> ${c.graceDebts.map(d => esc(d.name) + ' ' + fmt(d.balance) + ' ₽').join(', ')}. Досрочно раньше дорогих кредитов не гасить.</div>`;
    for (const w of c.warnings) h += `<div class="warn">${esc(w)}</div>`;
    if ((c.pdn != null && c.pdn > 80) || !base.finished || base.monthsNonMortgage > 84)
      h += '<div class="warn"><b>Нагрузка очень высокая.</b> Узнайте про кредитные каникулы и реструктуризацию в банке. Если выплатить невозможно - стоит оценить банкротство (калькулятор готовится).</div>';
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
