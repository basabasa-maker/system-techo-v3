// sync.js - 未送信キュー（outbox）の共通の送信処理
// - 同じ対象（同じタスク・同じ日など）の古い送信待ちは捨て、最新の1件だけ送る
//   （古い失敗分が、後から成功した新しい編集を上書きして戻すのを防ぐ）
// - 1件の失敗で、ほかの送信を止めない（失敗分だけ残して次へ進む）
// - 送信待ちの対象を調べ、取得結果が未送信の変更を消さないようにする

import * as gas from "./gas-client.js";
import * as outbox from "./outbox.js";

// 送信待ちの対象を表すキー
function keyOf(op) {
  const p = op.payload || {};
  switch (op.type) {
    case "task_upsert":
      return "task:" + p.id;
    case "task_delete":
      return "task:" + p.id;
    case "memo_upsert":
      return "memo:" + p.id;
    case "memo_delete":
      return "memo:" + p.id;
    case "habit_day_upsert":
      return "habit_day:" + p.date;
    case "habit_items_upsert":
      return "habit_items";
    case "meal_day_upsert":
      return "meal:" + p.date;
    default:
      return null;
  }
}

// 習慣の「変えた項目」の形にそろえる（旧形式の values は追加・更新のみ扱い）
function toPatch(p) {
  return { set: p.set || p.values || {}, del: p.del || [] };
}

// 食事の「変えた区分」の形にそろえる（旧形式の slots も、入っている区分を追加・更新として扱う）
function mealSet(p) {
  return p.set || p.slots || {};
}

// 2つの変更を1つにまとめる（あとの変更が勝つ）
export function mergePatch(a, b) {
  const set = { ...a.set };
  let del = new Set(a.del);
  for (const k of b.del) {
    delete set[k];
    del.add(k);
  }
  for (const k of Object.keys(b.set)) {
    set[k] = b.set[k];
    del.delete(k);
  }
  return { set, del: [...del] };
}

async function send(op) {
  const p = op.payload || {};
  switch (op.type) {
    case "task_upsert":
      return gas.pushTaskUpsert(p);
    case "task_delete":
      return gas.pushTaskDelete(p.id);
    case "memo_upsert":
      return gas.pushMemoUpsert(p);
    case "memo_delete":
      return gas.pushMemoDelete(p.id);
    case "habit_day_upsert":
      return gas.pushHabitDay(p.date, toPatch(p));
    case "habit_items_upsert":
      return gas.pushHabitItems(p.items);
    case "meal_day_upsert":
      return gas.pushMealDay(p.date, mealSet(p));
    default:
      return null;
  }
}

// 取得開始後に編集された対象は、送信済みでも古い取得結果を適用しない。
const revisions = new Map();
const staging = new Map();
const sendTimers = new Map();
export function revision(key) { return revisions.get(key) || 0; }
export function queue(op, delayMs = 0) {
  const key = keyOf(op);
  revisions.set(key, revision(key) + 1);
  staging.set(key, (staging.get(key) || 0) + 1);
  return outbox.enqueue(op).then(() => {
    staging.set(key, staging.get(key) - 1);
    if (delayMs > 0) {
      clearTimeout(sendTimers.get(key));
      sendTimers.set(key, setTimeout(() => {
        sendTimers.delete(key);
        flushAll().catch((e) => console.error("queued sync failed", e));
      }, delayMs));
      return;
    }
    return flushAll();
  }, (error) => {
    // 永続化に失敗した場合も取得で手元の値を消さない。
    throw error;
  });
}

let running = null;
let again = false;

// すべての送信待ちを送る。送れなかった件数を返す。
// 送っている最中に新しい送信待ちが入ったときは、終わったあとにもう一度送る
export function flushAll() {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    let failed = 0;
    do {
      again = false;
      failed = await flushOnce();
    } while (again);
    return failed;
  })().finally(() => {
    running = null;
  });
  return running;
}

async function flushOnce() {
  {
    const items = (await outbox.listAll()).sort((a, b) => a.id - b.id);
    // 同じ対象は、いちばん新しい1件だけ残す。習慣の日だけは、変えた項目を1つにまとめる
    const groups = new Map();
    for (const it of items) {
      const k = keyOf(it.op);
      if (!k) continue; // 知らない種類は触らない
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    let failed = 0;
    for (const [k, list] of groups) {
      let op = list[list.length - 1].op;
      if (op.type === "meal_day_upsert") {
        let set = {};
        for (const it of list) set = { ...set, ...mealSet(it.op.payload || {}) };
        op = { type: op.type, payload: { date: op.payload.date, set } };
      } else if (op.type === "habit_day_upsert") {
        let merged = { set: {}, del: [] };
        for (const it of list) merged = mergePatch(merged, toPatch(it.op.payload || {}));
        op = { type: op.type, payload: { date: op.payload.date, set: merged.set, del: merged.del } };
      }
      try {
        await send(op);
        for (const it of list) await outbox.remove(it.id);
      } catch (e) {
        failed++;
        // 送れなかった習慣の変更は、まとめた1件にして残す
        if ((op.type === "habit_day_upsert" || op.type === "meal_day_upsert") && list.length > 1) {
          await outbox.replace(list[list.length - 1].id, op);
          for (const it of list.slice(0, -1)) await outbox.remove(it.id);
        } else {
          for (const it of list.slice(0, -1)) await outbox.remove(it.id);
        }
      }
    }
    return failed;
  }
}

// いま送信待ちの対象キーの集まり
export async function pendingKeys() {
  const items = await outbox.listAll();
  const set = new Set([...staging].filter(([, n]) => n > 0).map(([key]) => key));
  for (const it of items) {
    const k = keyOf(it.op);
    if (k) set.add(k);
  }
  return set;
}

// 更新の完了メッセージに添える、未送信の件数の言い方
export async function pendingNote() {
  const n = (await pendingKeys()).size;
  return n > 0 ? `（未送信${n}件）` : "";
}
