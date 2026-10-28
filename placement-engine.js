// Движок размещения денег: вклады и накопительные счета по банкам, лимит страхования АСВ, НДФЛ на проценты.
// Чистые функции, без сети и DOM. Работает и в браузере (window.PlaceEngine), и в node (module.exports).
// Нормы (проверено 28.10.2026 по публикации ФНС и обзорам, см. SOURCES): лимит АСВ 1,4 млн на вкладчика в одном банке
// (проценты входят в сумму); НДФЛ с процентов облагается сверх 1 млн x максимальная ключевая ставка года, 13% до 2,4 млн
// совокупного дохода и 15% выше; проценты по рублёвым счетам со ставкой не выше 1% и эскроу не учитываются.
(function (root) {
  'use strict';

  const SOURCES = [
    { title: 'ФНС: как уплачивается НДФЛ с процентов по вкладам', url: 'https://www.nalog.gov.ru/rn13/news/activities_fts/16626545/' },
    { title: 'АСВ: страхование вкладов (лимит 1,4 млн, проверять на asv.org.ru)', url: 'https://www.asv.org.ru/' },
  ];

  const DEFAULTS = {
    asvLimit: 1400000,
    horizonMonths: 12,
    startYear: 2026,
    startMonth: 11,          // месяц старта (1-12)
    otherIncome: 0,          // прочие доходы в год (зарплата и др.), влияют на ступень 13% / 15%
    keyRateMax: { 2026: 16, 2027: 15 }, // макс. ключевая ставка, %: 2026 известна, 2027 - допущение
    reservePct: 0,           // запас под лимитом АСВ, % от лимита
  };

  // Прогрессивная шкала НДФЛ (с 2025). Подтверждены ФНС только 13% / 15%; верхние ступени - по закону, вклады их почти не затрагивают.
  const SCALE = [[2400000, 0.13], [5000000, 0.15], [20000000, 0.18], [50000000, 0.20], [Infinity, 0.22]];

  function incomeTax(base) {
    let tax = 0, prev = 0;
    for (const [top, rate] of SCALE) {
      if (base > prev) tax += (Math.min(base, top) - prev) * rate;
      prev = top;
    }
    return tax;
  }

  // Необлагаемый процентный доход года.
  function taxFree(year, opts) {
    const k = (opts.keyRateMax || DEFAULTS.keyRateMax)[year];
    return 1000000 * (k == null ? 0 : k / 100);
  }

  // Налог с процентов за год: сумма процентов, необлагаемый остаток, прочие доходы.
  function interestTax(interest, year, opts) {
    const free = taxFree(year, opts);
    const taxable = Math.max(0, interest - free);
    const other = +opts.otherIncome || 0;
    return { interest, free, taxable, tax: incomeTax(other + taxable) - incomeTax(other) };
  }

  // Рублёвые остатки/счета со ставкой <= 1% годовых в расчёт необлагаемого дохода не входят (по ФНС).
  function isTaxable(h) { return h.taxable !== false && !(h.rate <= 1); }

  // Помесячное накопление одной позиции на горизонте. Возвращает проценты по месяцам и итоговый баланс.
  function accrue(h, opts) {
    const months = opts.horizonMonths, r = (+h.rate || 0) / 1200;
    let bal = +h.amount || 0, acc = 0;
    const out = [];
    for (let i = 0; i < months; i++) {
      const interest = (h.cap ? bal : (+h.amount || 0)) * r;
      acc += interest;
      if (h.cap) bal += interest;
      out.push(interest);
    }
    const end = (+h.amount || 0) + acc;
    return { monthly: out, interest: acc, end };
  }

  function yearOfMonth(i, opts) {
    const idx = (opts.startMonth - 1) + i;
    return opts.startYear + Math.floor(idx / 12);
  }

  // Полный расчёт набора позиций: проценты по годам, налог, покрытие АСВ по банкам.
  function evaluate(holdings, userOpts) {
    const opts = Object.assign({}, DEFAULTS, userOpts || {});
    const byYear = {}, byBank = {};
    let gross = 0, principal = 0;
    for (const h of holdings) {
      const a = accrue(h, opts);
      const taxable = isTaxable(h);
      principal += +h.amount || 0;
      gross += a.interest;
      a.monthly.forEach((v, i) => {
        const y = yearOfMonth(i, opts);
        byYear[y] = byYear[y] || { taxableInterest: 0, exemptInterest: 0 };
        byYear[y][taxable ? 'taxableInterest' : 'exemptInterest'] += v;
      });
      const b = byBank[h.bank || '?'] = byBank[h.bank || '?'] || { bank: h.bank || '?', principal: 0, interest: 0, total: 0 };
      b.principal += +h.amount || 0; b.interest += a.interest; b.total += a.end;
    }
    // Проценты, уже полученные в году до расчёта (например, за 10 месяцев 2026): входят в налоговую базу года, но не в доход горизонта.
    const prior = opts.priorInterest || {};
    Object.keys(prior).forEach(y => { if (+prior[y] > 0) byYear[y] = byYear[y] || { taxableInterest: 0, exemptInterest: 0 }; });
    const years = Object.keys(byYear).map(Number).sort();
    let tax = 0, taxPriorOnly = 0;
    const taxRows = years.map(y => {
      const pr = +prior[y] || 0;
      const t = interestTax(byYear[y].taxableInterest + pr, y, opts);
      tax += t.tax;
      taxPriorOnly += interestTax(pr, y, opts).tax;
      return Object.assign({ year: y, exempt: byYear[y].exemptInterest, prior: pr }, t);
    });
    const taxFuture = tax - taxPriorOnly;
    const banks = Object.values(byBank).map(b => {
      const insured = Math.min(b.total, opts.asvLimit * (1 - opts.reservePct / 100));
      return Object.assign(b, { insured, uncovered: Math.max(0, b.total - insured) });
    }).sort((a, b) => b.total - a.total);
    const uncovered = banks.reduce((s, b) => s + b.uncovered, 0);
    return { opts, principal, gross, tax, taxFuture, net: gross - taxFuture, netPct: principal ? (gross - taxFuture) / principal * 100 * 12 / opts.horizonMonths : 0,
             grossPct: principal ? gross / principal * 100 * 12 / opts.horizonMonths : 0, taxRows, banks, uncovered };
  }

  // Рост позиции за горизонт (множитель): нужен, чтобы не выйти за лимит АСВ вместе с процентами.
  function growth(offer, opts) {
    const r = (+offer.rate || 0) / 1200, n = opts.horizonMonths;
    return offer.cap ? Math.pow(1 + r, n) : 1 + r * n;
  }

  // Раскладка суммы по предложениям: самые доходные первыми, в каждом банке не выше лимита АСВ с учётом процентов.
  // offers: [{bank, name, rate, cap, term (0 = в любой момент), taxable, maxAmount}]. liquid: сколько должно лежать без срока.
  // Два прохода: после первого известна предельная ставка налога, второй сортирует по ставке после налога.
  function allocate(total, offers, userOpts, liquid) {
    const opts = Object.assign({}, DEFAULTS, userOpts || {});
    const limit = opts.asvLimit * (1 - opts.reservePct / 100);
    let marginal = 0;
    let best = null;
    for (let pass = 0; pass < 2; pass++) {
      const net = o => (+o.rate || 0) * (isTaxable(o) ? 1 - marginal : 1);
      const room = {}, used = {}, lines = [];
      const place = (amount, pool) => {
        let left = amount;
        for (const o of pool.slice().sort((a, b) => net(b) - net(a))) {
          if (left <= 0.005) break;
          const bank = o.bank || '?', g = growth(o, opts);
          room[bank] = room[bank] == null ? limit : room[bank];
          const cap = o.maxAmount > 0 ? Math.max(0, o.maxAmount - (used[o._k] || 0)) : Infinity;
          const p = Math.min(left, room[bank] / g, cap);
          if (p <= 0.005) continue;
          room[bank] -= p * g; used[o._k] = (used[o._k] || 0) + p; left -= p;
          lines.push({ bank, name: o.name, rate: +o.rate, cap: !!o.cap, term: o.term || 0, taxable: o.taxable, amount: p });
        }
        return left;
      };
      const pool = offers.map((o, i) => Object.assign({ _k: i }, o));
      const liq = Math.min(+liquid || 0, total);
      const lLeft = place(liq, pool.filter(o => !(o.term > 0)));
      const rest = place(total - liq + 0, pool);
      const holdings = merge(lines).map(l => ({ bank: l.bank, amount: l.amount, rate: l.rate, cap: l.cap, taxable: l.taxable }));
      const ev = evaluate(holdings, opts);
      const y = ev.taxRows.filter(r => r.taxable > 0);
      marginal = y.length && ev.gross > 0 ? ev.tax / Math.max(1, y.reduce((s, r) => s + r.taxable, 0)) : 0;
      best = { lines: merge(lines), eval: ev, unplaced: lLeft + rest, liquidUnplaced: lLeft };
    }
    return best;
  }

  function merge(lines) {
    const m = {};
    for (const l of lines) {
      const k = [l.bank, l.name, l.rate, l.cap].join('|');
      if (m[k]) m[k].amount += l.amount; else m[k] = Object.assign({}, l);
    }
    return Object.values(m);
  }

  const api = { SOURCES, DEFAULTS, SCALE, incomeTax, taxFree, interestTax, isTaxable, accrue, evaluate, growth, allocate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PlaceEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
