import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CACHE_KEY, goalSnapshot, isDeleted, validateNode,
  normalizeItem, mergeGoalSnapshot,
} from '../js/goals/model.js';
import { createGoalsRepository } from '../js/goals/repository.js';
import { keyOf } from '../js/sync-operations.js';
import { flushGoalOperations } from '../js/sync.js';

const date = '2026-11-24 12:00';
const purpose = { id: 'p', kind: 'purpose', parent_id: '', title: '豊かに暮らす', updated_at: date };
const goal = { id: 'g', kind: 'goal', parent_id: 'p', title: '年に一度旅をする', updated_at: date };
const means = { id: 'm', kind: 'means', parent_id: 'g', title: '行きたい場所を集める', updated_at: date };
const board = { id: 'vision-main', title: 'わたしの未来', width: 1200, height: 1600, background: 'cork' };
const image = { id: 'i', board_id: 'vision-main', attachment_id: 'same-binary', mime: 'image/jpeg', name: '写真.jpg', goal_id: 'g', caption: '海のそばで過ごす', x: 120, y: 80, width: 280, height: 220, rotation: -7 };

function fixture(initial = {}) {
  const values = new Map(Object.entries(initial));
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  const revisions = new Map(), pending = new Set(), operations = [];
  const syncClient = {
    revision: (key) => revisions.get(key) || 0,
    pendingKeys: async () => new Set(pending),
    flushAll: async () => 0,
    queue(op, delay) {
      operations.push({ op, delay });
      const key = keyOf(op);
      revisions.set(key, (revisions.get(key) || 0) + 1);
      return Promise.resolve();
    },
  };
  const api = { pullGoals: async () => goalSnapshot() };
  const repo = createGoalsRepository({ storage, syncClient, api, now: () => date });
  return { values, storage, revisions, pending, operations, syncClient, api, repo };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('purpose, goal and means enforce the accepted hierarchy and reject cycles', () => {
  assert.equal(validateNode(goal, [purpose]).parent_id, 'p');
  assert.equal(validateNode(means, [purpose, goal]).parent_id, 'g');
  assert.throws(() => validateNode({ ...goal, parent_id: '' }, [purpose]), /目的/);
  assert.throws(() => validateNode({ ...means, parent_id: 'p' }, [purpose, goal]), /目標/);
  assert.throws(() => validateNode({ ...purpose, parent_id: 'g' }, [goal]), /親/);
  assert.throws(() => validateNode(goal, [{ ...purpose, parent_id: 'g' }]), /循環/);
});

test('deleting a parent rejects live children without cascading to goals or images', () => {
  assert.throws(() => validateNode({ ...purpose, deleted: 1 }, [purpose, goal, means]), /先に/);
  assert.throws(() => validateNode({ ...goal, deleted: 1 }, [purpose, goal, means]), /先に/);
  const deleted = validateNode({ ...goal, deleted: 1 }, [purpose, goal, { ...means, deleted: 1 }], [image]);
  assert.equal(deleted.deleted, 1);
  assert.equal(image.attachment_id, 'same-binary');
  assert.equal(image.goal_id, 'g');
  assert.equal(isDeleted({ deleted: '0' }), false);
});

test('a goal cover references a live image of that same goal', () => {
  assert.equal(validateNode({ ...goal, cover_item_id: 'i' }, [purpose, goal], [image]).cover_item_id, 'i');
  assert.throws(() => validateNode({ ...goal, cover_item_id: 'i' }, [purpose, goal], [{ ...image, goal_id: 'other' }]), /表紙/);
  assert.throws(() => validateNode({ ...goal, cover_item_id: 'i' }, [purpose, goal], [{ ...image, deleted: 1 }]), /表紙/);
});

test('board images validate finite geometry and retain independent references to a shared image', () => {
  const saved = normalizeItem(image, [purpose, goal], [board]);
  assert.equal(saved.rotation, -7);
  const second = normalizeItem({ ...image, id: 'i2', x: 500 }, [purpose, goal], [board]);
  assert.equal(second.attachment_id, saved.attachment_id);
  assert.throws(() => normalizeItem({ ...image, x: Infinity }, [goal], [board]), /横位置/);
  assert.throws(() => normalizeItem({ ...image, rotation: 181 }, [goal], [board]), /角度/);
  assert.throws(() => normalizeItem(image, [goal], []), /ボード/);
});

test('remote omissions retain local records, pending changes and unknown fields', () => {
  const local = { future_cache: { keep: true }, nodes: [purpose, { ...goal, future_field: 0 }], boards: [board], items: [image] };
  const merged = mergeGoalSnapshot(local, { nodes: [{ ...goal, title: 'newer', updated_at: '2026-11-24 12:01' }], boards: [], items: [] });
  assert.deepEqual(merged.future_cache, { keep: true });
  assert.equal(merged.nodes.length, 2);
  assert.equal(merged.nodes.find((n) => n.id === 'g').future_field, 0);
  assert.equal(merged.boards.length, 1);
  assert.equal(merged.items[0].attachment_id, 'same-binary');
  const protectedSnapshot = mergeGoalSnapshot(local, { nodes: [{ ...goal, deleted: 1 }], boards: [], items: [] }, { pending: new Set(['goal_node:g']) });
  assert.deepEqual(protectedSnapshot.nodes.find((n) => n.id === 'g'), local.nodes[1]);
});

test('only sufficiently recent explicit tombstones hide records, without removing image references', () => {
  const local = goalSnapshot({ nodes: [purpose, goal], items: [image] });
  const old = mergeGoalSnapshot(local, { nodes: [{ ...goal, deleted: 1, updated_at: '2026-11-23 12:00' }] });
  assert.equal(isDeleted(old.nodes.find((n) => n.id === 'g')), false);
  const merged = mergeGoalSnapshot(local, { nodes: [{ ...goal, deleted: 1, updated_at: '2026-11-24 12:01' }] });
  assert.equal(isDeleted(merged.nodes.find((n) => n.id === 'g')), true);
  assert.deepEqual(merged.items, [image]);
});

test('save writes only the new cache synchronously and resolves after durable enqueue', async () => {
  const f = fixture({ sth_v3_cache_schema: '4', sth_v3_tasks_cache: ' untouched bytes ', sth_v3_memo_all: '[{"id":"old"}]' });
  const persisted = deferred();
  f.syncClient.queue = (op, delay) => {
    f.operations.push({ op, delay });
    return persisted.promise;
  };
  let complete = false;
  const save = f.repo.saveNode({ ...purpose, future_field: { keep: 0 } }).then((n) => { complete = true; return n; });
  assert.equal(f.repo.loadGoals().nodes[0].title, purpose.title);
  await Promise.resolve();
  assert.equal(complete, false);
  assert.equal(f.operations[0].delay, 300);
  assert.equal(f.operations[0].op.type, 'goal_node_upsert');
  persisted.resolve();
  assert.equal((await save).future_field.keep, 0);
  assert.equal(f.values.get('sth_v3_cache_schema'), '4');
  assert.equal(f.values.get('sth_v3_tasks_cache'), ' untouched bytes ');
  assert.equal(f.values.get('sth_v3_memo_all'), '[{"id":"old"}]');
});

test('independent lists, board item and card cover share one record and preserve metadata through partial edits', async () => {
  const f = fixture();
  assert.deepEqual(f.repo.defaultBoard(), boardWithDeleted());
  assert.equal(f.values.has(CACHE_KEY), false, 'merely viewing the default board never writes');
  await f.repo.saveNode({ ...purpose, future_field: false });
  await f.repo.saveNode(goal);
  await f.repo.saveNode(means);
  await f.repo.saveBoard(f.repo.defaultBoard());
  await f.repo.saveItem({ ...image, future_metadata: { original: true } });
  await f.repo.saveNode({ id: 'g', cover_item_id: 'i' });
  const created = f.repo.loadGoals().nodes.find((n) => n.id === 'g').created_at;
  await f.repo.saveNode({ id: 'g', title: '旅を楽しむ' });
  await f.repo.saveItem({ id: 'i', caption: '新しい説明', rotation: 12 });
  const data = f.repo.loadGoals();
  assert.equal(data.nodes.filter((n) => n.kind === 'purpose').length, 1);
  assert.equal(data.nodes.filter((n) => n.kind === 'goal').length, 1);
  const card = data.nodes.find((n) => n.id === 'g');
  assert.equal(card.cover_item_id, data.items[0].id);
  assert.equal(card.parent_id, 'p');
  assert.equal(card.created_at, created);
  assert.equal(data.items[0].attachment_id, 'same-binary');
  assert.equal(data.items[0].rotation, 12);
  assert.deepEqual(data.items[0].future_metadata, { original: true });
  assert.equal(data.nodes[0].future_field, false);
});

function boardWithDeleted() { return { ...board, deleted: 0 }; }

test('a delayed pull cannot overwrite an edit even after its pending queue has cleared', async () => {
  const f = fixture();
  await f.repo.saveNode(purpose);
  await f.repo.saveNode(goal);
  const response = deferred(), requested = deferred();
  f.api.pullGoals = () => { requested.resolve(); return response.promise; };
  const pull = f.repo.pullGoals();
  await requested.promise;
  await f.repo.saveNode({ id: 'g', title: '最新の入力' });
  assert.equal(f.pending.size, 0, 'the operation can already be sent');
  response.resolve(goalSnapshot({ nodes: [purpose, { ...goal, title: '古い応答' }] }));
  await pull;
  assert.equal(f.repo.loadGoals().nodes.find((n) => n.id === 'g').title, '最新の入力');
});

test('a later pull wins over an older request returning last at the same timestamp', async () => {
  const f = fixture();
  await f.repo.saveNode(purpose);
  await f.repo.saveNode(goal);
  const responses = [deferred(), deferred()];
  const requests = [deferred(), deferred()];
  let index = 0;
  f.api.pullGoals = () => { const i = index++; requests[i].resolve(); return responses[i].promise; };
  const first = f.repo.pullGoals(); await requests[0].promise;
  const second = f.repo.pullGoals(); await requests[1].promise;
  responses[1].resolve(goalSnapshot({ nodes: [{ ...goal, title: '新しい取得' }] })); await second;
  responses[0].resolve(goalSnapshot({ nodes: [{ ...goal, title: '古い取得' }] })); await first;
  assert.equal(f.repo.loadGoals().nodes.find((n) => n.id === 'g').title, '新しい取得');
});

test('offline or unsupported pulls leave raw cache bytes unchanged', async () => {
  const raw = ' { "nodes": [], "boards": [], "items": [], "future": 0 } ';
  const f = fixture({ [CACHE_KEY]: raw });
  f.api.pullGoals = async () => { throw new Error('offline'); };
  await assert.rejects(f.repo.pullGoals(), /offline/);
  assert.equal(f.values.get(CACHE_KEY), raw);
  f.api.pullGoals = async () => ({});
  await assert.rejects(f.repo.pullGoals(), /取得結果/);
  assert.equal(f.values.get(CACHE_KEY), raw);
});

test('corrupt cache is not reset or overwritten, and persisted pending records survive a new repository', async () => {
  const corrupt = fixture({ [CACHE_KEY]: '{broken JSON' });
  assert.throws(() => corrupt.repo.loadGoals(), /データを消さず/);
  assert.throws(() => corrupt.repo.saveNode(purpose), /データを消さず/);
  assert.equal(corrupt.values.get(CACHE_KEY), '{broken JSON');
  const f = fixture({ [CACHE_KEY]: JSON.stringify(goalSnapshot({ nodes: [purpose, goal] })) });
  f.pending.add('goal_node:g');
  f.api.pullGoals = async () => goalSnapshot({ nodes: [{ ...goal, title: 'remote', deleted: 1 }] });
  const reopened = createGoalsRepository({ storage: f.storage, syncClient: f.syncClient, api: f.api, now: () => date });
  await reopened.pullGoals();
  assert.equal(reopened.loadGoals().nodes.find((n) => n.id === 'g').title, goal.title);
});


test('frontend contracts reject payloads the goal API cannot persist', async () => {
  assert.throws(() => validateNode({ ...purpose, id: '日本語ID' }), /ID/);
  assert.throws(() => validateNode({ ...purpose, title: 'x'.repeat(501) }), /長すぎ/);
  assert.throws(() => validateNode({ ...purpose, description: 'x'.repeat(20001) }), /長すぎ/);
  assert.throws(() => validateNode({ ...goal, kind: 'purpose', parent_id: '' }, [purpose, goal]), /種類は変更/);
  const f = fixture();
  assert.throws(() => f.repo.saveNode({ ...purpose, future_data: 'x'.repeat(40000) }), /大きすぎ/);
  assert.equal(f.values.has(CACHE_KEY), false);
});

function row(id, type, payload) { return { id, enqueued_at: id * 100, op: { type, payload } }; }
function dependencyQueue() {
  return [
    row(1, 'goal_node_upsert', purpose),
    row(2, 'goal_node_upsert', goal),
    row(3, 'goal_board_upsert', board),
    row(4, 'goal_item_upsert', image),
    row(5, 'goal_node_upsert', { ...goal, cover_item_id: 'i' }),
  ];
}

function dependencyServer() {
  const nodes = new Map(), boards = new Map(), items = new Map(), calls = [];
  async function sendOperation(op) {
    const p = op.payload;
    calls.push(op.type + ':' + p.id + (p.cover_item_id ? ':cover' : ''));
    if (op.type === 'goal_node_upsert') {
      if (p.parent_id && !nodes.has(p.parent_id)) throw new Error('parent missing');
      if (p.cover_item_id && !items.has(p.cover_item_id)) throw new Error('cover missing');
      nodes.set(p.id, structuredClone(p));
    } else if (op.type === 'goal_board_upsert') boards.set(p.id, structuredClone(p));
    else if (op.type === 'goal_item_upsert') {
      if (!boards.has(p.board_id) || p.goal_id && !nodes.has(p.goal_id)) throw new Error('image dependency missing');
      items.set(p.id, structuredClone(p));
    }
  }
  return { nodes, boards, items, calls, sendOperation };
}

test('dependent goal creation, item creation and cover update replay in exact original queue order', async () => {
  const rows = dependencyQueue();
  const pending = new Map(rows.map((entry) => [entry.id, structuredClone(entry)]));
  const server = dependencyServer();
  const failed = await flushGoalOperations([...rows].reverse(), {
    sendOperation: server.sendOperation,
    removeOperation: async (id) => pending.delete(id),
  });
  assert.equal(failed, 0);
  assert.deepEqual(server.calls, ['goal_node_upsert:p', 'goal_node_upsert:g', 'goal_board_upsert:vision-main', 'goal_item_upsert:i', 'goal_node_upsert:g:cover']);
  assert.equal(server.nodes.get('g').cover_item_id, 'i');
  assert.equal(server.items.get('i').attachment_id, 'same-binary');
  assert.equal(pending.size, 0);
});

test('failed dependent rows retain original identities and retry successfully in order', async () => {
  const rows = dependencyQueue();
  const pending = new Map(rows.map((entry) => [entry.id, structuredClone(entry)]));
  const server = dependencyServer();
  let failParent = true;
  const sendOperation = async (op) => {
    if (failParent && op.type === 'goal_node_upsert' && op.payload.id === 'p') throw new Error('synthetic offline');
    return server.sendOperation(op);
  };
  const options = { sendOperation, removeOperation: async (id) => pending.delete(id) };
  assert.equal(await flushGoalOperations(rows, options), 3, 'purpose, goal and item remain pending; independent board succeeds');
  assert.deepEqual([...pending.values()], rows.filter((entry) => entry.id !== 3));
  failParent = false;
  assert.equal(await flushGoalOperations([...pending.values()], options), 0);
  assert.equal(server.nodes.get('g').cover_item_id, 'i');
  assert.equal(pending.size, 0);
});

test('a newer successful goal operation removes obsolete earlier failures without rolling back newer in-flight edits', async () => {
  const rows = [row(1, 'goal_node_upsert', { ...purpose, title: 'old' }), row(2, 'goal_node_upsert', { ...purpose, title: 'new' })];
  const pending = new Map(rows.map((entry) => [entry.id, structuredClone(entry)]));
  const inFlight = deferred(), started = deferred();
  const sent = [];
  const task = flushGoalOperations(rows, {
    async sendOperation(op) {
      sent.push(op.payload.title);
      if (op.payload.title === 'old') throw new Error('synthetic failure');
      started.resolve(); await inFlight.promise;
    },
    removeOperation: async (id) => pending.delete(id),
  });
  await started.promise;
  const latest = row(3, 'goal_node_upsert', { ...purpose, title: 'latest' });
  pending.set(latest.id, latest);
  inFlight.resolve();
  assert.equal(await task, 0);
  assert.deepEqual([...pending.values()], [latest]);
  assert.deepEqual(sent, ['old', 'new']);
  await flushGoalOperations([...pending.values()], {
    sendOperation: async (op) => sent.push(op.payload.title),
    removeOperation: async (id) => pending.delete(id),
  });
  assert.deepEqual(sent, ['old', 'new', 'latest']);
  assert.equal(pending.size, 0);
});

test('goal replay never handles an existing task or an unknown operation', async () => {
  const rows = [row(1, 'task_upsert', { id: 'old-task' }), row(2, 'future_unknown', { id: 'unknown' })];
  const sent = [], removed = [];
  assert.equal(await flushGoalOperations(rows, {
    sendOperation: async (op) => sent.push(op), removeOperation: async (id) => removed.push(id),
  }), 0);
  assert.deepEqual(sent, []);
  assert.deepEqual(removed, []);
});
