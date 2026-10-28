// Интерфейс калькулятора размещения денег. Расчёты - в placement-engine.js; данные только в браузере.
(function () {
  'use strict';
  const E = window.PlaceEngine, $ = id => document.getElementById(id);
  const KEY = 'place-calc-v1', DEBT_KEY = 'debt-calc-v1';
  const rub = v => Math.round(v).toLocaleString('ru-RU') + ' ₽';
  const pct = v => (Math.round(v * 100) / 100).toLocaleString('ru-RU') + '%';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = v => { const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : 0; };

  const blank = () => ({ holds: [], offers: [], newMoney: '', liquid: '', horizon: 12, otherIncome: '', prior2026: '', key2027: 15, reserve: 0 });
  let state = blank(), seq = 1;

  function persist() { try { if ($('remember').checked) localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { } }

  // ---- ввод ----
  const fld = (label, key, id, extra) => `<label class="fld">${label}<span class="box"><input data-k="${key}" data-id="${id}" ${extra.attrs || ''} value="${esc(extra.value)}"><span class="unit">${extra.unit || ''}</span></span></label>`;
  const chk = (label, key, id, on) => `<label class="chk"><input type="checkbox" data-k="${key}" data-id="${id}" ${on ? 'checked' : ''}> ${label}</label>`;

  function holdHtml(h, i) {
    return `<div class="hold" data-card="h${h.id}"><div class="top"><b>Вклад или счёт ${i + 1}</b><button class="x" data-del="h${h.id}" aria-label="Удалить">✕</button></div>
<div class="grid">
${fld('Банк', 'bank', 'h' + h.id, { value: h.bank, attrs: 'type="text" placeholder="Сбербанк"' })}
${fld('Сумма', 'amount', 'h' + h.id, { value: h.amount, unit: '₽', attrs: 'type="number" min="0" step="10000" inputmode="decimal"' })}
${fld('Ставка', 'rate', 'h' + h.id, { value: h.rate, unit: '%', attrs: 'type="number" min="0" step="0.1" inputmode="decimal"' })}
</div>
<div class="flags">${chk('проценты прибавляются к сумме (капитализация)', 'cap', 'h' + h.id, h.cap)}${chk('проценты облагаются налогом', 'taxable', 'h' + h.id, h.taxable !== false)}</div></div>`;
  }
  function offerHtml(o, i) {
    return `<div class="hold" data-card="o${o.id}"><div class="top"><b>Предложение ${i + 1}</b><button class="x" data-del="o${o.id}" aria-label="Удалить">✕</button></div>
<div class="grid">
${fld('Банк', 'bank', 'o' + o.id, { value: o.bank, attrs: 'type="text" placeholder="Т-Банк"' })}
${fld('Продукт', 'name', 'o' + o.id, { value: o.name, attrs: 'type="text" placeholder="Накопительный счёт"' })}
${fld('Ставка', 'rate', 'o' + o.id, { value: o.rate, unit: '%', attrs: 'type="number" min="0" step="0.1" inputmode="decimal"' })}
${fld('Срок (0 = в любой момент)', 'term', 'o' + o.id, { value: o.term, unit: 'мес', attrs: 'type="number" min="0" step="1" inputmode="decimal"' })}
${fld('Предел суммы (пусто = без предела)', 'maxAmount', 'o' + o.id, { value: o.maxAmount, unit: '₽', attrs: 'type="number" min="0" step="10000" inputmode="decimal"' })}
</div>
<div class="flags">${chk('проценты прибавляются к сумме', 'cap', 'o' + o.id, o.cap)}${chk('проценты облагаются налогом', 'taxable', 'o' + o.id, o.taxable !== false)}</div></div>`;
  }

  function renderLists() {
    $('holds').innerHTML = state.holds.length ? state.holds.map(holdHtml).join('') : '<div class="empty"><div class="ic">💰</div>Добавьте первый вклад или счёт</div>';
    $('offers').innerHTML = state.offers.length ? state.offers.map(offerHtml).join('') : '<div class="empty"><div class="ic">🏦</div>Добавьте предложения банков, куда готовы разместить деньги</div>';
  }
  function bindTop() {
    $('newMoney').value = state.newMoney; $('liquid').value = state.liquid; $('horizon').value = state.horizon;
    $('otherIncome').value = state.otherIncome; $('prior2026').value = state.prior2026; $('key2027').value = state.key2027; $('reserve').value = state.reserve;
  }
  function readTop() {
    state.newMoney = $('newMoney').value; state.liquid = $('liquid').value; state.horizon = +$('horizon').value;
    state.otherIncome = $('otherIncome').value; state.prior2026 = $('prior2026').value; state.key2027 = $('key2027').value; state.reserve = $('reserve').value;
  }

  // ---- расчёт ----
  function opts() {
    return { horizonMonths: state.horizon, startYear: 2026, startMonth: 11, asvLimit: 1400000,
      otherIncome: num(state.otherIncome), priorInterest: { 2026: num(state.prior2026) }, reservePct: Math.min(50, Math.max(0, num(state.reserve))),
      keyRateMax: { 2026: 16, 2027: num(state.key2027) } };
  }
  const toHold = h => ({ bank: h.bank.trim() || '?', amount: num(h.amount), rate: num(h.rate), cap: !!h.cap, taxable: h.taxable !== false });
  const toOffer = o => ({ bank: o.bank.trim() || '?', name: o.name.trim() || 'счёт', rate: num(o.rate), term: num(o.term), maxAmount: num(o.maxAmount), cap: !!o.cap, taxable: o.taxable !== false });

  function bankTable(ev) {
    return `<div class="tw"><table><tr><th>Банк</th><th class="n">Сумма с процентами</th><th>Под защитой АСВ</th><th class="n">Не защищено</th></tr>${ev.banks.map(b => {
      const share = b.total ? Math.min(100, b.insured / b.total * 100) : 100;
      return `<tr><td>${esc(b.bank)}</td><td class="n">${rub(b.total)}</td><td><div class="bar"><i class="${b.uncovered > 0.5 ? 'bad' : ''}" style="width:${share}%"></i></div></td><td class="n" style="color:${b.uncovered > 0.5 ? 'var(--bad)' : 'inherit'}">${b.uncovered > 0.5 ? rub(b.uncovered) : '-'}</td></tr>`;
    }).join('')}</table></div>`;
  }
  function taxTable(ev) {
    return `<div class="tw"><table><tr><th>Год</th><th class="n">Проценты</th><th class="n">Не облагается</th><th class="n">Налог</th></tr>${ev.taxRows.map(r =>
      `<tr><td>${r.year}</td><td class="n">${rub(r.interest + r.exempt)}</td><td class="n">${rub(Math.min(r.interest, r.free) + r.exempt)}</td><td class="n"><b>${rub(r.tax)}</b></td></tr>`).join('')}</table></div>`;
  }
  function kpis(ev) {
    return `<div class="kpi-row"><div class="kpi"><span>Вложено</span><b>${rub(ev.principal)}</b></div><div class="kpi"><span>Проценты до налога</span><b>${rub(ev.gross)}</b></div><div class="kpi"><span>Налог НДФЛ</span><b>${rub(ev.tax)}</b></div><div class="kpi"><span>Чистый доход</span><b>${rub(ev.net)}</b><span>${pct(ev.netPct)} годовых</span></div></div>`;
  }

  function debtNote(bestNet) {
    let d = null;
    try { const s = JSON.parse(localStorage.getItem(DEBT_KEY) || 'null'); d = s && s.debts; } catch (e) { }
    if (!d || !d.length) return `<p class="note">💳 Если у вас есть кредиты, внесите их на странице <a href="index.html">«Долги»</a>: вернувшись сюда, вы увидите, не выгоднее ли погасить дорогой долг, чем держать деньги на вкладе.</p>`;
    const eff = x => ((x.type === 'card' || x.type === 'installment' || x.type === 'overdraft') && x.grace) ? 0 : (x.type === 'mfo' && x.dailyRate ? x.dailyRate * 365 : +x.rate || 0);
    const top = d.map(x => ({ x, r: eff(x) })).sort((a, b) => b.r - a.r)[0];
    if (!top || top.r <= 0) return '';
    const name = esc(top.x.name || 'долг');
    return bestNet > 0 && top.r > bestNet
      ? `<div class="alert">Самый дорогой долг - «${name}» под ${pct(top.r)}, а лучшая ставка размещения после налога около ${pct(bestNet)}. Досрочное погашение этого долга даёт гарантированный эффект выше вклада. Посмотрите страницу <a href="index.html">«Долги»</a>.</div>`
      : `<p class="note">💳 Самый дорогой долг - «${name}» под ${pct(top.r)}; лучшая ставка размещения после налога около ${pct(bestNet)}. Сверьте на странице <a href="index.html">«Долги»</a>.</p>`;
  }

  function calc() {
    readTop(); persist();
    const o = opts(), res = $('res');
    const holds = state.holds.map(toHold).filter(h => h.amount > 0);
    const offers = state.offers.map(toOffer).filter(x => x.rate >= 0 && state.offers.length);
    if (!holds.length && !num(state.newMoney)) { res.innerHTML = '<div class="empty"><div class="ic">📊</div>Добавьте хотя бы один вклад или сумму для размещения</div>'; return; }
    const out = [];
    let nowEv = null;
    if (holds.length) { nowEv = E.evaluate(holds, o); out.push(`<div class="opt"><h3>Как сейчас</h3>${kpis(nowEv)}${bankTable(nowEv)}<p class="note">Налог по годам</p>${taxTable(nowEv)}</div>`); }
    const total = holds.reduce((s, h) => s + h.amount, 0) + num(state.newMoney);
    let bestNet = 0;
    if (offers.length && total > 0) {
      const live = offers.filter(x => x.rate > 0);
      const al = E.allocate(total, live, o, num(state.liquid));
      const ev = al.eval;
      bestNet = Math.max(0, ...live.map(x => x.rate * (x.taxable !== false && !(x.rate <= 1) ? 1 - (ev.gross > 0 ? ev.tax / ev.gross : 0) : 1)));
      const lines = al.lines.map(l => `<tr><td>${esc(l.bank)}</td><td>${esc(l.name)}${l.term > 0 ? ', ' + l.term + ' мес' : ', в любой момент'}</td><td class="n">${pct(l.rate)}</td><td class="n"><b>${rub(l.amount)}</b></td></tr>`).join('');
      const better = nowEv ? ev.net - nowEv.net : 0;
      out.push(`<div class="opt best"><h3>Безопасная раскладка</h3>${kpis(ev)}
<div class="tw"><table><tr><th>Банк</th><th>Куда</th><th class="n">Ставка</th><th class="n">Сумма</th></tr>${lines}</table></div>
${al.unplaced > 1 ? `<div class="alert">Не хватает места: ${rub(al.unplaced)} не удалось разместить в рамках лимита ${rub(o.asvLimit)} на банк. Добавьте ещё банк или предложение.</div>` : '<div class="alert ok">Все деньги лежат в пределах страховой суммы АСВ вместе с процентами.</div>'}
${al.liquidUnplaced > 1 ? `<div class="alert">Для суммы «доступно в любой момент» не нашлось предложений без срока: ${rub(al.liquidUnplaced)}.</div>` : ''}
${nowEv ? `<p style="margin:10px 0 0">Разница с текущим положением по чистому доходу за ${state.horizon} мес: <b style="color:${better >= 0 ? 'var(--good)' : 'var(--bad)'}">${better >= 0 ? '+' : ''}${rub(better)}</b>${nowEv.uncovered > 0.5 ? ` · без защиты было ${rub(nowEv.uncovered)}, стало ${rub(ev.uncovered)}` : ''}</p>` : ''}
${bankTable(ev)}<p class="note">Налог по годам</p>${taxTable(ev)}</div>`);
    } else if (!offers.length) {
      out.push('<p class="note">Чтобы получить раскладку, добавьте на шаге 3 предложения банков с их ставками.</p>');
    }
    res.innerHTML = `<div class="cols">${out.join('')}</div>${debtNote(bestNet)}
<p class="src">Допущения: ставка не меняется на горизонте; вклады при окончании срока продлеваются на тех же условиях; необлагаемый доход 2026 - 160 000 ₽, 2027 - по введённой ставке; налог считается по году начисления.</p>`;
  }

  // ---- события ----
  document.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset && t.dataset.id) {
      const p = t.dataset.id[0], list = p === 'h' ? state.holds : state.offers, row = list.find(x => p + x.id === t.dataset.id);
      if (row) row[t.dataset.k] = t.type === 'checkbox' ? t.checked : t.value;
    }
    calc();
  });
  document.addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) { const id = del.dataset.del; const list = id[0] === 'h' ? state.holds : state.offers; const i = list.findIndex(x => id[0] + x.id === id); if (i >= 0) list.splice(i, 1); renderLists(); calc(); }
  });
  $('addHold').onclick = () => { state.holds.push({ id: seq++, bank: '', amount: '', rate: '', cap: false, taxable: true }); renderLists(); calc(); };
  $('addOffer').onclick = () => { state.offers.push({ id: seq++, bank: '', name: '', rate: '', term: 0, maxAmount: '', cap: false, taxable: true }); renderLists(); calc(); };
  $('save').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(state)], { type: 'application/json' })); a.download = 'размещение-денег.json'; a.click(); };
  $('load').onclick = () => $('loadFile').click();
  $('loadFile').onchange = e => { const f = e.target.files[0]; if (!f) return; f.text().then(s => { try { state = sanitize(JSON.parse(s)); init(); } catch (er) { alert('Файл не удалось открыть'); } }); };
  $('clear').onclick = () => { if (!confirm('Удалить все введённые данные?')) return; state = blank(); try { localStorage.removeItem(KEY); } catch (e) { } init(); };
  $('remember').onchange = e => { try { if (e.target.checked) persist(); else localStorage.removeItem(KEY); } catch (er) { } };

  function sanitize(s) {
    const b = blank(), r = Object.assign(b, s || {});
    r.holds = (Array.isArray(r.holds) ? r.holds : []).map((h, i) => Object.assign({ id: i + 1, bank: '', amount: '', rate: '', cap: false, taxable: true }, h));
    r.offers = (Array.isArray(r.offers) ? r.offers : []).map((o, i) => Object.assign({ id: 1000 + i, bank: '', name: '', rate: '', term: 0, maxAmount: '', cap: false, taxable: true }, o));
    return r;
  }
  function init() { seq = Math.max(1, ...state.holds.map(x => +x.id || 0), ...state.offers.map(x => +x.id || 0)) + 1; bindTop(); renderLists(); calc(); }

  // Ссылка с готовыми данными: страница/#z=<base64url(deflate-raw(JSON))>. Фрагмент на сервер не отправляется.
  async function fromHash() {
    const m = /^#z=([A-Za-z0-9_-]+)$/.exec(location.hash);
    if (!m || typeof DecompressionStream === 'undefined') return false;
    try {
      const b = atob(m[1].replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((m[1].length + 3) % 4));
      const bytes = Uint8Array.from(b, c => c.charCodeAt(0));
      const txt = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
      state = sanitize(JSON.parse(txt));
      return true;
    } catch (e) { return false; }
  }
  // ---- живые ставки: rates.json собирает облако раз в сутки ----
  let rates = null, picks = [];
  function pickRates() {
    if (!rates) return [];
    const kind = $('rKind').value, online = $('rOnline').checked, top = Math.max(1, Math.min(30, +$('rTop').value || 8));
    const best = new Map();
    rates.offers.forEach(o => {
      if (o.term > state.horizon) return;
      if (kind === 'acc' && o.kind !== 'accumulative') return;
      if (kind === 'dep' && o.kind !== 'deposit') return;
      if (online && !o.online) return;
      const cur = best.get(o.bank);
      if (!cur || o.rate > cur.rate) best.set(o.bank, o);
    });
    return [...best.values()].sort((a, b) => b.rate - a.rate).slice(0, top);
  }
  function renderRates() {
    picks = pickRates();
    $('ratesList').innerHTML = picks.length ? '<table><thead><tr><th>Банк, продукт</th><th class="n">Срок</th><th class="n">Ставка</th></tr></thead><tbody>' +
      picks.map(o => `<tr><td>${esc(o.bank)}, ${esc(o.name)}</td><td class="n">${o.term ? o.term + ' мес' : 'в любой момент'}</td><td class="n">${pct(o.rate)}</td></tr>`).join('') + '</tbody></table>' : '<div class="empty">Нет подходящих предложений</div>';
    $('addRates').disabled = !picks.length;
  }
  function loadRates() {
    fetch('rates.json?' + Date.now()).then(r => r.json()).then(j => {
      rates = j; const d = new Date(j.updated);
      $('ratesDate').textContent = 'на ' + d.toLocaleDateString('ru-RU') + ', ' + j.count + ' предложений';
      renderRates();
    }).catch(() => { $('ratesDate').textContent = 'не удалось загрузить'; });
  }
  ['rKind', 'rTop', 'rOnline'].forEach(id => $(id).addEventListener('input', renderRates));
  $('horizon').addEventListener('input', renderRates);
  $('addRates').onclick = () => {
    state.offers = state.offers.filter(o => !/ПРИМЕР/i.test(o.bank + o.name));
    picks.forEach(o => state.offers.push({ id: seq++, bank: o.bank, name: o.name, rate: o.rate, term: o.term, maxAmount: '', cap: !!o.cap, taxable: o.rate > 1 }));
    renderLists(); calc();
    $('result').scrollIntoView({ behavior: 'smooth' });
  };
  loadRates();
  try { const s = localStorage.getItem(KEY); if (s) { state = sanitize(JSON.parse(s)); $('remember').checked = true; } } catch (e) { }
  init();
  fromHash().then(ok => { if (ok) init(); });
})();
