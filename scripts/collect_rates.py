"""Сбор ставок по вкладам и накопительным счетам с sravni.ru в rates.json.

Запуск: python scripts/collect_rates.py [путь_к_rates.json]
Только стандартная библиотека. Если данных мало или формат сломался, файл не трогаем и выходим с ошибкой.
"""
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone

URL = 'https://www.sravni.ru/proxy-deposits/deposits'
AMOUNT = 1000000
LOCATION = '1383617.1383767'
TERMS = [('threeMonth', 3), ('sixMonth', 6), ('oneYear', 12), ('twoYear', 24)]
MIN_OFFERS = 20


def post(body):
    req = urllib.request.Request(
        URL, data=json.dumps(body).encode('utf-8'),
        headers={'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Chrome/130 Safari/537.36'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception as e:
            if attempt == 3:
                raise
            print('повтор после ошибки:', e, file=sys.stderr)
            time.sleep(5 * (attempt + 1))


def fetch_all(deposit_type, period):
    out, offset = [], 0
    while True:
        body = {'amount': AMOUNT, 'currency': 'rub', 'depositTypes': [deposit_type], 'limit': 100,
                'offset': offset, 'locationV2': LOCATION, 'periodCodes': [period] if period else [], 'route': 'newList'}
        j = post(body)
        out += j.get('data', [])
        offset += 100
        if offset >= j.get('total', 0) or not j.get('data'):
            return out


def rate_of(product):
    for d in product.get('details', []):
        if d.get('type') == 'rate' and isinstance(d.get('value'), (int, float)):
            return float(d['value'])
    return None


def to_offer(o, term):
    p, b = o['product'], o['bankDetail']
    rate = rate_of(p)
    if rate is None or rate <= 0:
        return None
    tags = {t['type'] for t in o.get('tags', [])}
    return {
        'bank': b['bankName'], 'name': p['name'], 'kind': p['depositType'], 'term': term,
        'rate': rate, 'cap': 'capitalization' in tags, 'online': 'online' in tags,
        'flex': 'operations' in tags,
    }


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'rates.json'
    offers, seen = [], set()
    jobs = [('accumulative', None, 0)] + [('deposit', code, m) for code, m in TERMS]
    for dtype, code, months in jobs:
        for o in fetch_all(dtype, code):
            x = to_offer(o, months)
            key = (x['bank'], x['name'], x['term']) if x else None
            if x and key not in seen:
                seen.add(key)
                offers.append(x)
    offers.sort(key=lambda x: (-x['rate'], x['bank']))
    if len(offers) < MIN_OFFERS or not {'deposit', 'accumulative'} <= {x['kind'] for x in offers}:
        print('мало данных, rates.json не обновлён:', len(offers), file=sys.stderr)
        sys.exit(1)
    data = {'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ'), 'source': 'sravni.ru',
            'amount': AMOUNT, 'count': len(offers), 'offers': offers}
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=0)
    print('записано', len(offers), 'предложений')


main()
