import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateSafety } from '../js/settings/safety.js';
import * as gas from '../js/gas-client.js';
import { uploadFile, loadAttachment, hasPendingUploads } from '../js/memo/attachments.js';

const deferred = () => { let resolve, reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; };
function fixture(overrides = {}) {
  const state = { memo: false, modal: false, api: false, upload: false, photo: false, health: null, staged: new Set(), queued: 0, blurred: 0, delays: [] };
  const ownModal = { classList: { contains: name => name === 'app-settings-modal' } };
  const doc = {
    activeElement: { tagName: 'INPUT', blur: () => state.blurred++ },
    querySelector: selector => selector === '.memo-detail' && state.memo ? {} : null,
    querySelectorAll: () => state.modal ? [ownModal, { classList: { contains: () => false } }] : [ownModal],
  };
  const guard = createUpdateSafety({
    document: doc, healthPending: () => state.health, apiBusy: () => state.api,
    uploadBusy: () => state.upload, goalUploadBusy: () => state.photo,
    pendingKeys: async () => state.staged, outboxCount: async () => state.queued, memoRecoveryIds: () => new Set(), habitTextRecoveryDates: () => new Set(), habitTextDirty: () => false,
    delay: async ms => { state.delays.push(ms); }, settleMs: 1000,
    ...overrides,
  });
  return { state, doc, guard };
}

test('ready update blurs input, settles once and preserves settings dialog and all data', async () => {
  const { state, guard } = fixture();
  await guard(); await guard();
  assert.equal(state.blurred, 2);
  assert.deepEqual(state.delays, [1000]);
  assert.equal(state.queued, 0); assert.equal(state.health, null);
  guard.reset(); await guard(); assert.deepEqual(state.delays, [1000, 1000]);
});
for (const [key, message] of [['memo', /メモ/], ['modal', /編集|画面|ダイアログ/], ['api', /保存|通信/], ['upload', /写真|添付/], ['photo', /写真|添付/], ['health', /ヘルスケア/]]) {
  test(`blocks ${key} work without discarding it`, async () => {
    const { state, guard } = fixture(); state[key] = key === 'health' ? { request_id: 'keep' } : true;
    const before = structuredClone(state[key]);
    await assert.rejects(guard(), message); assert.deepEqual(state[key], before);
  });
}
test('staged writes and unknown queued operations both block reload without being sent or erased', async () => {
  const { state, guard } = fixture(); state.staged.add('habit_day:2026-11-25');
  await assert.rejects(guard(), /未送信|保存/); assert.equal(state.staged.size, 1);
  state.staged.clear(); state.queued = 1;
  await assert.rejects(guard(), /未送信/); assert.equal(state.queued, 1);
});
test('settling can reveal an upload or pending write that began after the button press', async () => {
  const { state, guard } = fixture({ delay: async () => { state.upload = true; } });
  await assert.rejects(guard(), /写真|添付/);
});
test('work beginning while the queue is being checked is caught before success', async () => {
  const { state, guard } = fixture({ outboxCount: async () => { state.api = true; return 0; } });
  await assert.rejects(guard(), /保存|通信/);
});
test('queue failures and unavailable document fail closed', async () => {
  const { guard } = fixture({ pendingKeys: async () => { throw new Error('storage unavailable'); } });
  await assert.rejects(guard(), /storage unavailable/);
  const noDocument = createUpdateSafety({ document: null, delay: async () => {} });
  await assert.rejects(noDocument(), /画面|確認/);
});
test('API write tracker includes response decoding and clears after failure', async () => {
  const oldFetch = globalThis.fetch, read = deferred();
  globalThis.fetch = async () => ({ ok: true, text: () => read.promise });
  try {
    const save = gas.pushTaskUpsert({ id: 'synthetic-only' });
    assert.equal(gas.hasPendingWrites(), true);
    await Promise.resolve(); assert.equal(gas.hasPendingWrites(), true);
    read.resolve('{"ok":true,"data":{}}'); await save;
    assert.equal(gas.hasPendingWrites(), false);
    globalThis.fetch = async () => { throw new Error('offline fixture'); };
    await assert.rejects(gas.pushTaskDelete('synthetic-only'), /offline fixture/);
    assert.equal(gas.hasPendingWrites(), false);
  } finally { globalThis.fetch = oldFetch; }
});
test('attachment tracker covers file reading before network and clears on failure', async () => {
  const oldReader = globalThis.FileReader, oldFetch = globalThis.fetch;
  let reader;
  globalThis.FileReader = class { constructor() { reader = this; } readAsDataURL() {} };
  globalThis.fetch = async () => { throw new Error('must not fetch before file is read'); };
  try {
    const file = Object.assign(new Blob(['synthetic'], { type: 'application/pdf' }), { name: 'synthetic.pdf' });
    const uploading = uploadFile(file);
    assert.equal(hasPendingUploads(), true); assert.equal(gas.hasPendingWrites(), false);
    reader.onerror(); await assert.rejects(uploading, /読み込めません/);
    assert.equal(hasPendingUploads(), false);
  } finally { globalThis.FileReader = oldReader; globalThis.fetch = oldFetch; }
});
test('a stalled storage check times out without reporting update safety', async () => {
  const { guard } = fixture({ pendingKeys: () => new Promise(() => {}), readTimeoutMs: 5 });
  await assert.rejects(guard(), /保存状況を確認できません/);
});
test('invalid queue metadata cannot be mistaken for an empty outbox', async () => {
  for (const value of [undefined, null, -1, 0.5, '0']) {
    const { guard } = fixture({ outboxCount: async () => value });
    await assert.rejects(guard(), /未送信の記録を確認できない/);
  }
});
test('overlapping API writes stay busy until the final response settles; reads are not writes', async () => {
  const oldFetch = globalThis.fetch;
  const first = deferred(), second = deferred(), read = deferred();
  let n = 0;
  globalThis.fetch = async (_, options) => ({ ok: true, text: () => options.method === 'GET' ? read.promise : (++n === 1 ? first.promise : second.promise) });
  try {
    const reading = gas.pullTasks();
    assert.equal(gas.hasPendingWrites(), false);
    const save1 = gas.pushTaskDelete('synthetic-1'), save2 = gas.pushTaskDelete('synthetic-2');
    assert.equal(gas.hasPendingWrites(), true);
    first.resolve('{"ok":true,"data":{}}'); await save1;
    assert.equal(gas.hasPendingWrites(), true);
    second.resolve('{"ok":true,"data":{}}'); await save2;
    assert.equal(gas.hasPendingWrites(), false);
    read.resolve('{"ok":true,"data":{"tasks":[]}}'); await reading;
  } finally { globalThis.fetch = oldFetch; }
});
test('attachment upload stays busy through the response and returns the original attachment contract', async () => {
  const oldReader = globalThis.FileReader, oldFetch = globalThis.fetch, response = deferred();
  let reader, request;
  globalThis.FileReader = class { constructor() { reader = this; } readAsDataURL() {} };
  globalThis.fetch = async (_, options) => { request = JSON.parse(options.body); return { ok: true, text: () => response.promise }; };
  try {
    const file = Object.assign(new Blob(['synthetic'], { type: 'application/pdf' }), { name: 'synthetic.pdf' });
    const uploading = uploadFile(file);
    assert.equal(hasPendingUploads(), true);
    reader.result = 'data:application/pdf;base64,c3ludGhldGlj'; reader.onload();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(hasPendingUploads(), true); assert.equal(gas.hasPendingWrites(), true);
    assert.deepEqual(request, { type: 'memo_attach', name: 'synthetic.pdf', mime: 'application/pdf', data: 'c3ludGhldGlj' });
    response.resolve('{"ok":true,"data":{"id":"synthetic-update-probe","name":"synthetic.pdf","mime":"application/pdf"}}');
    const uploaded = await uploading;
    assert.deepEqual(uploaded, { id: 'synthetic-update-probe', name: 'synthetic.pdf', mime: 'application/pdf' });
    assert.equal(hasPendingUploads(), false); assert.equal(gas.hasPendingWrites(), false);
    URL.revokeObjectURL(await loadAttachment(uploaded));
  } finally { globalThis.FileReader = oldReader; globalThis.fetch = oldFetch; }
});

test('memo recovery metadata blocks app reload until durable queue persistence succeeds', async () => {
  const recovery = new Set(['synthetic-memo']);
  const { guard } = fixture({ memoRecoveryIds: () => recovery });
  await assert.rejects(guard(), /未送信/);
  assert.deepEqual([...recovery], ['synthetic-memo']);
  recovery.clear();
  assert.equal(await guard(), true);
});
test('corrupt memo recovery metadata blocks update instead of treating it as saved', async () => {
  const { guard } = fixture({ memoRecoveryIds: () => { throw new Error('復旧情報を確認できません'); } });
  await assert.rejects(guard(), /復旧情報/);
});

test('habit text recovery prevents reload until the failed enqueue is recovered', async () => {
  const recovery = new Set(['2026-11-26']);
  const { guard } = fixture({ habitTextRecoveryDates: () => recovery });
  await assert.rejects(guard(), /未送信/);
  assert.deepEqual([...recovery], ['2026-11-26']);
  recovery.clear(); assert.equal(await guard(), true);
});
test('corrupt habit text recovery refuses app update instead of discarding text', async () => {
  const { guard } = fixture({ habitTextRecoveryDates: () => { throw new Error('文章の復旧情報を確認できません'); } });
  await assert.rejects(guard(), /復旧情報/);
});

test('visible habit text that failed local persistence blocks reload even without a marker or outbox row', async () => {
  let dirty = true;
  const { guard } = fixture({ habitTextDirty: () => dirty });
  await assert.rejects(guard(), /文章|未保存/);
  dirty = false; assert.equal(await guard(), true);
});
test('unknown habit draft status cannot be mistaken for a safely saved field', async () => {
  const { guard } = fixture({ habitTextDirty: () => undefined });
  await assert.rejects(guard(), /確認|文章/);
});

test('read-only Health inspection also blocks reload and retains its dedicated request', async () => {
  const {createHealthBridge,saveHealthSettings,PENDING_KEY,INSPECTION_PENDING_KEY} = await import('../js/health/bridge.js');
  const map=new Map(),storage={getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)};
  saveHealthSettings({enabled:true,shortcutName:'synthetic',pairKey:'a'.repeat(43)},storage);
  const bridge=createHealthBridge({storage,now:()=>1800000000000,crypto:{getRandomValues:bytes=>bytes.fill(1)},api:{}});
  bridge.prepare('2026-11-27',{steps:4711},{mode:'inspect'});
  assert.equal(storage.getItem(PENDING_KEY),null);const raw=storage.getItem(INSPECTION_PENDING_KEY);assert(raw);
  const {guard}=fixture({healthPending:bridge.pending});
  await assert.rejects(guard(),/ヘルスケア/);assert.equal(storage.getItem(INSPECTION_PENDING_KEY),raw);
  bridge.cancel();assert.equal(await guard(),true);
});
