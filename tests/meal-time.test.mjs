import test from 'node:test';
import assert from 'node:assert/strict';
import { latestMealTime } from '../js/meal-time.js';

test('takes the latest clock time across all five meal slots without changing input', () => {
  const slots = Object.freeze({
    朝: Object.freeze({ time: '9:45', text: '朝食', unknown: 0 }),
    昼: Object.freeze({ time: '12:00', text: '昼食' }),
    夕: Object.freeze({ time: '18:30', text: '' }),
    間食: Object.freeze({ time: '21:45', text: '間食' }),
    夜食: Object.freeze({ time: '20:15', text: '夜食' }),
    unknown: Object.freeze({ time: '23:59', text: '未知項目はそのまま保持' }),
  });
  assert.equal(latestMealTime(slots), '21:45');
  assert.equal(slots.朝.unknown, 0);
});

test('normalizes single-digit hours and includes midnight as a valid time', () => {
  assert.equal(latestMealTime({ 朝: { time: '0:00' } }), '00:00');
  assert.equal(latestMealTime({ 夜食: { time: '23:59' } }), '23:59');
  assert.equal(latestMealTime({ 朝: { time: '7:05' }, 夕: { time: '8:10' } }), '08:10');
});

test('returns no value for absent or invalid times rather than erasing a saved habit', () => {
  for (const source of [null, undefined, {}, [], '21:00']) assert.equal(latestMealTime(source), null);
  for (const time of ['', '24:00', '23:60', '-1:00', '12:3', '12:30:00', 1230, null]) {
    assert.equal(latestMealTime({ 朝: { time }, 昼: { text: '時刻なし' } }), null, String(time));
  }
  assert.equal(latestMealTime({ 朝: { time: '99:99' }, 夕: { time: '19:00' } }), '19:00');
});
