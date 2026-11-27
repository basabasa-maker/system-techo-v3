const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');
// All services are memory stubs. This suite never uses Google or personal data.
const source = fs.readFileSync(path.resolve(__dirname, '../gas/Code.gs'), 'utf8');
let now = Date.UTC(2026, 10, 25, 9), nextLockDelay = 0;
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
const entries = new Map(), locks = { held: false, acquired: 0, released: 0 };
let spreadsheetCalls = 0;
const cache = {
  get(key) { const item = entries.get(key); if (!item || item.until <= now) return null; return item.value; },
  put(key, value, seconds) { assert(locks.held, 'writes must be atomic'); assert(seconds > 0 && seconds <= 600); entries.set(key, { value, until: now + seconds * 1000 }); },
  remove(key) { assert(locks.held); entries.delete(key); },
};
const context = {
  console, Date: Clock,
  SpreadsheetApp: { openById() { spreadsheetCalls++; throw Error('must never touch a sheet'); } },
  PropertiesService: new Proxy({}, { get() { throw Error('must never touch properties'); } }),
  CacheService: { getScriptCache() { return cache; } },
  LockService: { getScriptLock() { return { waitLock() { assert(!locks.held); locks.held = true; locks.acquired++; now += nextLockDelay; nextLockDelay = 0; }, releaseLock() { assert(locks.held); locks.held = false; locks.released++; } }; } },
  Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest(algorithm, value) { return [...crypto.createHash(algorithm).update(value).digest()]; } },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput(text) { return { text, setMimeType() { return this; } }; } },
};
vm.createContext(context); vm.runInContext(source, context);
const key = 'k'.repeat(43), wrongKey = 'w'.repeat(43);
let serial = 0;
const request = (overrides = {}) => ({ request_id: ('request_' + (++serial)).padEnd(43, '_'), pair_key: key, date: '2026-11-25', issued_at: now, ...overrides });
const call = (type, data) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ type, ...data }) } }).text);
const ok = response => { assert.equal(response.ok, true, response.error); return response.data; };
const bad = (response, forbidden = []) => { assert.equal(response.ok, false); assert.equal(typeof response.error, 'string'); for (const value of forbidden) assert(!response.error.includes(String(value)), 'errors must not echo values or credentials'); };
let count = 0;
function test(name, fn) { fn(); assert.equal(spreadsheetCalls, 0); assert.equal(locks.held, false); assert.equal(locks.acquired, locks.released); count++; console.log('PASS ' + name); }

test('malformed JSON errors do not echo any request fragment', () => {
  const fragment = 'private-health-value-12345';
  const response = JSON.parse(context.doPost({ postData: { contents: fragment } }).text);
  bad(response, [fragment.slice(0, 10), key]); assert.equal(response.error, 'Invalid JSON request');
});
test('unknown pending request returns waiting without exposing values', () => {
  const r = request(); assert.deepEqual(ok(call('health_bridge_read', r)), { status: 'waiting', date: r.date });
});
test('one-day upload stages only allowed values and read returns an isolated ready result', () => {
  const r = request(), values = { weight: 68.2, bodyFat: 20.3, kcal: 421, steps: 8034 }, units = { weight: 'kg', bodyFat: '%', kcal: 'kcal', steps: 'count' };
  const uploaded = ok(call('health_bridge_upload', { ...r, values, units }));
  assert.equal(uploaded.status, 'ready'); assert(!('values' in uploaded)); assert(!('pair_key' in uploaded));
  const read = ok(call('health_bridge_read', r)); assert.deepEqual(read, { status: 'ready', date: r.date, issued_at: r.issued_at, values, units });
  assert(!JSON.stringify([...entries.values()]).includes(key), 'store only a hash of the pairing secret');
  const unrelated = ok(call('health_bridge_read', request())); assert.equal(unrelated.status, 'waiting');
});
test('missing metrics stay absent and real zero values are retained', () => {
  const r = request(); ok(call('health_bridge_upload', { ...r, values: { steps: 0, kcal: 0, bodyFat: 0 }, units: { steps: 'count', kcal: 'kcal', bodyFat: '%' } }));
  const read = ok(call('health_bridge_read', r)); assert.deepEqual(read.values, { steps: 0, kcal: 0, bodyFat: 0 }); assert(!('weight' in read.values));
  const empty = request(); ok(call('health_bridge_upload', { ...empty, values: {}, units: {} })); assert.deepEqual(ok(call('health_bridge_read', empty)).values, {});
});
test('another key, another date, and another issued time cannot read or overwrite a result', () => {
  const r = request(); ok(call('health_bridge_upload', { ...r, values: { weight: 67.4 }, units: { weight: 'kg' } }));
  for (const changes of [{ pair_key: wrongKey }, { date: '2026-11-24' }, { issued_at: r.issued_at + 1 }]) {
    bad(call('health_bridge_read', { ...r, ...changes }), [key, wrongKey, '67.4']);
    bad(call('health_bridge_ack', { ...r, ...changes }), [key, wrongKey, '67.4']);
    bad(call('health_bridge_upload', { ...r, ...changes, values: { weight: 99.9 }, units: { weight: 'kg' } }), [key, wrongKey, '99.9']);
  }
  assert.equal(ok(call('health_bridge_read', r)).values.weight, 67.4);
});
test('retry cannot replace the first result and ack removes values while preventing replay', () => {
  const r = request(); ok(call('health_bridge_upload', { ...r, values: { steps: 800 }, units: { steps: 'count' } }));
  ok(call('health_bridge_upload', { ...r, values: { steps: 999 }, units: { steps: 'count' } })); assert.equal(ok(call('health_bridge_read', r)).values.steps, 800);
  assert.deepEqual(ok(call('health_bridge_ack', r)), { status: 'consumed', date: r.date, issued_at: r.issued_at });
  assert.deepEqual(ok(call('health_bridge_read', r)), { status: 'consumed', date: r.date, issued_at: r.issued_at });
  bad(call('health_bridge_upload', { ...r, values: { steps: 888 }, units: { steps: 'count' } }));
  const stored = [...entries.values()].map(e => JSON.parse(e.value)); const marker = stored.find(e => e.request_id === r.request_id); assert(marker); assert(!('values' in marker)); assert(!('units' in marker));
});
test('expired requests and future clock errors never become authoritative empty data', () => {
  for (const issued_at of [now - 600001, now + 120001, null, '1234', -1]) bad(call('health_bridge_read', request({ issued_at })), [key]);
  const r = request(); ok(call('health_bridge_upload', { ...r, values: {}, units: {} })); now += 600001; bad(call('health_bridge_read', r));
});
test('a request expiring while it waits for the lock is not staged as ready', () => {
  const r = request({ issued_at: now - 599990 }); nextLockDelay = 20;
  bad(call('health_bridge_upload', { ...r, values: {}, units: {} }));
  assert(!entries.has('health_bridge:' + r.request_id));
});
test('invalid ids, secrets, and non-calendar dates are rejected', () => {
  for (const changes of [{ request_id: 'short' }, { request_id: 'x'.repeat(97) }, { request_id: '../' + 'a'.repeat(40) }, { pair_key: 'short' }, { pair_key: '*'.repeat(43) }, { date: '2026-02-30' }, { date: '2026-11-31' }, { date: '2026-13-01' }, { date: '2026-1-01' }]) bad(call('health_bridge_read', request(changes)), [key]);
  assert.equal(ok(call('health_bridge_read', request({ date: '2028-02-29' }))).status, 'waiting');
});
test('bad values or units reject the complete upload without caching partial metrics', () => {
  const cases = [
    { values: { weight: null }, units: { weight: 'kg' } }, { values: { weight: '' }, units: { weight: 'kg' } },
    { values: { weight: '68.2' }, units: { weight: 'kg' } }, { values: { weight: 0 }, units: { weight: 'kg' } },
    { values: { weight: 501 }, units: { weight: 'kg' } }, { values: { bodyFat: 101 }, units: { bodyFat: '%' } },
    { values: { steps: 1.5 }, units: { steps: 'count' } }, { values: { steps: -1 }, units: { steps: 'count' } },
    { values: { kcal: 100001 }, units: { kcal: 'kcal' } }, { values: { bodyFat: 0.2 }, units: { bodyFat: 'ratio' } },
    { values: { weight: 68.2 }, units: {} }, { values: {}, units: { weight: 'kg' } },
    { values: { future: 1 }, units: { future: 'kg' } }, { values: [], units: {} }, { values: {}, units: null },
  ];
  for (const payload of cases) { const r = request(); bad(call('health_bridge_upload', { ...r, ...payload }), [key]); assert.equal(ok(call('health_bridge_read', r)).status, 'waiting'); }
});
test('date and key mismatches never disclose staged values even through unknown fields', () => {
  const r = request(); ok(call('health_bridge_upload', { ...r, values: { steps: 4312 }, units: { steps: 'count' } }));
  const raw = call('health_bridge_read', { ...r, pair_key: wrongKey, values: { steps: 4312 } }); bad(raw, [key, wrongKey, '4312']);
});
test('Apple Watch provenance survives staging and read without changing any metric', () => {
  const r = request(), values = { weight: 72.4, bodyFat: 18.1, kcal: 325, steps: 2468 }, units = { weight: 'kg', bodyFat: '%', kcal: 'kcal', steps: 'count' };
  const uploaded = ok(call('health_bridge_upload', { ...r, values, units, stepsSource: 'apple_watch' }));
  assert.deepEqual(uploaded, { status: 'ready', date: r.date, issued_at: r.issued_at });
  assert.deepEqual(ok(call('health_bridge_read', r)), { status: 'ready', date: r.date, issued_at: r.issued_at, values, units, stepsSource: 'apple_watch' });
});
test('Watch provenance does not invent absent steps and retains a real zero', () => {
  for (const values of [{ weight: 72.4 }, { steps: 0 }, {}]) {
    const r = request(), units = Object.fromEntries(Object.keys(values).map(key => [key, key === 'steps' ? 'count' : 'kg']));
    ok(call('health_bridge_upload', { ...r, values, units, stepsSource: 'apple_watch' }));
    const read = ok(call('health_bridge_read', r));
    assert.deepEqual(read.values, values); assert.deepEqual(read.units, units); assert.equal(read.stepsSource, 'apple_watch');
  }
});
test('retry preserves the first provenance and values, including legacy absence', () => {
  for (const first of [{ stepsSource: 'apple_watch' }, {}]) {
    const r = request();
    ok(call('health_bridge_upload', { ...r, values: { steps: 2468 }, units: { steps: 'count' }, ...first }));
    ok(call('health_bridge_upload', { ...r, values: { steps: 9753 }, units: { steps: 'count' }, ...(first.stepsSource ? {} : { stepsSource: 'apple_watch' }) }));
    const read = ok(call('health_bridge_read', r)); assert.equal(read.values.steps, 2468);
    assert.equal(Object.hasOwn(read, 'stepsSource'), Object.hasOwn(first, 'stepsSource'));
    if (first.stepsSource) assert.equal(read.stepsSource, first.stepsSource);
    ok(call('health_bridge_ack', r));
    const marker = JSON.parse(entries.get('health_bridge:' + r.request_id).value);
    for (const field of ['values', 'units', 'stepsSource']) assert(!Object.hasOwn(marker, field), field + ' must be removed by ack');
  }
});
test('invalid provenance rejects new and repeated uploads without changing cache', () => {
  const r = request();
  ok(call('health_bridge_upload', { ...r, values: { steps: 2468 }, units: { steps: 'count' }, stepsSource: 'apple_watch' }));
  const before = entries.get('health_bridge:' + r.request_id).value;
  for (const stepsSource of [null, false, 0, [], {}, '', 'all_sources', 'APPLE_WATCH', ' apple_watch', 'private-device-name']) {
    const fresh = request();
    for (const current of [fresh, r]) {
      bad(call('health_bridge_upload', { ...current, values: { steps: 9753 }, units: { steps: 'count' }, stepsSource }), [key, 'private-device-name', '9753']);
    }
    assert(!entries.has('health_bridge:' + fresh.request_id));
    assert.equal(entries.get('health_bridge:' + r.request_id).value, before);
  }
});
test('invalid cached provenance is rejected instead of being relayed as trusted', () => {
  const r = request(); ok(call('health_bridge_upload', { ...r, values: { steps: 2468 }, units: { steps: 'count' }, stepsSource: 'apple_watch' }));
  const item = entries.get('health_bridge:' + r.request_id), entry = JSON.parse(item.value);
  entry.stepsSource = 'private-device-name'; item.value = JSON.stringify(entry);
  bad(call('health_bridge_read', r), [key, 'private-device-name', '2468']);
});
test('paired shortcut and protocol versions survive staging with source and all metrics', () => {
  for (const shortcutVersion of ['1.0.0', '42.7.3', '1'.repeat(28) + '.1.1']) {
    const r = request(), values = { weight: 72.4, bodyFat: 18.1, kcal: 325, steps: 2468 }, units = { weight: 'kg', bodyFat: '%', kcal: 'kcal', steps: 'count' };
    const metadata = { stepsSource: 'apple_watch', shortcutVersion, protocolVersion: 1 };
    const staged = ok(call('health_bridge_upload', { ...r, values, units, ...metadata }));
    assert.deepEqual(staged, { status: 'ready', date: r.date, issued_at: r.issued_at });
    assert.deepEqual(ok(call('health_bridge_read', r)), { status: 'ready', date: r.date, issued_at: r.issued_at, values, units, ...metadata });
  }
});
test('version metadata is optional without creating metrics and real zero remains zero', () => {
  for (const values of [{}, { steps: 0 }]) {
    const r = request(), units = Object.hasOwn(values, 'steps') ? { steps: 'count' } : {};
    ok(call('health_bridge_upload', { ...r, values, units, shortcutVersion: '1.0.0', protocolVersion: 1 }));
    const read = ok(call('health_bridge_read', r));
    assert.deepEqual(read.values, values); assert.deepEqual(read.units, units);
    assert.equal(read.shortcutVersion, '1.0.0'); assert.equal(read.protocolVersion, 1); assert(!Object.hasOwn(read, 'stepsSource'));
  }
});
test('first result keeps version presence and values, and ack removes every metadata field', () => {
  for (const first of [{ stepsSource: 'apple_watch', shortcutVersion: '1.0.0', protocolVersion: 1 }, {}]) {
    const r = request();
    ok(call('health_bridge_upload', { ...r, values: { steps: 2468 }, units: { steps: 'count' }, ...first }));
    ok(call('health_bridge_upload', { ...r, values: { steps: 9753 }, units: { steps: 'count' }, stepsSource: 'apple_watch', shortcutVersion: '9.0.0', protocolVersion: 1 }));
    const read = ok(call('health_bridge_read', r)); assert.equal(read.values.steps, 2468);
    for (const field of ['stepsSource', 'shortcutVersion', 'protocolVersion']) {
      assert.equal(Object.hasOwn(read, field), Object.hasOwn(first, field));
      if (Object.hasOwn(first, field)) assert.equal(read[field], first[field]);
    }
    ok(call('health_bridge_ack', r));
    const marker = JSON.parse(entries.get('health_bridge:' + r.request_id).value);
    for (const field of ['values', 'units', 'stepsSource', 'shortcutVersion', 'protocolVersion']) assert(!Object.hasOwn(marker, field), field);
    assert.deepEqual(ok(call('health_bridge_read', r)), { status: 'consumed', date: r.date, issued_at: r.issued_at });
  }
});
test('invalid or incomplete versions reject new and retry uploads before any cache change', () => {
  const r = request(), valid = { shortcutVersion: '1.0.0', protocolVersion: 1 };
  ok(call('health_bridge_upload', { ...r, values: { steps: 2468 }, units: { steps: 'count' }, ...valid }));
  const before = entries.get('health_bridge:' + r.request_id).value;
  const cases = [{ shortcutVersion: '1.0.0' }, { protocolVersion: 1 }];
  for (const shortcutVersion of [null, false, 1, [], {}, '', 'v1.0.0', '1.0', '1.0.0-beta', '1.0.0+build', ' 1.0.0', '1.0.0\n', '1'.repeat(29) + '.1.1', 'private-version-label']) cases.push({ shortcutVersion, protocolVersion: 1 });
  for (const protocolVersion of [null, false, 0, 2, 1.1, '1', [], {}]) cases.push({ shortcutVersion: '1.0.0', protocolVersion });
  for (const metadata of cases) {
    const fresh = request();
    for (const current of [fresh, r]) bad(call('health_bridge_upload', { ...current, values: { steps: 9753 }, units: { steps: 'count' }, ...metadata }), [key, 'private-version-label', '9753']);
    assert(!entries.has('health_bridge:' + fresh.request_id));
    assert.equal(entries.get('health_bridge:' + r.request_id).value, before);
  }
});
test('invalid cached version metadata is rejected without exposing the staged values', () => {
  const invalid = [{ shortcutVersion: '1.0.0' }, { protocolVersion: 1 }, { shortcutVersion: 'private-version-label', protocolVersion: 1 }, { shortcutVersion: '1.0.0', protocolVersion: 2 }];
  for (const metadata of invalid) {
    const r = request(); ok(call('health_bridge_upload', { ...r, values: { steps: 2468 }, units: { steps: 'count' } }));
    const item = entries.get('health_bridge:' + r.request_id), entry = JSON.parse(item.value);
    Object.assign(entry, metadata); item.value = JSON.stringify(entry);
    bad(call('health_bridge_read', r), [key, 'private-version-label', '2468']);
  }
});
test('versioned results cannot be read, overwritten or consumed through a different date', () => {
  const r = request(), values = { steps: 2468 }, units = { steps: 'count' };
  const metadata = { stepsSource: 'apple_watch', shortcutVersion: '1.0.0', protocolVersion: 1 };
  ok(call('health_bridge_upload', { ...r, values, units, ...metadata }));
  const before = entries.get('health_bridge:' + r.request_id).value, otherDay = { ...r, date: '2026-11-24' };
  bad(call('health_bridge_read', otherDay), [key, '2468']);
  bad(call('health_bridge_ack', otherDay), [key, '2468']);
  bad(call('health_bridge_upload', { ...otherDay, values: { steps: 9753 }, units, ...metadata, shortcutVersion: '9.0.0' }), [key, '9753']);
  assert.equal(entries.get('health_bridge:' + r.request_id).value, before);
  assert.deepEqual(ok(call('health_bridge_read', r)), { status: 'ready', date: r.date, issued_at: r.issued_at, values, units, ...metadata });
});
console.log('PASS ' + count + ' health bridge groups; no Sheets, Properties, network or real health data used');
