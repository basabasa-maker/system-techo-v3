import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { splitBody, joinBody } from '../js/memo/body.js';
import { keyOf, coalesceOperations, mergePatch } from '../js/sync-operations.js';
import { mergePatch as mergeViaSync } from '../js/sync.js';

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('existing memo body and multiple attachment tokens round-trip unchanged', () => {
  const body = '買い物\n☑ 牛乳\n[[future:そのまま残す]]\n[[att:old-1|見積書.pdf|application/pdf]]\n[[att:old-2|写真.jpg|image/jpeg]]';
  const parsed = splitBody(body);
  assert.equal(parsed.text, '買い物\n☑ 牛乳\n[[future:そのまま残す]]');
  assert.deepEqual(parsed.atts, [
    { id: 'old-1', name: '見積書.pdf', mime: 'application/pdf' },
    { id: 'old-2', name: '写真.jpg', mime: 'image/jpeg' },
  ]);
  assert.equal(joinBody(parsed.text, parsed.atts), body);
});

test('plain text resembling a token remains text, including empty memo bodies', () => {
  for (const body of ['', '本文 [[att:id|a.pdf|application/pdf]]', '[[att:未完成]]']) {
    const parsed = splitBody(body);
    assert.deepEqual(parsed, { text: body, atts: [] });
    assert.equal(joinBody(parsed.text, parsed.atts), body);
  }
});

test('habit changes keep legacy values, explicit zero, deletes and later restores', () => {
  const list = freeze([
    { id: 1, op: { type: 'habit_day_upsert', payload: { date: '2026-11-01', values: { weight: 60, water: 500, steps: 8000 } } } },
    { id: 3, op: { type: 'habit_day_upsert', payload: { date: '2026-11-01', set: { water: 0 }, del: ['weight', 'steps'] } } },
    { id: 5, op: { type: 'habit_day_upsert', payload: { date: '2026-11-01', set: { steps: 9000 }, del: [] } } },
  ]);
  assert.deepEqual(coalesceOperations(list), {
    type: 'habit_day_upsert', payload: { date: '2026-11-01', set: { water: 0, steps: 9000 }, del: ['weight'] },
  });
  assert.equal(list[0].op.payload.values.weight, 60);
});

test('meal changes keep other slots and preserve explicit clearing of a slot', () => {
  const list = freeze([
    { id: 2, op: { type: 'meal_day_upsert', payload: { date: '2026-11-01', slots: { 朝: { time: '08:00', text: 'パン' }, 昼: { time: '12:00', text: '蕎麦' } } } } },
    { id: 4, op: { type: 'meal_day_upsert', payload: { date: '2026-11-01', set: { 朝: { time: '', text: '' } } } } },
  ]);
  assert.deepEqual(coalesceOperations(list), {
    type: 'meal_day_upsert', payload: { date: '2026-11-01', set: { 朝: { time: '', text: '' }, 昼: { time: '12:00', text: '蕎麦' } } },
  });
});

test('task and memo upsert/delete share a key and retain the latest operation', () => {
  for (const entity of ['task', 'memo']) {
    const list = freeze([
      { id: 1, op: { type: entity + '_upsert', payload: { id: 'one', body: 'old' } } },
      { id: 2, op: { type: entity + '_delete', payload: { id: 'one' } } },
    ]);
    assert.equal(keyOf(list[0].op), keyOf(list[1].op));
    assert.deepEqual(coalesceOperations(list), list[1].op);
  }
  assert.equal(keyOf({ type: 'future_operation', payload: { id: 'one' } }), null);
});

test('merging independent habit fields never discards an untouched field', () => {
  assert.deepEqual(mergePatch(
    freeze({ set: { weight: 60, water: 500 }, del: ['nap'] }),
    freeze({ set: { steps: 0 }, del: ['water'] }),
  ), { set: { weight: 60, steps: 0 }, del: ['nap', 'water'] });
});

test('every relative JS module dependency is present after moving files', () => {
  const root = fileURLToPath(new URL('../js/', import.meta.url));
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith('.js')) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(/(?:import|export)\s[\s\S]*?\bfrom\s*["'](\.[^"']+)["']/g)) {
          assert(existsSync(path.resolve(dir, match[1])), file + ' -> ' + match[1]);
        }
      }
    }
  }
  visit(root);
});

test('existing sync.mergePatch entry point retains its contract', () => {
  assert.deepEqual(mergeViaSync({ set: { water: 500 }, del: [] }, { set: { steps: 0 }, del: ['water'] }),
    { set: { steps: 0 }, del: ['water'] });
});
