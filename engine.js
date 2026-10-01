// Движок стратегий погашения долгов. Чистые функции, без сети и DOM.
// Работает и в браузере (window.DebtEngine), и в node (module.exports).
(function (root) {
  'use strict';

  // Типы долгов и их свойства по умолчанию.
  const TYPES = {
    loan:        { title: 'Кредит наличными',            prepay: true },
    card:        { title: 'Кредитная карта',             prepay: true },
    installment: { title: 'Карта рассрочки (Халва и т.п.)', prepay: false },
    bnpl:        { title: 'Сплит / Долями (частями)',    prepay: false },
    mfo:         { title: 'Микрозайм (МФО)',             prepay: true },
    mortgage:    { title: 'Ипотека',                     prepay: false },
    auto:        { title: 'Автокредит',                  prepay: true },
    overdraft:   { title: 'Овердрафт',                   prepay: true },
    overdue:     { title: 'Просрочка / коллектор',       prepay: true },
    private:     { title: 'Долг частному лицу',          prepay: true },
  };
  const EPS = 0.01, MAX_M = 600;

  // Годовая ставка, по которой реально считаются проценты.
  // Кредитка/рассрочка, которую человек гасит в льготный период, - 0%.
  function effectiveRate(d) {
    if ((d.type === 'card' || d.type === 'installment' || d.type === 'overdraft') && d.grace) return 0;
    if (d.type === 'mfo' && d.dailyRate) return d.dailyRate * 365;
    return +d.rate || 0;
  }

  // Ежемесячный платёж: заданный, иначе минимальный для карт (3% + проценты), иначе аннуитет по сроку.
  function monthlyPayment(d) {
    if (+d.payment > 0) return +d.payment;
    const r = effectiveRate(d) / 1200, b = +d.balance;
    if (d.type === 'card' || d.type === 'overdraft') return d.grace ? b : Math.max(b * 0.03 + b * r, Math.min(b, 500));
    if (+d.months > 0) return annuity(b, effectiveRate(d), +d.months);
    return b * r + b * 0.03;
  }

  function annuity(principal, ratePct, months) {
    const r = ratePct / 1200;
    if (r === 0) return principal / months;
    return principal * r / (1 - Math.pow(1 + r, -months));
  }

  const ORDERS = {
    avalanche: (a, b) => b.r - a.r || a.b - b.b,
    snowball:  (a, b) => a.b - b.b || b.r - a.r,
  };

  // Помесячная симуляция. extra - доплата в месяц сверх платежей.
  // roll=true: платёж закрытого долга переходит на следующий (так делают лавина и снежный ком).
  function simulate(debts, opts) {
    const extra = +opts.extra || 0, order = opts.order || 'avalanche', roll = opts.roll !== false;
    const L = debts.map(d => ({
      id: d.id, name: d.name, type: d.type,
      b: +d.balance, b0: +d.balance, r: effectiveRate(d) / 1200, p: monthlyPayment(d),
      // карта без льготы и без заданного платежа: минимальный платёж от текущего остатка каждый месяц
      minMode: (d.type === 'card' || d.type === 'overdraft') && !d.grace && !(+d.payment > 0),
      prepay: d.prepay !== undefined ? !!d.prepay : (TYPES[d.type] || {}).prepay !== false,
      interest: 0, end: null,
    }));
    const balances = [];
    let m = 0, maxPay = 0, firstPay = 0;
    while (L.some(d => d.b > EPS) && m < MAX_M) {
      m++;
      let paid = 0, pool = (opts.useExtra === false ? 0 : extra);
      for (const d of L) {
        if (d.b <= EPS) continue;
        const i = d.b * d.r;
        if (d.minMode) d.p = Math.max(d.b * 0.03 + i, Math.min(d.b + i, 500));
        const pay = Math.min(d.p, d.b + i);
        d.b += i - pay; d.interest += i; paid += pay;
        if (d.b <= EPS) { d.b = 0; d.end = m; }
      }
      if (roll) for (const d of L) if (d.end != null && d.end < m) pool += d.p;
      const live = L.filter(d => d.b > EPS && d.prepay).sort(ORDERS[order] || ORDERS.avalanche);
      for (const d of live) {
        if (pool <= EPS) break;
        const a = Math.min(pool, d.b);
        d.b -= a; pool -= a; paid += a;
        if (d.b <= EPS) { d.b = 0; d.end = m; }
      }
      if (m === 1) firstPay = paid;
      // долг, который растёт (платёж меньше процентов), - не крутим до миллиардов
      if (L.some(d => d.b > d.b0 * 3 && d.b > 1000)) { balances.push(L.reduce((s, d) => s + d.b, 0)); maxPay = Math.max(maxPay, paid); break; }
      maxPay = Math.max(maxPay, paid);
      balances.push(L.reduce((s, d) => s + d.b, 0));
    }
    const nonMortgage = L.filter(d => d.type !== 'mortgage');
    return {
      months: m,
      monthsNonMortgage: nonMortgage.length ? Math.max(0, ...nonMortgage.map(d => d.end || m)) : 0,
      interest: L.reduce((s, d) => s + d.interest, 0),
      maxPay, firstPay, balances, debts: L, finished: !L.some(d => d.b > EPS),
    };
  }

  // Рефинансирование: долги с ставкой выше refi.rate (и разрешённые к досрочке) сливаются в один кредит.
  function refinance(debts, refi) {
    const pick = debts.filter(d => effectiveRate(d) > refi.rate && d.type !== 'mortgage' && d.type !== 'bnpl');
    if (!pick.length) return null;
    const principal = pick.reduce((s, d) => s + +d.balance, 0) * (1 + (+refi.feePct || 0) / 100);
    const rest = debts.filter(d => !pick.includes(d));
    const merged = { id: 'refi', name: 'Новый кредит рефинансирования', type: 'loan',
      balance: principal, rate: refi.rate, months: refi.months, payment: annuity(principal, refi.rate, refi.months), prepay: true };
    return { debts: rest.concat([merged]), merged: pick.map(d => d.name) };
  }

  // Все стратегии разом.
  function compare(input) {
    const all = input.debts.filter(d => +d.balance > 0);
    // Карта, которую гасят в льготный период, - оборотный долг без процентов: в план погашения не входит.
    const isGrace = d => (d.type === 'card' || d.type === 'overdraft') && d.grace;
    const graceDebts = all.filter(isGrace), debts = all.filter(d => !isGrace(d));
    const extra = +input.extra || 0;
    const out = [];
    out.push({ key: 'base', title: 'Ничего не менять', note: 'Платить только по графику', ...simulate(debts, { extra: 0, roll: false }) });
    out.push({ key: 'avalanche', title: 'Лавина', note: 'Доплаты и освободившиеся платежи - в самый дорогой долг', ...simulate(debts, { extra, order: 'avalanche' }) });
    out.push({ key: 'snowball', title: 'Снежный ком', note: 'Доплаты - в самый маленький долг: быстрее видно результат', ...simulate(debts, { extra, order: 'snowball' }) });
    if (input.refi && input.refi.rate !== '' && input.refi.rate != null && +input.refi.rate >= 0 && +input.refi.months > 0) {
      const r = refinance(debts, input.refi);
      if (r) out.push({ key: 'refi', title: 'Рефинансирование + лавина',
        note: 'Объединить: ' + r.merged.join(', ') + ' под ' + input.refi.rate + '%', ...simulate(r.debts, { extra, order: 'avalanche' }) });
    }
    const best = out.filter(s => s.finished).sort((a, b) => a.interest - b.interest)[0];
    const income = +input.income || 0;
    const basePay = out[0].firstPay;
    return {
      strategies: out, graceDebts, bestKey: best ? best.key : null,
      pdn: income > 0 ? basePay / income * 100 : null,
      free: income > 0 ? income + (+input.cashback || 0) - (+input.expenses || 0) - basePay : null,
      warnings: warnings(all),
    };
  }

  // Подсказки по ловушкам продуктов.
  function warnings(debts) {
    const w = [];
    for (const d of debts) {
      const p = +d.payment, i = (+d.balance || 0) * effectiveRate(d) / 1200;
      if (p > 0 && i > 0 && p <= i) w.push(d.name + ': платёж не покрывает проценты - долг растёт. Нужна реструктуризация, каникулы или другой план.');
      if (d.type === 'card' && d.grace) w.push(d.name + ': льготный период не действует на снятие наличных и переводы, а минимальный платёж его не сохраняет. Если не успеваете погасить весь долг до конца периода - снимите галочку «гашу в льготный период» и посмотрите, как меняется картина.');
      if (d.type === 'card' && !d.grace && !(+d.rate > 0)) w.push(d.name + ': не указана ставка вне льготного периода - расчёт будет неточным.');
      if (d.type === 'installment') w.push(d.name + ': рассрочку без процентов досрочно гасить невыгодно, но следите за платой за подписку и сроками платежей.');
      if (d.type === 'mfo') w.push(d.name + ': микрозайм обычно самый дорогой долг - его стоит закрывать первым.');
      if (d.type === 'overdue') w.push(d.name + ': по просрочке можно просить реструктуризацию или кредитные каникулы - уточните в банке.');
    }
    return w;
  }

  const api = { TYPES, effectiveRate, monthlyPayment, annuity, simulate, refinance, compare };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DebtEngine = api;
})(typeof self !== 'undefined' ? self : this);
