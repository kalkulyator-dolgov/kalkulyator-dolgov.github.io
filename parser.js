// Разбор текста документа (договор, график, выписка, скриншот, переписка) жёсткими правилами.
// Никакой модели и сети: регулярные выражения по типовым фразам. Каждое поле - с цитатой-источником.
(function (root) {
  'use strict';

  const NUM = '(\\d{1,3}(?:[ \\u00a0\\u202f]\\d{3})+(?:[.,]\\d{1,3})?|\\d+(?:[.,]\\d{1,3})?)';
  // Граница кириллического слова: \b в JS кириллицу не видит.
  const W = s => '(?<![а-яёa-z])(?:' + s + ')(?![а-яёa-z])';

  function toNumber(s) {
    return parseFloat(String(s).replace(/[   ]/g, '').replace(',', '.'));
  }

  function normalize(text) {
    return String(text || '')
      .replace(/\r/g, '')
      .replace(/[‐-―−]/g, '-')
      .replace(/[«»]/g, '"')
      .replace(/ё/g, 'е').replace(/Ё/g, 'Е')
      .replace(/[ \t]+/g, ' ');
  }

  // Даты, ИНН/КПП/счета, номера договоров заменяются буквами той же длины,
  // чтобы не склеиваться с суммами («на 15.09.2026 125 000 руб» не превращается в 26 125 000).
  function mask(text) {
    const fill = m => m.replace(/\S/g, 'Ж');
    return text
      .replace(/\d{1,2}\.\d{1,2}\.\d{2,4}/g, fill)
      .replace(/(ИНН|КПП|ОГРН|БИК|ОКПО|р\/с|к\/с|счет)\s*:?\s*\d+/gi, fill)
      .replace(/№\s*[\w\-\/]+/g, fill);
  }

  function quote(text, idx, len) {
    const a = Math.max(0, idx - 30), b = Math.min(text.length, idx + len + 30);
    return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ').trim() + (b < text.length ? '…' : '');
  }

  // Число после ключевой фразы в пределах окна. unit - обязательный хвост (%, руб и т.п.).
  function findAfter(text, masked, key, unit, opts) {
    const o = opts || {};
    const re = new RegExp(key, 'giu');
    let m;
    while ((m = re.exec(masked))) {
      const start = m.index + m[0].length;
      const win = masked.slice(start, start + (o.window || 140));
      const nr = new RegExp('(?<![\\d.,])' + NUM + '\\s*' + (unit || ''), 'iu');
      const n = nr.exec(win);
      if (!n) continue;
      const value = toNumber(n[1]);
      if (!isFinite(value)) continue;
      if (o.min !== undefined && value < o.min) continue;
      if (o.max !== undefined && value > o.max) continue;
      if (o.noPctBefore && /%/.test(win.slice(0, n.index))) continue;
      return { value, tail: n[0], at: start + n.index,
        quote: quote(text, m.index, m[0].length + n.index + n[0].length),
        confidence: n.index < 50 ? 'высокая' : 'средняя' };
    }
    return null;
  }

  // Порядок важен: первое совпадение определяет тип.
  const TYPE_RULES = [
    ['overdue', 'просроченн(?:ая|ой) задолженност|коллектор|цесси|' + W('ПКО') + '|уступк[аи] прав(?:а)? требовани|исполнительн(?:ое|ого) производств'],
    ['mfo', 'микрозайм|микрофинанс|' + W('МК[КФ]|МФО') + '|займ до зарплаты|% в день'],
    ['bnpl', W('сплит') + '|долями|оплата частями|покупк[аи] частями|оплатить частями'],
    ['installment', 'халва|карт[аы] рассрочки|' + W('совесть')],
    ['mortgage', 'ипотек|ипотечн|залог(?:ом)? (?:объекта )?недвижимости'],
    ['auto', 'автокредит|на покупку (?:транспортного средства|автомобиля)|залог транспортного'],
    ['overdraft', 'овердрафт'],
    ['card', 'кредитн(?:ая|ой|ую) карт|льготн(?:ый|ого) период|беспроцентн(?:ый|ого) период|минимальн(?:ый|ого) платеж|кредитный лимит'],
    ['private', 'расписк|занял(?:а)? у меня|верну тебе|долг другу'],
    ['loan', 'потребительск(?:ий|ого) кредит|кредит наличными|сумма кредита|индивидуальные условия'],
  ];

  const BANK_ALIAS = { 'Ozon Банк': 'Озон Банк', 'Ozon': 'Озон Банк', 'Тинькофф': 'Т-Банк', 'Сбер': 'Сбербанк', 'Альфа': 'Альфа-Банк' };
  const BANKS = ['Ozon Банк', 'Озон Банк', 'Сбербанк', 'Сбер', 'Т-Банк', 'Тинькофф', 'Альфа-Банк', 'Альфа', 'ВТБ', 'Газпромбанк',
    'Совкомбанк', 'Почта Банк', 'Ozon', 'Яндекс', 'Wildberries', 'ОТП', 'Ренессанс', 'Хоум Банк', 'Хоум Кредит',
    'МТС Банк', 'Россельхозбанк', 'Открытие', 'Промсвязьбанк', 'ПСБ', 'Райффайзен', 'Уралсиб', 'Русский Стандарт',
    'Росбанк', 'ДОМ.РФ', 'Займер', 'еКапуста', 'Мани Мен', 'MoneyMan', 'Лайм', 'Вебзайм', 'Феникс'];

  function detectType(text) {
    for (const [t, src] of TYPE_RULES) {
      const m = new RegExp(src, 'iu').exec(text);
      if (m) return { value: t, quote: quote(text, m.index, m[0].length), confidence: 'средняя' };
    }
    return null;
  }

  function detectBank(text) {
    const low = text.toLowerCase();
    for (const b of BANKS) {
      const i = low.indexOf(b.toLowerCase());
      if (i >= 0) return { value: BANK_ALIAS[b] || b, quote: quote(text, i, b.length), confidence: 'средняя' };
    }
    return null;
  }

  const RUB = '(?:руб|₽|р\\.|rub)';
  const PCT = '%';

  function parse(raw) {
    const text = normalize(raw);
    const mk = mask(text);
    const F = (k, u, o) => findAfter(text, mk, k, u, o);
    const f = {};
    f.type = detectType(text);
    f.bank = detectBank(text);
    f.psk = F('полн(?:ая|ой) стоимост[ьи] (?:потребительского )?(?:кредита|займа)|' + W('ПСК'), PCT, { max: 400 });
    f.dailyRate = F('(?:процентн(?:ая|ой) ставк[аи]|ставк[аи])', '%\\s*(?:в день|в сутки|ежедневно)', { max: 1 });
    if (!f.dailyRate) f.dailyRate = F('\\(', '%\\s*(?:в день|в сутки)', { max: 1, window: 20 });
    f.rate = F('процентн(?:ая|ой) ставк[аи](?: по кредиту| за пользование)?|ставк[аи] (?:на покупки|по кредиту|после льготного периода|вне (?:льготного|беспроцентного) периода)|ставка', PCT, { max: 400 });
    if (f.rate && f.dailyRate && f.rate.value === f.dailyRate.value) f.rate = null;
    if (f.rate) {
      const tail = mk.slice(f.rate.at, f.rate.at + 120);
      const range = new RegExp('^' + NUM + '\\s*%?\\s*-\\s*' + NUM + '\\s*%').exec(tail)
        || (/\d\s*%?\s*-\s*$/.test(mk.slice(Math.max(0, f.rate.at - 12), f.rate.at)) ? [null, null, String(f.rate.value)] : null);
      const after = /(?:далее|после|затем|в остальное время)[^%]{0,40}?(\d+(?:[.,]\d+)?)\s*%/iu.exec(tail);
      if (range) f.rate = { ...f.rate, value: toNumber(range[2]), confidence: 'низкая', note: 'указан диапазон ставок - взята максимальная, уточните' };
      else if (after) f.rate = { ...f.rate, value: toNumber(after[1]), confidence: 'средняя', note: 'есть промо-ставка - взята ставка после промо-периода' };
    }
    f.limit = F('кредитн(?:ый|ого) лимит|лимит кредитования|доступный лимит', RUB, { min: 1000 });
    f.amount = F('сумма (?:кредита|займа|покупки)|размер кредита|сумма потребительского кредита', RUB, { min: 100 });
    f.balance = F('остаток (?:основного )?долга|остаток задолженности|текущ(?:ая|ей) задолженност[ьи]|общ(?:ая|ей) задолженност[ьи]|полн(?:ая|ой) задолженност[ьи]|сумма задолженности|задолженность по (?:кредиту|займу|карте)|сумма (?:для|к) (?:полного )?(?:досрочного )?погашени[яю]|задолженность составляет|осталось (?:погасить|выплатить|заплатить)', RUB, { min: 1 });
    f.minPayment = F('минимальн(?:ый|ого) (?:обязательн(?:ый|ого) )?платеж', RUB, { min: 1, noPctBefore: true });
    if (!f.minPayment && /минимальн(?:ый|ого) (?:обязательн(?:ый|ого) )?платеж[^.\n]{0,20}\d+(?:[.,]\d+)?\s*%/iu.test(text))
      f.minPaymentPct = { value: 'процент от долга', quote: quote(text, text.search(/минимальн/i), 60), confidence: 'низкая' };
    f.payment = F('ежемесячн(?:ый|ого) (?:аннуитетн(?:ый|ого) )?платеж|размер (?:ежемесячного )?платежа|сумма (?:ежемесячного |очередного |следующего )?платежа|следующий платеж|платеж в месяц', RUB, { min: 1 });
    const term = F('срок (?:кредита|займа|возврата кредита|возврата займа|кредитования|действия договора|рассрочки)', '(?:мес|лет|год|дн|день|дня)', { window: 120, min: 1, max: 1000 });
    if (term) {
      const u = term.tail.toLowerCase();
      const months = /лет|год/.test(u) ? term.value * 12 : (/дн|день|дня/.test(u) ? Math.max(1, Math.ceil(term.value / 30)) : term.value);
      f.months = { value: months, quote: term.quote, confidence: term.confidence };
    } else f.months = null;
    const g = /(?:льготн(?:ый|ого) период[^.\n]{0,40}?(?:до|по|заканчивается|окончани[ея])|дата окончания льготного периода|погасить до)\D{0,15}(\d{2}\.\d{2}\.\d{4})/iu.exec(text);
    f.graceEnd = g ? { value: g[1], quote: quote(text, g.index, g[0].length), confidence: 'высокая' } : null;
    f.graceDays = F('льготн(?:ый|ого) период|беспроцентн(?:ый|ого) период|без процентов', '(?:дн|день|дня)', { window: 40, min: 20, max: 400 });
    // График платежей таблицей: «1 15.11.2026 10 250,00 2 100,00 8 150,00 291 850,00»
    if (/остаток/i.test(text) && /платеж/i.test(text)) {
      const row = /(?:^|\n)\s*\d{1,3}\s+\d{2}\.\d{2}\.\d{4}\s+([\d  ,.]+)/u.exec(text);
      const money = row && row[1].match(/\d{1,3}(?:[  ]\d{3})*,\d{2}/g);
      if (money && money.length >= 2) {
        const vals = money.map(toNumber);
        const q = { quote: quote(text, row.index, row[0].length), confidence: 'средняя' };
        if (!f.payment) f.payment = { value: vals[0], ...q };
        if (!f.balance) f.balance = { value: vals[vals.length - 1], ...q };
      }
    }
    return f;
  }

  // Превращает найденные поля в черновик карточки долга (человек проверяет и правит).
  function toDebtDraft(f) {
    const type = f.type ? f.type.value : 'loan';
    const bal = f.balance || (type === 'card' ? null : f.amount) || f.limit;
    const T = root.DebtEngine && root.DebtEngine.TYPES;
    const d = {
      type,
      name: (f.bank ? f.bank.value + ': ' : '') + (T ? T[type].title : type),
      balance: bal ? bal.value : '',
      rate: f.rate ? f.rate.value : f.dailyRate ? +(f.dailyRate.value * 365).toFixed(2)
        : (type === 'installment' || type === 'bnpl') ? 0 : f.psk ? f.psk.value : '',
      payment: f.payment ? f.payment.value : (f.minPayment ? f.minPayment.value : ''),
      months: f.months ? f.months.value : '',
      grace: false,
    };
    if (f.dailyRate) d.dailyRate = f.dailyRate.value;
    const src = {};
    for (const k of Object.keys(f)) if (f[k]) src[k] = { value: f[k].value, quote: f[k].quote, confidence: f[k].confidence, note: f[k].note };
    d._sources = src;
    d._rateIsPsk = !f.rate && !f.dailyRate && !!f.psk && type !== 'installment' && type !== 'bnpl';
    return d;
  }

  const api = { parse, toDebtDraft, toNumber, normalize, mask };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DebtParser = api;
})(typeof self !== 'undefined' ? self : this);
