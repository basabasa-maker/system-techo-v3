import test from 'node:test';
import assert from 'node:assert/strict';
import { HEALTH_METRICS, validateHealthValues, healthBaseline, selectHealthPatch, validateHealthResult } from '../js/health/model.js';

const stamp = Date.parse('2026-11-25T00:00:00Z');
const request = Object.freeze({ request_id: 'request-for-one-day', date: '2026-11-25', issued_at: stamp });
const units = Object.freeze({ weight: 'kg', bodyFat: '%', kcal: 'kcal', steps: 'count' });
const items = Object.freeze(Object.keys(units).map(id => Object.freeze({ id, type: id === 'steps' ? 'integer' : 'decimal' })));

function ready(values = {}, sourceUnits = {}) {
  return { status: 'ready', date: request.date, issued_at: request.issued_at, values, units: sourceUnits };
}

test('accepts only canonical daily measurements and preserves genuine zero values', () => {
  assert.deepEqual(Object.keys(HEALTH_METRICS), ['weight', 'bodyFat', 'kcal', 'steps']);
  const values = Object.freeze({ weight: 61.5, bodyFat: 0, kcal: 0, steps: 0 });
  const copy = validateHealthValues(values, units);
  assert.deepEqual(copy, values);
  assert.notEqual(copy, values);
  assert.deepEqual(validateHealthValues({}, {}), {}, 'missing samples produce no patch fields');
});

test('rejects malformed values, impossible bounds, unknown fields and mismatched units without exposing values', () => {
  for (const malformed of [null, [], '', 'private-value', 5]) assert.throws(() => validateHealthValues(malformed, {}));
  const badValues = [
    ['weight', 0], ['weight', 500.01], ['bodyFat', -1], ['bodyFat', 100.1],
    ['kcal', -1], ['kcal', 100001], ['steps', -1], ['steps', 1.5], ['steps', 1000001],
    ['weight', 'private-value'], ['weight', null], ['weight', NaN], ['weight', Infinity], ['weight', ''],
  ];
  for (const [id, value] of badValues) {
    assert.throws(() => validateHealthValues({ [id]: value }, { [id]: units[id] }));
  }
  assert.throws(() => validateHealthValues({ restingEnergy: 900 }, { restingEnergy: 'kcal' }));
  assert.throws(() => validateHealthValues({ weight: 61 }, { weight: 'lb' }));
  assert.throws(() => validateHealthValues({ bodyFat: 0.2 }, { bodyFat: 'ratio' }), 'do not guess percentage units');
  assert.throws(() => validateHealthValues({ weight: 61 }, {}));
  assert.throws(() => validateHealthValues({}, { weight: 'kg' }));
  assert.throws(() => validateHealthValues({}, []));
  assert.throws(() => validateHealthValues({ weight: 'private-value' }, { weight: 'kg' }), error => !error.message.includes('private-value'));
});

test('baseline contains only existing primitive health fields and never copies other habits', () => {
  const source = Object.freeze({ weight: 61, bodyFat: null, kcal: 0, steps: '8000', lastMeal: '21:30', future: { keep: true } });
  assert.deepEqual(healthBaseline(source), { weight: 61, bodyFat: null, kcal: 0, steps: '8000' });
  assert.deepEqual(healthBaseline({ weight: { invalid: true }, lastMeal: '21:30' }), {});
  assert.deepEqual(healthBaseline(null), {});
});

test('selects only unchanged health fields and leaves hand edits, missing fields and other data untouched', () => {
  const baseline = Object.freeze({ weight: 60, bodyFat: 19, kcal: 450, steps: 8000 });
  const current = Object.freeze({ weight: 61, bodyFat: 19, kcal: 450, steps: 8000, lastMeal: '21:30', future: { keep: true } });
  const incoming = Object.freeze({ weight: 62, bodyFat: 20, kcal: 0 });
  assert.deepEqual(selectHealthPatch(current, baseline, incoming, items), { bodyFat: 20, kcal: 0 });
  assert.equal(current.weight, 61, 'new manual measurement remains');
  assert.equal(current.steps, 8000, 'missing incoming steps do not clear a value');
  assert.equal(current.lastMeal, '21:30');
  assert.deepEqual(current.future, { keep: true });
  assert.deepEqual(selectHealthPatch({}, {}, { steps: 0 }, items), { steps: 0 });
  assert.deepEqual(selectHealthPatch(current, baseline, { bodyFat: 19 }, items), {}, 'same value is not saved twice');
});

test('does not recreate removed or repurposed habit items', () => {
  const configured = [{ id: 'weight', type: 'check' }, { id: 'steps', type: 'time' }];
  assert.deepEqual(selectHealthPatch({}, {}, { weight: 61, bodyFat: 20, kcal: 500, steps: 8000 }, configured), {});
  for (const type of ['number', 'decimal', 'integer']) {
    assert.deepEqual(selectHealthPatch({}, {}, { weight: 61 }, [{ id: 'weight', type }]), { weight: 61 });
  }
});

test('waiting and consumed results contain no importable measurements', () => {
  for (const status of ['waiting', 'consumed']) assert.equal(validateHealthResult({ status }, request, stamp), null);
  assert.throws(() => validateHealthResult({ status: 'other' }, request, stamp));
  assert.throws(() => validateHealthResult(null, request, stamp));
});

test('ready results are bound to the requested day and request timestamp without modifying either', () => {
  const result = Object.freeze(ready(Object.freeze({ weight: 61.5 }), Object.freeze({ weight: 'kg' })));
  assert.deepEqual(validateHealthResult(result, request, stamp + 1), { weight: 61.5 });
  assert.deepEqual(validateHealthResult(ready(), request, stamp + 1), {});
  for (const resultDate of ['2026-11-24', '2026-11-26', '2026-02-30', '', null]) {
    assert.throws(() => validateHealthResult({ ...result, date: resultDate }, request, stamp + 1));
  }
  assert.throws(() => validateHealthResult({ ...result, issued_at: stamp + 1 }, request, stamp + 1));
  assert.throws(() => validateHealthResult({ ...result, date: '2026-02-30' }, { ...request, date: '2026-02-30' }, stamp + 1));
});

test('rejects expired or invalid timestamps and never applies stale health results', () => {
  assert.deepEqual(validateHealthResult(ready(), request, stamp + 599999), {});
  assert.throws(() => validateHealthResult(ready(), request, stamp + 600000));
  assert.deepEqual(validateHealthResult(ready(), request, stamp - 120000), {});
  assert.throws(() => validateHealthResult(ready(), request, stamp - 120001));
  for (const issued_at of [0, -1, NaN, Infinity, 'private-value', null, stamp + 0.5]) {
    assert.throws(() => validateHealthResult({ ...ready(), issued_at }, { ...request, issued_at }, stamp));
  }
});
