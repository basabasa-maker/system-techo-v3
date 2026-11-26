import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoRepository } from '../js/memo/repository.js';

const key = 'sth_v3_memo_recovery';
const upsert = (id, body = '本文') => ({ type: 'memo_upsert', payload: { id, body } });
const deletion = id => ({ type: 'memo_delete', payload: { id } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function storage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), values };
}
const repo = (store, queue, loadMemo = () => null) => createMemoRepository({ storage: store, queue, loadMemo });
const markers = s => JSON.parse(s.getItem(key) || '[]');

test('marker is synchronous and contains only id/type/token, never memo content', async () => {
  const s = storage({ untouched: 'keep' }), pending = deferred();
  let called = false;
  const r = repo(s, (op, delay) => {
    called = true;
    assert.equal(delay, 1);
    assert.equal(markers(s)[0].id, op.payload.id);
    return pending.promise;
  });
  const saving = r.queue(upsert('a', 'private memo body'));
  assert.equal(called, true);
  assert.deepEqual([...r.getProtectedIds()], ['a']);
  assert.deepEqual(Object.keys(markers(s)[0]).sort(), ['id', 'token', 'type']);
  assert.ok(!s.getItem(key).includes('private memo body'));
  assert.equal(s.getItem('untouched'), 'keep');
  pending.resolve(); await saving;
  assert.deepEqual([...r.getProtectedIds()], []);
});

test('failed enqueue survives reload and replay uses the newest local body', async () => {
  const s = storage();
  await assert.rejects(repo(s, () => Promise.reject(new Error('IDB failed'))).queue(upsert('a', 'stale')), /IDB failed/);
  const calls = [], latest = { id: 'a', body: '最新\n☑ 本文  ', opaque: 7 };
  const reloaded = repo(s, (op, delay) => { calls.push({ op, delay }); return Promise.resolve(); }, id => id === 'a' ? latest : null);
  assert.deepEqual([...reloaded.getProtectedIds()], ['a']);
  await reloaded.replay();
  assert.deepEqual(calls, [{ op: { type: 'memo_upsert', payload: latest }, delay: 1 }]);
  assert.deepEqual([...reloaded.getProtectedIds()], []);
});

test('delete replay does not read or restore a memo body', async () => {
  const s = storage();
  await assert.rejects(repo(s, () => Promise.reject(new Error('offline IDB'))).queue(deletion('a')));
  const calls = [];
  const r = repo(s, op => { calls.push(op); }, () => { throw new Error('must not read body'); });
  await r.replay();
  assert.deepEqual(calls, [deletion('a')]);
  assert.deepEqual([...r.getProtectedIds()], []);
});

test('an old enqueue success never clears a newer delete marker', async () => {
  const s = storage(), old = deferred(), next = deferred();
  const r = repo(s, op => op.type === 'memo_upsert' ? old.promise : next.promise);
  const first = r.queue(upsert('a'));
  const firstToken = markers(s)[0].token;
  const second = r.queue(deletion('a'));
  assert.notEqual(markers(s)[0].token, firstToken);
  old.resolve(); await first;
  assert.equal(markers(s)[0].type, 'memo_delete');
  assert.deepEqual([...r.getProtectedIds()], ['a']);
  next.resolve(); await second;
  assert.deepEqual([...r.getProtectedIds()], []);
});

test('an old replay success cannot clear a newer save after delete', async () => {
  const s = storage();
  await assert.rejects(repo(s, () => Promise.reject(new Error('IDB'))).queue(deletion('a')));
  const old = deferred(), next = deferred();
  const r = repo(s, op => op.type === 'memo_delete' ? old.promise : next.promise);
  const replaying = r.replay();
  const saving = r.queue(upsert('a', 'newer'));
  old.resolve(); await replaying;
  assert.equal(markers(s)[0].type, 'memo_upsert');
  next.resolve(); await saving;
  assert.deepEqual([...r.getProtectedIds()], []);
});

test('replay skips an obsolete snapshot item replaced by a newer delete', async () => {
  const s = storage();
  const failed = repo(s, () => Promise.reject(new Error('IDB')));
  await assert.rejects(failed.queue(upsert('a'))); await assert.rejects(failed.queue(upsert('b')));
  const pause = deferred(), deleted = deferred(), calls = [];
  const r = repo(s, op => {
    calls.push(op);
    return op.payload.id === 'a' ? pause.promise : deleted.promise;
  }, id => ({ id, body: id + ' latest' }));
  const replaying = r.replay();
  const deleting = r.queue(deletion('b'));
  pause.resolve(); await replaying;
  assert.deepEqual(calls.map(op => [op.type, op.payload.id]), [['memo_upsert', 'a'], ['memo_delete', 'b']]);
  assert.deepEqual([...r.getProtectedIds()], ['b']);
  deleted.resolve(); await deleting;
});

test('marker storage failure stops enqueue synchronously', () => {
  const s = storage(); let calls = 0;
  s.setItem = () => { throw new Error('quota'); };
  assert.throws(() => repo(s, () => { calls++; }).queue(upsert('a')), /quota/);
  assert.equal(calls, 0);
});

test('synchronous enqueue failure leaves a recoverable marker', () => {
  const s = storage(); const r = repo(s, () => { throw new Error('closed IDB'); });
  assert.throws(() => r.queue(upsert('a')), /closed IDB/);
  assert.deepEqual([...r.getProtectedIds()], ['a']);
});

test('corrupt markers fail closed for reads, new writes and replay', async () => {
  for (const raw of ['{', 'null', '{}', '[null]', '[{"id":"a","type":"other","token":"x"}]', '[{"id":"a","type":"memo_upsert","token":""}]', '[{"id":"a","type":"memo_delete","token":"x"},{"id":"a","type":"memo_delete","token":"y"}]']) {
    const s = storage({ [key]: raw }); let calls = 0;
    const r = repo(s, () => { calls++; });
    assert.throws(() => r.getProtectedIds(), /復旧/);
    assert.throws(() => r.queue(upsert('b')), /復旧/);
    await assert.rejects(r.replay(), /復旧/);
    assert.equal(calls, 0);
    assert.equal(s.getItem(key), raw);
  }
});

test('missing local upsert record remains protected instead of guessing a deletion', async () => {
  const s = storage();
  await assert.rejects(repo(s, () => Promise.reject(new Error('IDB'))).queue(upsert('a')));
  let calls = 0; const r = repo(s, () => { calls++; });
  await assert.rejects(r.replay(), /本文/);
  assert.equal(calls, 0);
  assert.deepEqual([...r.getProtectedIds()], ['a']);
});

test('read-only recovery helper shares validation without requiring queue or memo access', async () => {
  const { readMemoRecoveryIds } = await import('../js/memo/repository.js');
  const s = storage();
  assert.deepEqual([...readMemoRecoveryIds(s)], []);
  await assert.rejects(repo(s, () => Promise.reject(new Error('IDB'))).queue(upsert('a', 'secret')));
  const before = s.getItem(key);
  assert.deepEqual([...readMemoRecoveryIds(s)], ['a']);
  assert.equal(s.getItem(key), before);
  s.setItem(key, '{');
  assert.throws(() => readMemoRecoveryIds(s), /復旧/);
});

test('independent instances always reread storage before clearing their token', async () => {
  const s = storage(), old = deferred(), newer = deferred();
  const first = repo(s, () => old.promise), second = repo(s, () => newer.promise);
  const a = first.queue(upsert('a'));
  const b = second.queue(deletion('a'));
  old.resolve(); await a;
  assert.deepEqual([...first.getProtectedIds()], ['a']);
  assert.equal(markers(s)[0].type, 'memo_delete');
  newer.resolve(); await b;
  assert.deepEqual([...first.getProtectedIds()], []);
});

test('failed marker cleanup stays protected even after enqueue succeeded', async () => {
  const s = storage(), waiting = deferred();
  const r = repo(s, () => waiting.promise);
  const saving = r.queue(upsert('a'));
  s.setItem = () => { throw new Error('cleanup quota'); };
  waiting.resolve();
  await assert.rejects(saving, /cleanup quota/);
  assert.deepEqual([...r.getProtectedIds()], ['a']);
});
